import { HASH_ENV_KEYS, resolveHashConfig } from "../../src/modules/auth/password/params";

/**
 * D-65: weaker-than-OWASP password hashing is allowed only where APP_ENV is development
 * or test. Wrangler `vars` are not inherited by `env.<name>` blocks, so every block is
 * checked on its own, exactly as it would be deployed. Missing values fall back to the
 * OWASP defaults, which always pass.
 */

type WranglerConfig = { vars?: Record<string, unknown>; env?: Record<string, { vars?: Record<string, unknown> }> };

/** Strips // and /* *\/ comments and trailing commas outside strings (wrangler.jsonc). */
export function parseJsonc(text: string): unknown {
  let out = "";
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      out += c;
      if (c === "\\") out += text[++i] ?? "";
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (c === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i++;
    } else {
      out += c;
    }
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
}

/** One finding per deployable environment whose hashing configuration is rejected. */
export function checkWranglerHashParams(config: WranglerConfig): string[] {
  const targets: Array<[string, Record<string, unknown>]> = [["(top level)", config.vars ?? {}]];
  for (const [name, env] of Object.entries(config.env ?? {})) targets.push([`env.${name}`, env.vars ?? {}]);

  return targets.flatMap(([name, vars]) => {
    try {
      resolveHashConfig(vars);
      return [];
    } catch (error) {
      return [`wrangler.jsonc ${name}: ${error instanceof Error ? error.message : String(error)}`];
    }
  });
}

/**
 * The hashing keys belong in wrangler `vars` only. In a Next.js env file OpenNext would
 * embed them in the bundle, where they could silently override a production Worker's vars.
 */
export function findBundledHashKeys(source: string, vars: Record<string, string>): string[] {
  return Object.keys(vars)
    .filter((key) => (HASH_ENV_KEYS as readonly string[]).includes(key))
    .map((key) => `${source}: ${key} (set it in wrangler.jsonc vars, not in a bundled env file)`);
}
