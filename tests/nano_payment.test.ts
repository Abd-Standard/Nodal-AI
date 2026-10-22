/**
 * tests/nano_payment.test.ts
 *
 * Tests for NanoPaymentTool feeless settlement rail beside Stellar (#715).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import axios from 'axios';
import { NanoPaymentTool, NanoPaymentInputSchema } from '../backend/tools/NanoPaymentTool';

vi.mock('axios');

describe('NanoPaymentTool — Feeless settlement rail (#715)', () => {
  let tool: NanoPaymentTool;
  const VALID_NANO_ADDR = 'nano_3t6k35fd954wuafmangfbefpqsvt09fgpkq8k6i61q5nwn9x54kc16b6hrn1';
  const VALID_XRB_ADDR = 'xrb_3t6k35fd954wuafmangfbefpqsvt09fgpkq8k6i61q5nwn9x54kc16b6hrn1';
  const SUB_CENT_RAW = '1000000000000000000000000'; // 0.000001 XNO (sub-cent micro-payment)

  beforeEach(() => {
    vi.clearAllMocks();
    tool = new NanoPaymentTool();
  });

  describe('Input validation', () => {
    it('accepts valid nano_ and xrb_ addresses with positive raw amount', () => {
      const parsedNano = NanoPaymentInputSchema.parse({
        recipient: VALID_NANO_ADDR,
        amountRaw: SUB_CENT_RAW,
      });
      expect(parsedNano.recipient).toBe(VALID_NANO_ADDR);

      const parsedXrb = NanoPaymentInputSchema.parse({
        recipient: VALID_XRB_ADDR,
        amountRaw: '1',
      });
      expect(parsedXrb.recipient).toBe(VALID_XRB_ADDR);
    });

    it('rejects invalid recipient addresses', () => {
      expect(() =>
        NanoPaymentInputSchema.parse({
          recipient: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5', // Stellar addr
          amountRaw: SUB_CENT_RAW,
        })
      ).toThrow(/Invalid Nano address/);

      expect(() =>
        NanoPaymentInputSchema.parse({
          recipient: 'nano_invalid_short',
          amountRaw: SUB_CENT_RAW,
        })
      ).toThrow(/Invalid Nano address/);
    });

    it('rejects non-positive or non-numeric amountRaw', () => {
      expect(() =>
        NanoPaymentInputSchema.parse({
          recipient: VALID_NANO_ADDR,
          amountRaw: '0',
        })
      ).toThrow(/greater than zero/);

      expect(() =>
        NanoPaymentInputSchema.parse({
          recipient: VALID_NANO_ADDR,
          amountRaw: '-500',
        })
      ).toThrow(/unsigned integer/);

      expect(() =>
        NanoPaymentInputSchema.parse({
          recipient: VALID_NANO_ADDR,
          amountRaw: '0.001',
        })
      ).toThrow(/unsigned integer/);
    });
  });

  describe('Simulation gate / Pre-check', () => {
    it('passes pre-check when recipient account is open', async () => {
      vi.mocked(axios.post).mockResolvedValueOnce({
        data: {
          frontier: 'A'.repeat(64),
          open_block: 'B'.repeat(64),
          balance: '5000000000000000000000000',
        },
      });

      const passed = await tool.precheckRecipient(VALID_NANO_ADDR, 'http://127.0.0.1:7076');
      expect(passed).toBe(true);
    });

    it('passes pre-check when recipient account is unopened (valid for open block)', async () => {
      vi.mocked(axios.post).mockResolvedValueOnce({
        data: {
          error: 'Account not found',
        },
      });

      const passed = await tool.precheckRecipient(VALID_NANO_ADDR, 'http://127.0.0.1:7076');
      expect(passed).toBe(true);
    });
  });

  describe('Execution & Feeless Receipt', () => {
    it('executes a sub-cent payment and returns block hash receipt', async () => {
      vi.mocked(axios.post).mockResolvedValue({
        data: { hash: 'C'.repeat(64) },
      });

      const result = await tool.execute({
        recipient: VALID_NANO_ADDR,
        amountRaw: SUB_CENT_RAW,
      });

      expect(result.network).toBe('nano');
      expect(result.recipient).toBe(VALID_NANO_ADDR);
      expect(result.amountRaw).toBe(SUB_CENT_RAW);
      expect(result.precheckPassed).toBe(true);
      expect(result.blockHash).toMatch(/^[A-F0-9]{64}$/);
      expect(result.timestamp).toBeDefined();
    });

    it('supports skipping precheck when requested', async () => {
      const result = await tool.execute({
        recipient: VALID_NANO_ADDR,
        amountRaw: SUB_CENT_RAW,
        skipPrecheck: true,
      });

      expect(result.precheckPassed).toBe(true);
      expect(result.blockHash).toBeDefined();
    });
  });
});
