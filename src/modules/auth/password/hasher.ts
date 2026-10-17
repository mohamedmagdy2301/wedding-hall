import Argon2, { Argon2Type, Argon2Version } from "@phi-ag/argon2";
import { needsRehash, type HashParams } from "./params";

/** Longest password accepted, so a request cannot make hashing arbitrarily expensive. */
export const MAX_PASSWORD_LENGTH = 128;

export type PasswordHasher = {
  readonly params: HashParams;
  /** Argon2id PHC string with a random 16-byte salt. */
  hash(password: string): string;
  /** False for a wrong password or a malformed/foreign hash; never throws on bad input. */
  verify(encoded: string, password: string): boolean;
  /** True when `encoded` was made with other parameters and should be replaced (P1-09). */
  needsRehash(encoded: string): boolean;
};

/**
 * Argon2id over the vendored WASM module (D-64).
 *
 * Every operation gets a **fresh** WebAssembly instance: on Workers a request can be cut
 * off mid-hash (CPU limit), which leaves a reused instance's heap corrupted and makes every
 * later call on that isolate fail (docs/spikes/PHASE1_HASHING.md). Instantiating a compiled
 * module is synchronous and cheap; the cost is re-allocating the hash memory.
 */
export function createPasswordHasher(wasmModule: WebAssembly.Module, params: HashParams): PasswordHasher {
  const fresh = () => new Argon2(new WebAssembly.Instance(wasmModule));

  return {
    params,
    hash(password) {
      if (password.length > MAX_PASSWORD_LENGTH) throw new Error("Password is too long");
      return fresh().hash(password, {
        memoryCost: params.memoryKib,
        timeCost: params.iterations,
        parallelism: params.parallelism,
        hashLength: 32,
        type: Argon2Type.Argon2id,
        version: Argon2Version.Version13,
      }).encoded;
    },
    verify(encoded, password) {
      if (password.length > MAX_PASSWORD_LENGTH || !encoded.startsWith("$argon2id$")) return false;
      return fresh().tryVerify(encoded, password, Argon2Type.Argon2id).success;
    },
    needsRehash(encoded) {
      return needsRehash(encoded, params);
    },
  };
}
