import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    // Test-only libraries never reach the Worker bundle (CLAUDE.md rule 11, D-96).
    files: ["src/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        { paths: [{ name: "fast-check", message: "fast-check is a dev dependency for tests only (D-96)." }] },
      ],
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Cloudflare build output and test artifacts:
    ".open-next/**",
    ".wrangler/**",
    "playwright-report/**",
    "test-results/**",
    "cloudflare-env.d.ts",
  ]),
]);

export default eslintConfig;
