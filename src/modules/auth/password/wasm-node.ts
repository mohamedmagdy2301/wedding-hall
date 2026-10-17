import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Loads the vendored Argon2 module outside the Next.js bundle (scripts and tests run by
 * Node from the repository root). The app imports it with `?module` instead (wasm.ts).
 */
export function loadArgon2ModuleFromDisk(): WebAssembly.Module {
  return new WebAssembly.Module(readFileSync(resolve(process.cwd(), "src/modules/auth/password/vendor/argon2.wasm")));
}
