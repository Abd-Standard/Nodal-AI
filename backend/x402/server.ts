/**
 * backend/x402/server.ts
 *
 * x402 v2 seller middleware using @x402/express
 * Implements SEP-41 facilitator-based payment requirements.
 */

import { X402Middleware, X402MiddlewareOptions } from '@x402/express';
import { config } from '../config';
import { logger } from '../logger';

/**
 * Options for creating an x402 middleware instance.
 * Extends @x402/express options with Nodal-specific customizations.
 */
export interface X402MiddlewareOptionsWithLegacy extends X402MiddlewareOptions {
  /** Optional custom X402 challenge response handler */
  challengeHandler?: (resource: string) => Promise<{
    amount: string;
    assetCode: string;
    assetIssuer: string;
    payTo: string;
    nonce: string;
    expiresAt: string;
    network?: string;
  }>;
}

/**
 * Create x402 seller middleware with support for both v2 and legacy modes.
 * 
 * When `config.X402_USE_LEGACY === true`, falls back to legacy JSON challenge format
 * for backward compatibility.
 */
export function createX402Middleware(options: X402MiddlewareOptionsWithLegacy = {}) {
  // If legacy mode is enabled, return a simple middleware that returns JSON challenges
  if (config.X402_USE_LEGACY) {
    logger.warn('x402: legacy mode enabled - using JSON challenge format for backward compatibility');
    return createLegacyMiddleware(options);
  }

  // Use official @x402/express middleware for v2
  const x402Middleware = X402Middleware({
    ...options,
    // Set up facilitator if configured
    facilitatorUrl: config.X402_FACILITATOR_URL,
    // Default asset if not specified in options
    asset: options.asset || {
      code: config.X402_ASSET_CODE,
      issuer: config.X402_ASSET_ISSUER,
    },
  });

  logger.info('x402 v2 middleware enabled with SEP-41 token transfers');
  return x402Middleware;
}

/**
 * Legacy middleware that returns JSON challenges compatible with older clients.
 * Used when X402_USE_LEGACY=true for backward compatibility.
 */
function createLegacyMiddleware(options: X402MiddlewareOptionsWithLegacy = {}) {
  return async (req: any, res: any, next: (err?: Error) => void) => {
    try {
      // Determine the amount needed for this resource
      let amount = '1';
      let assetCode = config.X402_ASSET_CODE;
      let assetIssuer = config.X402_ASSET_ISSUER;
      let payTo = config.AGENT_PUBLIC_KEY;

      // Allow custom challenge handler to override defaults
      if (options.challengeHandler) {
        const challenge = await options.challengeHandler(req.originalUrl || req.url);
        amount = challenge.amount;
        assetCode = challenge.assetCode;
        assetIssuer = challenge.assetIssuer;
        payTo = challenge.payTo;
      }

      // Generate a unique nonce for this challenge
      const nonce = options.nonceGenerator?.() || generateNonce();
      
      // Calculate expiry (default: 5 minutes from now)
      const expiresAt = options.expiresIn 
        ? new Date(Date.now() + options.expiresIn * 1000).toISOString()
        : new Date(Date.now() + 5 * 60 * 1000).toISOString();

      // Build legacy challenge object
      const challenge = {
        resource: req.originalUrl || req.url,
        amount,
        assetCode,
        assetIssuer,
        payTo,
        nonce,
        expiresAt,
        // CAIP-2 network ID for v2 compatibility
        network: `stellar:${config.STELLAR_NETWORK}`,
      };

      // Set headers for 402 Payment Required response
      res.status(402);
      res.set('PAYMENT', `${config.AGENT_PUBLIC_KEY}; rel="payment"`);
      res.set('X-X402-Version', '1');
      res.set('X-X402-Resource', challenge.resource);
      res.set('X-X402-Amount', challenge.amount);
      res.set('X-X402-Asset', `${challenge.assetCode}:${challenge.assetIssuer}`);
      res.set('X-X402-Nonce', challenge.nonce);
      res.set('X-X402-Expires', challenge.expiresAt);

      // Return challenge in body
      res.json({
        ...challenge,
        // Include accepts array for v2 awareness
        accepts: [
          {
            scheme: 'stellar',
            type: 'payment',
            network: `stellar:${config.STELLAR_NETWORK}`,
            destination: challenge.payTo,
          },
        ],
      });

      logger.debug({ url: req.url, amount, asset: `${assetCode}:${assetIssuer}` }, 'x402 legacy challenge issued');
      
      // Stop processing - we've handled the response
      return;
    } catch (err) {
      logger.error({ error: String(err) }, 'x402 legacy middleware error');
      next(err as Error);
    }
  };
}

/**
 * Generate a UUID v4 nonce for x402 challenges.
 */
function generateNonce(): string {
  // Simple UUID v4 generator (node:crypto.randomUUID() requires Node 16+)
  const uuid = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
  return uuid;
}

/**
 * Extract the X402 challenge from a request's headers.
 * Used by sellers to verify payment proofs from buyers.
 */
export function getX402ChallengeFromHeaders(headers: Record<string, string | string[]>): any | null {
  const x402Version = Array.isArray(headers['x-x402-version']) 
    ? headers['x-x402-version'][0] 
    : headers['x-x402-version'];
  
  if (!x402Version) {
    return null;
  }

  // v1 legacy format
  if (x402Version === '1') {
    return {
      amount: Array.isArray(headers['x-x402-amount']) 
        ? headers['x-x402-amount'][0] 
        : headers['x-x402-amount'],
      assetCode: Array.isArray(headers['x-x402-asset']) 
        ? headers['x-x402-asset'][0].split(':')[0] 
        : headers['x-x402-asset']?.split(':')[0],
      assetIssuer: Array.isArray(headers['x-x402-asset']) 
        ? headers['x-x402-asset'][0].split(':')[1] 
        : headers['x-x402-asset']?.split(':')[1],
      payTo: Array.isArray(headers['pay']) 
        ? headers['pay'][0] 
        : headers['pay'],
      nonce: Array.isArray(headers['x-x402-nonce']) 
        ? headers['x-x402-nonce'][0] 
        : headers['x-x402-nonce'],
      expiresAt: Array.isArray(headers['x-x402-expires']) 
        ? headers['x-x402-expires'][0] 
        : headers['x-x402-expires'],
      resource: Array.isArray(headers['x-x402-resource']) 
        ? headers['x-x402-resource'][0] 
        : headers['x-x402-resource'],
      network: Array.isArray(headers['x-x402-network']) 
        ? headers['x-x402-network'][0] 
        : headers['x-x402-network'],
    };
  }

  // v2 format - use the official library to parse
  return null; // Let @x402/core handle v2 parsing
}
