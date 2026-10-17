import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { checkWranglerHashParams, findBundledHashKeys, parseJsonc } from "../../scripts/lib/hash-params-guard";

const weak = { PASSWORD_HASH_MEMORY_KIB: "4096", PASSWORD_HASH_ITERATIONS: "1" };

describe("build/deploy guard for password hashing parameters (D-65)", () => {
  it("passes the repository's wrangler.jsonc (development Worker with light parameters)", () => {
    const config = parseJsonc(readFileSync("wrangler.jsonc", "utf8")) as Parameters<typeof checkWranglerHashParams>[0];
    expect(config.vars?.APP_ENV).toBe("development");
    expect(checkWranglerHashParams(config)).toEqual([]);
  });

  it("refuses weak parameters in an environment that is not development/test", () => {
    const problems = checkWranglerHashParams({
      vars: { APP_ENV: "development", ...weak },
      env: {
        venue: { vars: { APP_ENV: "production", ...weak } },
        // vars are not inherited from the top level, so this block is production with weak params
        other: { vars: { ...weak } },
        ok: { vars: { APP_ENV: "production" } },
      },
    });
    expect(problems).toHaveLength(2);
    expect(problems[0]).toMatch(/env\.venue: .*weaker than OWASP/);
    expect(problems[1]).toMatch(/env\.other: .*APP_ENV=production/);
  });

  it("refuses weak parameters at the top level when APP_ENV is missing", () => {
    expect(checkWranglerHashParams({ vars: weak })).toHaveLength(1);
    expect(checkWranglerHashParams({})).toEqual([]);
  });

  it("refuses hashing keys in bundled env files, naming keys only", () => {
    expect(
      findBundledHashKeys(".env.local", { APP_ENV: "development", DATABASE_URL: "x", PASSWORD_HASH_ITERATIONS: "1" }),
    ).toEqual([
      ".env.local: APP_ENV (set it in wrangler.jsonc vars, not in a bundled env file)",
      ".env.local: PASSWORD_HASH_ITERATIONS (set it in wrangler.jsonc vars, not in a bundled env file)",
    ]);
  });

  it("parses JSONC comments and trailing commas without touching strings", () => {
    expect(
      parseJsonc(`{
        // line comment
        "a": "http://x.y/*not a comment*/", /* block */
        "b": [1, 2,],
      }`),
    ).toEqual({ a: "http://x.y/*not a comment*/", b: [1, 2] });
  });
});
