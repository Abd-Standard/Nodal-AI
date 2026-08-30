/**
 * stryker.config.mjs
 *
 * Stryker mutation-testing configuration.
 * Targets backend/agent.ts and backend/tools/StellarPaymentTool.ts.
 *
 * Run: npm run test:mutation
 *
 * Issue: #456
 *
 * @type {import('@stryker-mutator/api/core').PartialStrykerOptions}
 */
export default {
  /** Use the vitest runner so mutations are tested inside the existing suite. */
  testRunner: "vitest",

  /** Only mutate the two targeted files. */
  mutate: [
    "backend/agent.ts",
    "backend/tools/StellarPaymentTool.ts",
  ],

  /**
   * Run the tests most likely to catch mutations in agent.ts and
   * StellarPaymentTool.ts first (improves performance via test filtering).
   */
  vitest: {
    configFile: "vitest.config.ts",
  },

  /** Reporters: clear-text for CI, HTML for local inspection. */
  reporters: ["clear-text", "html"],

  /**
   * Enforce a minimum mutation score of 60 % for the targeted files.
   * Stryker will exit with a non-zero code if the score falls below this.
   */
  thresholds: {
    high: 80,
    low: 60,
    break: 60,
  },

  /**
   * TypeScript source maps let Stryker map mutations back to .ts lines.
   * The project already emits source maps via tsconfig.json.
   */
  coverageAnalysis: "perTest",

  /** Keep the temp sandbox in a predictable location for debugging. */
  tempDirName: ".stryker-tmp",

  /** Concurrency: use half available CPUs to avoid OOM in CI. */
  concurrency: 2,
};
