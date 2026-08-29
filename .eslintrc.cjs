module.exports = {
  parser: "@typescript-eslint/parser",
  plugins: ["@typescript-eslint"],
  extends: [
    "eslint:recommended",
    "plugin:@typescript-eslint/recommended",
  ],
  env: { node: true, es2022: true },

  rules: {
    "@typescript-eslint/no-explicit-any": "warn",
    "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
  },

  overrides: [
    {
      // Enforce structured logger usage across all backend source files.
      // console.* calls are forbidden here; use createLogger() from
      // backend/utils/logger.ts instead.
      files: ["backend/**/*.ts"],
      excludedFiles: [
        // backend/logger.ts is the logger implementation itself — it must be
        // allowed to call console.log/console.error as the output transport.
        "backend/logger.ts",
      ],
      rules: {
        "no-console": "error",
      },
    },
    {
      files: [
        "backend/agent.ts",
        "backend/tools/**/*.ts",
      ],

      // Environment variables must be accessed through backend/config.ts
      // so they pass Zod validation and secret-redaction logic.
      rules: {
        "no-restricted-properties": [
          "error",
          {
            object: "process",
            property: "env",
            message:
              "Do not access process.env directly. Use backend/config.ts instead.",
          },
        ],
      },
    },
    {
      // Test files use require() inside vi.mock() factories which are hoisted
      // by Vitest and cannot use ESM import syntax. Disable the rule for tests.
      files: ["tests/**/*.ts"],
      rules: {
        "@typescript-eslint/no-var-requires": "off",
      },
    },
  ],
};
