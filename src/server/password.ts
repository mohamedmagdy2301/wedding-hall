import "server-only";
import { createPasswordHasher, type PasswordHasher } from "@/modules/auth/password/hasher";
import { resolveHashConfig } from "@/modules/auth/password/params";
import { argon2Module } from "@/modules/auth/password/wasm";

let hasher: PasswordHasher | undefined;

/**
 * The app's hasher. Parameters come from the Worker's vars (P1-09); resolveHashConfig
 * refuses weaker-than-OWASP parameters outside development/test at runtime too (D-65).
 * Only the configuration is cached: each operation still gets a fresh WASM instance.
 */
export function getPasswordHasher(): PasswordHasher {
  hasher ??= createPasswordHasher(argon2Module, resolveHashConfig(process.env).params);
  return hasher;
}
