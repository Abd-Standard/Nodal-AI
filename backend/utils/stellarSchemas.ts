/**
 * Shared Zod schemas for Stellar strkey addresses (Issue #567).
 *
 * Seventeen tool files each defined their own `z.string().length(56, …)`, and
 * only nine of them went on to verify the Ed25519 checksum. In the other eight
 * a right-shaped address with a corrupted character passed input validation
 * and failed later as an opaque SDK or network error — which is both harder to
 * act on and much further from the mistake that caused it.
 *
 * The checksum is the whole point of strkey: it is what turns a mistyped
 * address into a validation error instead of a payment to nowhere. Length and
 * a prefix character catch neither a transposition nor a single wrong letter.
 *
 * # Why two schemas, not one
 *
 * Three of those seventeen fields are contract IDs (`C…`), not account public
 * keys (`G…`). They share the 56-character length and nothing else: a contract
 * ID checked with `isValidEd25519PublicKey` would be rejected outright. They
 * get their own schema rather than being folded in.
 *
 * # Muxed accounts (Issue #787)
 *
 * A muxed account (`M…`, 69 characters) is a `G…` account plus a 64-bit ID,
 * used by exchanges and custodians in place of a memo. The protocol accepts
 * one wherever an operation *pays to* an account (payment and path-payment
 * destinations), so those fields use `stellarDestinationSchema`. Fields that
 * name an account itself — signers, issuers, sponsors, fee sources — stay on
 * `stellarPublicKeySchema` and remain `G…`-only.
 */

import { StrKey } from '@stellar/stellar-sdk';
import { z } from 'zod';

/** Length of every strkey-encoded Stellar address. */
export const STRKEY_LENGTH = 56;

/** Whether a string is a valid Ed25519 account public key (`G…`). */
export function isValidStellarPublicKey(value: string): boolean {
  return StrKey.isValidEd25519PublicKey(value);
}

/** Whether a string is a valid muxed account address (`M…`). */
export function isValidStellarMuxedAddress(value: string): boolean {
  return StrKey.isValidMed25519PublicKey(value);
}

/** Whether a string can receive a payment: a `G…` account or a muxed `M…` account. */
export function isValidStellarDestination(value: string): boolean {
  return isValidStellarPublicKey(value) || isValidStellarMuxedAddress(value);
}

/**
 * The underlying `G…` account of a destination. A muxed `M…` address is
 * reduced to the account it multiplexes; anything else is returned unchanged.
 */
export function baseAccountId(address: string): string {
  if (!isValidStellarMuxedAddress(address)) return address;
  // The first 32 bytes of a decoded M-address are the Ed25519 key; the
  // trailing 8 are the mux ID.
  return StrKey.encodeEd25519PublicKey(StrKey.decodeMed25519PublicKey(address).subarray(0, 32));
}

/** Whether a string is a valid contract address (`C…`). */
export function isValidStellarContractId(value: string): boolean {
  return StrKey.isValidContract(value);
}

/**
 * A Stellar account public key.
 *
 * `label` names the field in the failure message, so a rejected multi-sig
 * request says which signer was wrong rather than "Invalid Stellar public
 * key" repeated once per entry.
 *
 * Checks run in order — length, prefix, then checksum — so the message a
 * caller gets describes the first thing that is actually wrong.
 */
export function stellarPublicKeySchema(label = 'Stellar public key') {
  const invalidMessage = invalidPublicKeyMessage(label);

  return z
    .string()
    .length(STRKEY_LENGTH, invalidMessage)
    .refine((val) => val.startsWith('G'), {
      message: invalidMessage,
    })
    .refine(isValidStellarPublicKey, {
      message: invalidMessage,
    });
}

/**
 * A payment destination: a `G…` account public key or a muxed `M…` account,
 * both checksum-verified. Use only where the protocol accepts a muxed account
 * (payment and path-payment destinations); everywhere else use
 * `stellarPublicKeySchema`.
 */
export function stellarDestinationSchema(label = 'Destination') {
  return z.string().refine(isValidStellarDestination, {
    message: invalidPublicKeyMessage(label),
  });
}

function invalidPublicKeyMessage(label: string): string {
  return label === 'Signer public key'
    ? 'Invalid signer public key: Invalid Stellar public key'
    : label === 'Asset issuer'
      ? 'Invalid asset issuer: must be a valid Stellar public key'
      : label === 'payTo'
        ? 'Invalid Stellar public key: payTo must be a valid Stellar address'
        : label.toLowerCase() === 'destination'
          ? `Invalid Stellar public key: ${label} must be a valid Stellar public key`
          : label.toLowerCase() === 'inflation destination'
            ? 'Invalid inflation destination: must be a valid Stellar public key'
            : label === 'Stellar public key'
              ? 'Invalid Stellar public key'
              : `Invalid Stellar public key: ${label} is not valid`;
}

/** A Stellar contract address (`C…`). */
export function stellarContractIdSchema(label = 'Stellar contract ID') {
  return z
    .string()
    .length(STRKEY_LENGTH, `${label} must be ${STRKEY_LENGTH} characters`)
    .refine((val) => val.startsWith('C'), {
      message: `${label} must start with C`,
    })
    .refine(isValidStellarContractId, {
      message: 'Invalid Stellar contract ID',
    });
}

/** Default instances, for the common case where the label adds nothing. */
export const StellarPublicKeySchema = stellarPublicKeySchema();
export const StellarContractIdSchema = stellarContractIdSchema();
