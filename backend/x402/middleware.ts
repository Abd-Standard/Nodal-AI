/**
 * backend/x402/middleware.ts
 * OpenAPI discovery document for paid endpoints (Issue #781).
 *
 * Agents need to know what a paid API costs before calling it. A seller lists
 * its paid routes once; this module turns that route config into an OpenAPI
 * 3.1 document served at `/.well-known/openapi.json`, where every paid
 * operation carries an `x-payment-info` extension with its price, asset and
 * network, and declares the `402 Payment Required` response.
 *
 * The extension follows the shape registries and `mppx discover validate`
 * expect: `x-payment-info: { offers: [{ amount, currency, intent, method, ... }] }`
 * with `amount` in base units (stroops). The human-readable decimal `price`,
 * the `asset`, the CAIP-2 `network` and `payTo` ride along as extra offer
 * fields.
 *
 * The document is advisory: the 402 challenge a paid route returns remains
 * authoritative for the terms actually charged.
 */

import type { IncomingMessage, ServerResponse } from 'http';
import { z } from 'zod';
import { config } from '../config';
import { stellarPublicKeySchema } from '../utils/stellarSchemas';

/** Where the discovery document is served. */
export const OPENAPI_DISCOVERY_PATH = '/.well-known/openapi.json';

const STROOPS_PER_UNIT = 10_000_000n;

const PaidRouteSchema = z
  .object({
    method: z.enum(['get', 'post', 'put', 'patch', 'delete']),
    path: z.string().startsWith('/', 'path must start with "/"'),
    /** Price per request as a Stellar decimal, e.g. "0.01". */
    price: z
      .string()
      .regex(/^(?!0(\.0+)?$)\d+(\.\d{1,7})?$/, 'price must be a positive Stellar decimal'),
    assetCode: z.string().min(1).max(12).default(config.X402_ASSET_CODE),
    assetIssuer: z.string().optional(),
    payTo: stellarPublicKeySchema('payTo'),
    summary: z.string().optional(),
    description: z.string().optional(),
  })
  .transform((route) => ({
    ...route,
    // A non-native asset without an explicit issuer is the configured x402 asset's.
    assetIssuer:
      route.assetCode === 'XLM' ? undefined : (route.assetIssuer ?? config.X402_ASSET_ISSUER),
  }));

/** A paid route as configured by the seller. */
export type PaidRouteConfig = z.input<typeof PaidRouteSchema>;

export interface DiscoveryOptions {
  /** API title for the document's `info` block. */
  title: string;
  version?: string;
  routes: PaidRouteConfig[];
}

/** One way to pay for an operation, as published in `x-payment-info.offers`. */
export interface PaymentOffer {
  /** Price in base units (stroops), as a decimal integer string. */
  amount: string;
  /** `XLM` or `CODE:ISSUER`. */
  currency: string;
  method: 'stellar';
  intent: 'charge';
  protocol: 'x402';
  /** Price as a Stellar decimal, e.g. `"0.0100000"`. */
  price: string;
  asset: { code: string; issuer?: string };
  /** CAIP-2 network, e.g. `stellar:testnet`. */
  network: string;
  payTo: string;
  description?: string;
}

export interface OpenApiDocument {
  openapi: '3.1.0';
  info: { title: string; version: string };
  paths: Record<string, Record<string, OpenApiOperation>>;
}

interface OpenApiOperation {
  summary?: string;
  responses: Record<string, { description: string }>;
  'x-payment-info': { offers: PaymentOffer[] };
}

/** CAIP-2 identifier for a configured Stellar network. */
export function caip2Network(network: string): string {
  return network === 'mainnet' ? 'stellar:pubnet' : `stellar:${network}`;
}

function toStroops(decimal: string): string {
  const [whole = '0', fraction = ''] = decimal.split('.');
  return (BigInt(whole) * STROOPS_PER_UNIT + BigInt(fraction.padEnd(7, '0'))).toString();
}

function fromStroops(stroops: string): string {
  const value = BigInt(stroops);
  return `${value / STROOPS_PER_UNIT}.${(value % STROOPS_PER_UNIT).toString().padStart(7, '0')}`;
}

/**
 * Build the OpenAPI discovery document from the seller's route config.
 *
 * @throws {z.ZodError} If a route has an invalid method, path, price, or payTo.
 */
export function buildOpenApiDocument(options: DiscoveryOptions): OpenApiDocument {
  const network = caip2Network(config.STELLAR_NETWORK);
  const paths: OpenApiDocument['paths'] = {};

  for (const raw of options.routes) {
    const route = PaidRouteSchema.parse(raw);
    const amount = toStroops(route.price);
    const offer: PaymentOffer = {
      amount,
      currency: route.assetIssuer ? `${route.assetCode}:${route.assetIssuer}` : route.assetCode,
      method: 'stellar',
      intent: 'charge',
      protocol: 'x402',
      price: fromStroops(amount),
      asset: route.assetIssuer
        ? { code: route.assetCode, issuer: route.assetIssuer }
        : { code: route.assetCode },
      network,
      payTo: route.payTo,
      ...(route.description !== undefined && { description: route.description }),
    };

    paths[route.path] ??= {};
    paths[route.path]![route.method] = {
      ...(route.summary !== undefined && { summary: route.summary }),
      responses: {
        '200': { description: 'Successful response' },
        '402': { description: 'Payment Required' },
      },
      'x-payment-info': { offers: [offer] },
    };
  }

  return {
    openapi: '3.1.0',
    info: { title: options.title, version: options.version ?? '1.0.0' },
    paths,
  };
}

/**
 * Seller middleware serving the discovery document at
 * {@link OPENAPI_DISCOVERY_PATH}. Works with Express or a plain `http`
 * server; every other request is passed to `next`.
 *
 * The document is generated once, so an invalid route config fails at
 * startup rather than on the first discovery request.
 */
export function x402DiscoveryMiddleware(options: DiscoveryOptions) {
  const body = JSON.stringify(buildOpenApiDocument(options));

  return (req: IncomingMessage, res: ServerResponse, next: () => void): void => {
    const path = (req.url ?? '').split('?')[0];
    if (path !== OPENAPI_DISCOVERY_PATH || (req.method !== 'GET' && req.method !== 'HEAD')) {
      next();
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=300',
    });
    res.end(req.method === 'HEAD' ? undefined : body);
  };
}

// ─── Buyer side ──────────────────────────────────────────────────────────────

/** The payment offers a discovery document publishes for one operation, if any. */
export function readPaymentOffers(
  doc: OpenApiDocument,
  method: string,
  path: string
): PaymentOffer[] | undefined {
  return doc.paths?.[path]?.[method.toLowerCase()]?.['x-payment-info']?.offers;
}

/**
 * Fetch a seller's discovery document and return what an operation costs,
 * without calling (or paying for) the operation itself.
 */
export async function discoverPaymentOffers(
  baseUrl: string,
  method: string,
  path: string
): Promise<PaymentOffer[] | undefined> {
  const res = await fetch(new URL(OPENAPI_DISCOVERY_PATH, baseUrl));
  if (!res.ok) {
    throw new Error(`Discovery document request failed with HTTP ${res.status}`);
  }
  return readPaymentOffers((await res.json()) as OpenApiDocument, method, path);
}
