/**
 * Argon2id cost parameters (D-64, D-65). Pure: no WASM, no I/O.
 * Values come from environment variables (P1-09); every stored hash carries its own
 * parameters in PHC form, so changing them only triggers a rehash at the next login.
 */

export type HashParams = {
  /** Memory in KiB (Argon2 `m`). */
  memoryKib: number;
  /** Passes over memory (Argon2 `t`). */
  iterations: number;
  /** Lanes (Argon2 `p`). */
  parallelism: number;
};

/** Production default: OWASP's first Argon2id recommendation (D-64). */
export const OWASP_DEFAULT: HashParams = { memoryKib: 19_456, iterations: 2, parallelism: 1 };

/** OWASP Password Storage Cheat Sheet, Argon2id: equivalent (memory, iterations) pairs. */
export const OWASP_ARGON2ID_PROFILES: ReadonlyArray<Pick<HashParams, "memoryKib" | "iterations">> = [
  { memoryKib: 47_104, iterations: 1 },
  { memoryKib: 19_456, iterations: 2 },
  { memoryKib: 12_288, iterations: 3 },
  { memoryKib: 9_216, iterations: 4 },
  { memoryKib: 7_168, iterations: 5 },
];

/** Bounds that keep one hash inside a Workers isolate (128 MiB) and a sane CPU budget. */
export const PARAM_BOUNDS = {
  memoryKib: { min: 1_024, max: 65_536 },
  iterations: { min: 1, max: 10 },
  parallelism: { min: 1, max: 4 },
} as const;

/** Environments allowed to run below OWASP strength (D-65). Anything else, or unset, is production. */
export const WEAK_PARAMS_ENVIRONMENTS = ["development", "test"] as const;

export const HASH_ENV_KEYS = [
  "APP_ENV",
  "PASSWORD_HASH_MEMORY_KIB",
  "PASSWORD_HASH_ITERATIONS",
  "PASSWORD_HASH_PARALLELISM",
] as const;

export type HashConfig = { appEnv: string; params: HashParams };

export function isAtLeastOwasp(params: HashParams): boolean {
  return (
    params.parallelism >= 1 &&
    OWASP_ARGON2ID_PROFILES.some((p) => params.memoryKib >= p.memoryKib && params.iterations >= p.iterations)
  );
}

export function allowsWeakParams(appEnv: string | undefined): boolean {
  return (WEAK_PARAMS_ENVIRONMENTS as readonly string[]).includes(appEnv ?? "");
}

function readInt(source: Record<string, unknown>, key: string, fallback: number, bounds: { min: number; max: number }) {
  const raw = source[key];
  if (raw === undefined || raw === "") return fallback;
  const value = typeof raw === "number" ? raw : Number(String(raw).trim());
  if (!Number.isInteger(value) || value < bounds.min || value > bounds.max) {
    throw new Error(`${key} must be an integer between ${bounds.min} and ${bounds.max}`);
  }
  return value;
}

/**
 * Reads and validates the hashing configuration. Throws when the parameters are out of
 * bounds, or weaker than OWASP outside development/test (D-65). Messages name keys only.
 */
export function resolveHashConfig(source: Record<string, unknown>): HashConfig {
  const appEnv = typeof source.APP_ENV === "string" && source.APP_ENV !== "" ? source.APP_ENV : "production";
  const params: HashParams = {
    memoryKib: readInt(source, "PASSWORD_HASH_MEMORY_KIB", OWASP_DEFAULT.memoryKib, PARAM_BOUNDS.memoryKib),
    iterations: readInt(source, "PASSWORD_HASH_ITERATIONS", OWASP_DEFAULT.iterations, PARAM_BOUNDS.iterations),
    parallelism: readInt(source, "PASSWORD_HASH_PARALLELISM", OWASP_DEFAULT.parallelism, PARAM_BOUNDS.parallelism),
  };
  if (!isAtLeastOwasp(params) && !allowsWeakParams(appEnv)) {
    throw new Error(
      `Password hashing parameters are weaker than OWASP for APP_ENV=${appEnv}; ` +
        `weaker parameters are only allowed for ${WEAK_PARAMS_ENVIRONMENTS.join("/")} (D-65)`,
    );
  }
  return { appEnv, params };
}

const PHC_ARGON2ID = /^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$[A-Za-z0-9+/]+\$[A-Za-z0-9+/]+$/;

/** Parameters stored in a PHC string, or null if it is not an Argon2id v1.3 hash. */
export function parsePhcParams(encoded: string): HashParams | null {
  const match = PHC_ARGON2ID.exec(encoded);
  if (!match) return null;
  return { memoryKib: Number(match[1]), iterations: Number(match[2]), parallelism: Number(match[3]) };
}

/** True when a stored hash was made with parameters other than the current ones (P1-09). */
export function needsRehash(encoded: string, current: HashParams): boolean {
  const stored = parsePhcParams(encoded);
  return (
    !stored ||
    stored.memoryKib !== current.memoryKib ||
    stored.iterations !== current.iterations ||
    stored.parallelism !== current.parallelism
  );
}
