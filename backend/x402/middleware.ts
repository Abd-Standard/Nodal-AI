/**
 * backend/x402/middleware.ts
 *
 * Two related facilities for Nodal API sellers:
 *
 * ## 1. `nodalPaywall(options)` — Express payment-gating middleware
 *
 * Wraps `paymentMiddlewareFromConfig` from `@x402/express` to provide a
 * single, ergonomic entry point that follows the official x402 v2 spec:
 *
 * ```typescript
 * import { nodalPaywall } from './backend/x402/middleware';
 *
 * app.get(
 *   '/data',
 *   nodalPaywall({ price: '0.01', asset: 'USDC' }),
 *   handler,
 * );
 * ```
 *
 * On an unpaid request the middleware returns 402 with a spec-compliant
 * `PAYMENT-REQUIRED` header.  A compliant client (e.g. the agent's `fetchPaid`
 * or any @x402/fetch consumer) signs the SAC auth entry, retries with the
 * `PAYMENT` header, and the facilitator verifies + settles on-chain before the
 * request reaches `handler`.
 *
 * The facilitator URL and API key default to `config.X402_FACILITATOR_URL` and
 * `config.X402_FACILITATOR_API_KEY` but can be overridden per-middleware.
 *
 * ## 2. OpenAPI discovery document
 *
 * `x402DiscoveryMiddleware(options)` serves `/.well-known/openapi.json` so
 * agents can read prices before calling paid routes.  `discoverPaymentOffers`
 * is the buyer-side helper that fetches and parses that document.
 */

import type { Request, Response, NextFunction } from 'express';
import type { IncomingMessage, ServerResponse } from 'http';
import { z } from 'zod';
import {
  paymentMiddlewareFromConfig,
  type SchemeRegistration,
} from '@x402/express';
import { HTTPFacilitatorClient } from '@x402/core/server';
import { ExactStellarScheme } from '@x402/stellar/exact/server';
import { config } from '../config';
import { toCaip2 } from '../network';
import { createLogger } from '../utils/logger';
import { stellarPublicKeySchema } from '../utils/stellarSchemas';

const log = createLogger('x402-middleware');

// ─── nodalPaywall ─────────────────────────────────────────────────────────────

/**
 * Options for {@link nodalPaywall}.
 *
 * @example
 * ```typescript
 * // Minimal — uses config.X402_ASSET_CODE and config.X402_ASSET_ISSUER
 * nodalPaywall({ price: '0.01', payTo: 'G...' })
 *
 * // Explicit asset
 * nodalPaywall({ price: '0.05', asset: 'USDC', payTo: 'G...' })
 *
 * // Override facilitator per-endpoint
 * nodalPaywall({
 *   price: '0.01',
 *   payTo: 'G...',
 *   facilitatorUrl: 'https://facilitator.openzeppelin.com',
 *   facilitatorApiKey: process.env.OZ_API_KEY,
 * })
 * ```
 */
export interface NodalPaywallOptions {
  /**
   * Price per request as a human-readable decimal, e.g. `"0.01"` for one cent
   * of USDC.  The server scheme converts this to the SAC token amount using
   * the asset's decimal precision (7 for USDC).
   */
  price: string;
  /**
   * Asset code to charge in — e.g. `"USDC"`.
   * Defaults to `config.X402_ASSET_CODE`.
   */
  asset?: string;
  /**
   * G-address of the account that should receive payments.
   * Defaults to `config.AGENT_PUBLIC_KEY` (the agent's own account).
   *
   * Override when the resource server is not the same process as the agent,
   * or when routing funds to a dedicated collection account.
   */
  payTo?: string;
  /**
   * x402 facilitator URL.  Defaults to `config.X402_FACILITATOR_URL`.
   * Use `"https://x402.org/facilitator"` for the Coinbase testnet facilitator,
   * or `"https://facilitator.openzeppelin.com"` for the OpenZeppelin Relayer
   * plugin.
   */
  facilitatorUrl?: string;
  /**
   * API key for the facilitator.  Defaults to `config.X402_FACILITATOR_API_KEY`.
   * Sent as `Authorization: Bearer <key>` on every facilitator request.
   */
  facilitatorApiKey?: string;
  /** Optional human-readable description of what the payment unlocks. */
  description?: string;
}

