/**
 * tests/memo_attachment.test.ts
 * Unit tests for MemoAttachmentTool buildMemo utility.
 */

import { describe, it, expect } from "vitest";
import { Memo } from "@stellar/stellar-sdk";
import { buildMemo, ValidationError } from "../backend/tools/MemoAttachmentTool";

describe("buildMemo", () => {
  describe("MEMO_TEXT", () => {
    it("builds a valid text memo within 28 bytes", () => {
      const memo = buildMemo({ type: "MEMO_TEXT", value: "hello world" });
      expect(memo.type).toBe("text");
      expect(memo.value).toBe("hello world");
    });

    it("builds a valid text memo exactly 28 bytes", () => {
      const value = "a".repeat(28);
      const memo = buildMemo({ type: "MEMO_TEXT", value });
      expect(memo.type).toBe("text");
      expect(memo.value).toBe(value);
    });

    it("throws ValidationError when text exceeds 28 bytes", () => {
      const value = "a".repeat(29);
      expect(() => buildMemo({ type: "MEMO_TEXT", value })).toThrow(ValidationError);
      expect(() => buildMemo({ type: "MEMO_TEXT", value })).toThrow(
        /exceeds maximum length of 28 bytes/
      );
    });

    it("handles multi-byte UTF-8 characters correctly", () => {
      // "🚀" is 4 bytes in UTF-8. 7 * 4 = 28 bytes.
      const validUtf8 = "🚀".repeat(7);
      const memo = buildMemo({ type: "MEMO_TEXT", value: validUtf8 });
      expect(memo.type).toBe("text");

      // 8 * 4 = 32 bytes > 28 bytes -> overflow
      const invalidUtf8 = "🚀".repeat(8);
      expect(() => buildMemo({ type: "MEMO_TEXT", value: invalidUtf8 })).toThrow(ValidationError);
    });
  });

  describe("MEMO_HASH", () => {
    it("builds a valid hash memo with a 64-char hex string (32 bytes)", () => {
      const hex = "1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef";
      const memo = buildMemo({ type: "MEMO_HASH", value: hex });
      expect(memo.type).toBe("hash");
      expect(Buffer.isBuffer(memo.value)).toBe(true);
      expect((memo.value as Buffer).toString("hex")).toBe(hex.toLowerCase());
    });

    it("throws ValidationError for non-hex characters", () => {
      const invalidHex = "1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdeg";
      expect(() => buildMemo({ type: "MEMO_HASH", value: invalidHex })).toThrow(ValidationError);
      expect(() => buildMemo({ type: "MEMO_HASH", value: invalidHex })).toThrow(
        /must be a valid hex string/
      );
    });

    it("throws ValidationError when hex length is not 64 chars", () => {
      const shortHex = "1234567890abcdef";
      expect(() => buildMemo({ type: "MEMO_HASH", value: shortHex })).toThrow(ValidationError);
      expect(() => buildMemo({ type: "MEMO_HASH", value: shortHex })).toThrow(
        /must be a 32-byte hex string/
      );
    });
  });

  describe("MEMO_ID", () => {
    it("builds a valid ID memo with a numeric string", () => {
      const memo = buildMemo({ type: "MEMO_ID", value: "123456789" });
      expect(memo.type).toBe("id");
      expect(memo.value).toBe("123456789");
    });

    it("builds a valid ID memo for max uint64", () => {
      const maxUint64 = "18446744073709551615";
      const memo = buildMemo({ type: "MEMO_ID", value: maxUint64 });
      expect(memo.type).toBe("id");
      expect(memo.value).toBe(maxUint64);
    });

    it("throws ValidationError for non-numeric input", () => {
      expect(() => buildMemo({ type: "MEMO_ID", value: "abc" })).toThrow(ValidationError);
      expect(() => buildMemo({ type: "MEMO_ID", value: "abc" })).toThrow(
        /must be a numeric string/
      );
    });

    it("throws ValidationError for numbers out of 64-bit uint range", () => {
      const overUint64 = "18446744073709551616";
      expect(() => buildMemo({ type: "MEMO_ID", value: overUint64 })).toThrow(ValidationError);
      expect(() => buildMemo({ type: "MEMO_ID", value: overUint64 })).toThrow(
        /out of 64-bit unsigned integer range/
      );
    });
  });

  describe("MEMO_RETURN", () => {
    it("builds a valid return memo with a 64-char hex string (32 bytes)", () => {
      const hex = "abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890";
      const memo = buildMemo({ type: "MEMO_RETURN", value: hex });
      expect(memo.type).toBe("return");
      expect(Buffer.isBuffer(memo.value)).toBe(true);
      expect((memo.value as Buffer).toString("hex")).toBe(hex.toLowerCase());
    });

    it("throws ValidationError for non-hex string or invalid length", () => {
      expect(() => buildMemo({ type: "MEMO_RETURN", value: "invalid" })).toThrow(ValidationError);
    });
  });

  describe("Unsupported types", () => {
    it("throws ValidationError for unsupported memo type", () => {
      expect(() => buildMemo({ type: "UNKNOWN" as any, value: "test" })).toThrow(ValidationError);
    });
  });
});
