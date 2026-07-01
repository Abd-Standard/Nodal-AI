import { test } from "node:test";
import { expect } from "node:assert";
import fc from "fast-check";
import { X402ChallengeSchema } from "../../backend/tools/X402PaymentTool";

test("X402ChallengeSchema fuzz test", async () => {
  await fc.assert(
    fc.asyncProperty(fc.string(), async (jsonString) => {
      // Attempt to parse JSON, if fails schema validation should reject
      let parsed: unknown;
      try {
        parsed = JSON.parse(jsonString);
      } catch {
        // non-JSON strings are ok to reject
        return;
      }
      const result = X402ChallengeSchema.safeParse(parsed);
      // The schema should never throw; safeParse returns success boolean
      expect(typeof result.success).toBe("boolean");
    })
  );
});
