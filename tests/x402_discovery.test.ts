/**
 * tests/x402_discovery.test.ts
 * OpenAPI discovery document for paid endpoints (#781): generated from route
 * config, served at /.well-known/openapi.json, and readable by a buyer before
 * paying.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import * as http from 'http';
import type { AddressInfo } from 'net';
import {
  buildOpenApiDocument,
  discoverPaymentOffers,
  OPENAPI_DISCOVERY_PATH,
  readPaymentOffers,
  x402DiscoveryMiddleware,
  type DiscoveryOptions,
} from '../backend/x402/middleware';

vi.mock('../backend/config', () => ({
  config: {
    STELLAR_NETWORK: 'testnet',
    X402_ASSET_CODE: 'USDC',
    X402_ASSET_ISSUER: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
  },
}));

const PAY_TO = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
const USDC_ISSUER = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';

const options: DiscoveryOptions = {
  title: 'Paid Data API',
  routes: [
    { method: 'get', path: '/data', price: '0.01', payTo: PAY_TO, summary: 'Market data' },
    { method: 'post', path: '/report', price: '2', assetCode: 'XLM', payTo: PAY_TO },
  ],
};

describe('buildOpenApiDocument', () => {
  it('generates an OpenAPI 3.1 operation with x-payment-info per paid route', () => {
    const doc = buildOpenApiDocument(options);

    expect(doc.openapi).toBe('3.1.0');
    expect(doc.info).toEqual({ title: 'Paid Data API', version: '1.0.0' });

    const data = doc.paths['/data']!['get']!;
    expect(data.summary).toBe('Market data');
    expect(data.responses['402']).toBeDefined();
    expect(data['x-payment-info'].offers).toEqual([
      {
        amount: '100000',
        currency: `USDC:${USDC_ISSUER}`,
        method: 'stellar',
        intent: 'charge',
        protocol: 'x402',
        price: '0.0100000',
        asset: { code: 'USDC', issuer: USDC_ISSUER },
        network: 'stellar:testnet',
        payTo: PAY_TO,
      },
    ]);

    const report = doc.paths['/report']!['post']!['x-payment-info'].offers[0]!;
    expect(report).toMatchObject({
      amount: '20000000',
      currency: 'XLM',
      price: '2.0000000',
      asset: { code: 'XLM' },
    });
  });

  it.each([
    [{ price: '0' }, /price/],
    [{ price: '1.12345678' }, /price/],
    [{ path: 'data' }, /path/],
    [{ payTo: 'GBAD' }, /payTo/],
  ])('rejects an invalid route config %o', (override, message) => {
    expect(() =>
      buildOpenApiDocument({
        title: 'x',
        routes: [{ method: 'get', path: '/data', price: '1', payTo: PAY_TO, ...override }],
      })
    ).toThrow(message);
  });
});

describe('x402DiscoveryMiddleware', () => {
  let server: http.Server | undefined;
  let paidRouteHits = 0;

  afterEach(async () => {
    paidRouteHits = 0;
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  });

  /** A seller: discovery middleware in front of a paid route that always answers 402. */
  async function startSeller(): Promise<string> {
    const discovery = x402DiscoveryMiddleware(options);
    server = http.createServer((req, res) => {
      discovery(req, res, () => {
        if (req.url === '/data') paidRouteHits++;
        res.writeHead(402, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'payment required' }));
      });
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', () => resolve()));
    return `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
  }

  it(`serves the document at ${OPENAPI_DISCOVERY_PATH}`, async () => {
    const baseUrl = await startSeller();
    const res = await fetch(`${baseUrl}${OPENAPI_DISCOVERY_PATH}`);

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/json');
    expect(await res.json()).toEqual(buildOpenApiDocument(options));
  });

  it('passes every other request through', async () => {
    const baseUrl = await startSeller();
    expect((await fetch(`${baseUrl}/data`)).status).toBe(402);
    expect((await fetch(`${baseUrl}${OPENAPI_DISCOVERY_PATH}`, { method: 'POST' })).status).toBe(
      402
    );
  });

  it('lets a buyer read the price before paying', async () => {
    const baseUrl = await startSeller();

    const offers = await discoverPaymentOffers(baseUrl, 'GET', '/data');

    expect(offers?.[0]).toMatchObject({
      price: '0.0100000',
      asset: { code: 'USDC', issuer: USDC_ISSUER },
      network: 'stellar:testnet',
      payTo: PAY_TO,
    });
    // The buyer learned the price without calling (or paying for) the route.
    expect(paidRouteHits).toBe(0);
  });

  it('returns undefined for an operation that is not a paid route', () => {
    const doc = buildOpenApiDocument(options);
    expect(readPaymentOffers(doc, 'GET', '/free')).toBeUndefined();
    expect(readPaymentOffers(doc, 'POST', '/data')).toBeUndefined();
  });
});
