import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parse } from "dotenv";
import { BUNDLED_ENV_FILES, findBundledSecrets } from "./lib/bundle-env";
import { checkWranglerHashParams, findBundledHashKeys, parseJsonc } from "./lib/hash-params-guard";

/**
 * Runs before and after `opennextjs-cloudflare build`. Fails if a bundled env file
 * holds a secret, or (with --after-build) if the generated bundle env module does.
 * Secrets belong in .env.secrets.local (scripts) and Worker secrets. Prints file and
 * key names only, never values (SEC-32).
 *
 * Also refuses password hashing weaker than OWASP in any non-development Worker
 * environment of wrangler.jsonc, and hashing keys in bundled env files (D-65).
 */
async function main() {
  const problems = BUNDLED_ENV_FILES.filter((file) => existsSync(file)).flatMap((file) => {
    const vars = parse(readFileSync(file));
    return [...findBundledSecrets(file, vars), ...findBundledHashKeys(file, vars)];
  });
  problems.push(...checkWranglerHashParams(parseJsonc(readFileSync("wrangler.jsonc", "utf8")) as object));

  if (process.argv.includes("--after-build")) {
    const bundleEnv = resolve(".open-next/cloudflare/next-env.mjs");
    if (existsSync(bundleEnv)) {
      const modes = (await import(pathToFileURL(bundleEnv).href)) as Record<string, Record<string, string>>;
      for (const [mode, vars] of Object.entries(modes)) {
        const source = `.open-next/cloudflare/next-env.mjs [${mode}]`;
        problems.push(...findBundledSecrets(source, vars), ...findBundledHashKeys(source, vars));
      }
    }
  }

  if (problems.length > 0) {
    console.error("Refusing to build/deploy: secrets or unsafe settings would reach the Worker.");
    for (const p of problems) console.error(`  - ${p}`);
    console.error("Secrets: move them to .env.secrets.local (scripts) and Worker secrets (`wrangler secret put`).");
    console.error("Password hashing: production needs OWASP-strength parameters (D-65, docs/DECISIONS.md).");
    process.exit(1);
  }
  console.log("Bundle env check passed: no secrets in bundled env files; password hashing parameters allowed.");
}

main();
