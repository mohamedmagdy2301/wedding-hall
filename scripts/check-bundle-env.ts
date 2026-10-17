import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parse } from "dotenv";
import { BUNDLED_ENV_FILES, findBundledSecrets } from "./lib/bundle-env";

/**
 * Runs before and after `opennextjs-cloudflare build`. Fails if a bundled env file
 * holds a secret, or (with --after-build) if the generated bundle env module does.
 * Secrets belong in .env.secrets.local (scripts) and Worker secrets. Prints file and
 * key names only, never values (SEC-32).
 */
async function main() {
  const problems = BUNDLED_ENV_FILES.filter((file) => existsSync(file)).flatMap((file) =>
    findBundledSecrets(file, parse(readFileSync(file))),
  );

  if (process.argv.includes("--after-build")) {
    const bundleEnv = resolve(".open-next/cloudflare/next-env.mjs");
    if (existsSync(bundleEnv)) {
      const modes = (await import(pathToFileURL(bundleEnv).href)) as Record<string, Record<string, string>>;
      for (const [mode, vars] of Object.entries(modes)) {
        problems.push(...findBundledSecrets(`.open-next/cloudflare/next-env.mjs [${mode}]`, vars));
      }
    }
  }

  if (problems.length > 0) {
    console.error("Refusing to build/deploy: secrets would be embedded in the Worker bundle.");
    for (const p of problems) console.error(`  - ${p}`);
    console.error("Move them to .env.secrets.local (scripts) and Worker secrets (`wrangler secret put`).");
    process.exit(1);
  }
  console.log("Bundle env check passed: no secrets in bundled env files.");
}

main();