const PaywallOptionsSchema = z.object({
  price: z
    .string()
    .regex(/^(?!0(\.0+)?$)\d+(\.\d{1,7})?$/, 'price must be a positive Stellar decimal'),
  asset: z.string().min(1).max(12).optional(),
  payTo: stellarPublicKeySchema('payTo').optional(),
  facilitatorUrl: z.string().url().optional(),
  facilitatorApiKey: z.string().min(1).optional(),
  description: z.string().optional(),
});

/**
 * Create Express payment-gating middleware for a single route.
 *
 * Mount it before your route handler.  Every request without a valid
 * `PAYMENT` header receives a 402 with a spec-compliant `PAYMENT-REQUIRED`
 * header; a paid retry is verified and settled by the facilitator before
 * reaching your handler.
 *
 * The middleware is stateless and safe to reuse across route registrations.
 *
 * @throws {z.ZodError} if `options.price` is not a positive Stellar decimal.
 * @throws {Error} if neither `options.facilitatorUrl` nor
 *   `config.X402_FACILITATOR_URL` is set (a facilitator is required for the
 *   seller to settle payments on-chain).
 */
export function nodalPaywall(
  options: NodalPaywallOptions
): (req: Request, res: Response, next: NextFunction) => Promise<void> {
  const opts = PaywallOptionsSchema.parse(options);

  const facilitatorUrl = opts.facilitatorUrl ?? config.X402_FACILITATOR_URL;
  if (!facilitatorUrl) {
    throw new Error(
      'nodalPaywall: a facilitator URL is required. ' +
        'Set X402_FACILITATOR_URL in your environment or pass facilitatorUrl in options. ' +
        'Use "https://x402.org/facilitator" for the Coinbase testnet facilitator.'
    );
  }

  const apiKey = opts.facilitatorApiKey ?? config.X402_FACILITATOR_API_KEY;
  const network = toCaip2(config.STELLAR_NETWORK);
  const payTo = opts.payTo ?? config.AGENT_PUBLIC_KEY;

  // Build the facilitator client.  When an API key is configured we pass a
  // createAuthHeaders factory; the path argument lets us return per-endpoint
  // headers in the future (e.g. different keys for /verify vs /settle).
  const facilitatorClient = new HTTPFacilitatorClient({
    url: facilitatorUrl,
    ...(apiKey
      ? {
          createAuthHeaders: (_path: string) =>
            Promise.resolve({ headers: { Authorization: `Bearer ${apiKey}` } }),
        }
      : {}),
  });

  // The server-side ExactStellarScheme converts decimal prices into SAC
  // token amounts and builds the payment requirements that appear in the
  // PAYMENT-REQUIRED header.
  const stellarScheme = new ExactStellarScheme();
  const schemes: SchemeRegistration[] = [{ network, server: stellarScheme }];

  // Route key is a wildcard so the same middleware instance works regardless
  // of the path it is mounted at.  The facilitator sees the full URL from the
  // request, which uniquely identifies the resource.
  const routes = {
    'GET *': {
      accepts: {
        scheme: 'exact' as const,
        network,
        payTo,
        price: opts.price,
        ...(opts.description ? {} : {}), // description goes in RouteConfig, not PaymentOption
      },
      ...(opts.description ? { description: opts.description } : {}),
    },
  };

  log.info(
    { network, payTo, price: opts.price, asset: opts.asset ?? config.X402_ASSET_CODE, facilitatorUrl },
    'nodalPaywall middleware created'
  );

  return paymentMiddlewareFromConfig(routes, facilitatorClient, schemes);
}

// ─── OpenAPI discovery document (Issue #781) ──────────────────────────────────

import type { IncomingMessage, ServerResponse } from 'http';

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
