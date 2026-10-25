import { createDb, type DbHandle } from "../../src/db/client";
import { createFileStore, fileStoreConfigFrom, LOCAL_FILE_STORE, type FileStore } from "../../src/lib/r2";
import { createPasswordHasher } from "../../src/modules/auth/password/hasher";
import { resolveHashConfig } from "../../src/modules/auth/password/params";
import { loadArgon2ModuleFromDisk } from "../../src/modules/auth/password/wasm-node";
import type { ServiceDeps } from "../../src/modules/shared/context";
import { AppError } from "../../src/modules/shared/errors";
import { t } from "../../src/lib/i18n";
import { requireEnv } from "./load-env";

/**
 * Services for scripts, through the same driver as the app (Neon serverless). Hashing
 * parameters come from the environment like the app's; unset means production/OWASP.
 * For the free development Worker's database, set APP_ENV=development and the light
 * parameters in .env.secrets.local (never in a bundled env file — D-65).
 */
export function scriptDeps(): { deps: ServiceDeps; handle: DbHandle } {
  const databaseUrl = requireEnv("DATABASE_URL");
  const handle = createDb(databaseUrl, { localWsProxy: process.env.NEON_LOCAL_WSPROXY || undefined });
  const { params } = resolveHashConfig(process.env);
  const hasher = createPasswordHasher(loadArgon2ModuleFromDisk(), params);
  return { deps: { db: handle.db, hasher, now: new Date(), files: scriptFiles(databaseUrl) }, handle };
}

/**
 * R2 for scripts (phase 9): the configured bucket, or the local stand-in for a local database
 * only — files of a Neon database never go to this machine. `null`: no files are written.
 */
function scriptFiles(databaseUrl: string): FileStore | null {
  // Never the development fallback: only an explicit R2 or a local database.
  const config = fileStoreConfigFrom({ ...process.env, NODE_ENV: undefined });
  if (config) return createFileStore(config);
  const host = new URL(databaseUrl).hostname;
  return host === "localhost" || host === "127.0.0.1" ? createFileStore(LOCAL_FILE_STORE) : null;
}

/** Prints an error without values that could be secret (SEC-32), then exits non-zero. */
export function fail(error: unknown): never {
  if (error instanceof AppError) {
    const messages: Record<string, string> = t.errors.messages;
    console.error(
      `Failed: ${error.code}${error.rule ? ` (${error.rule})` : ""} — ${messages[error.messageKey] ?? error.messageKey}`,
    );
    for (const [field, key] of Object.entries(error.fieldErrors ?? {})) {
      console.error(`  ${field}: ${messages[key] ?? key}`);
    }
  } else {
    console.error("Failed:", error instanceof Error ? error.message : "unknown error");
  }
  process.exit(1);
}
