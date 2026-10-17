import { describe, expect, it } from "vitest";
import {
  isAtLeastOwasp,
  needsRehash,
  OWASP_ARGON2ID_PROFILES,
  OWASP_DEFAULT,
  parsePhcParams,
  resolveHashConfig,
} from "@/modules/auth/password/params";

const light = { PASSWORD_HASH_MEMORY_KIB: "4096", PASSWORD_HASH_ITERATIONS: "1", PASSWORD_HASH_PARALLELISM: "1" };

describe("password hashing parameters (SEC-01, D-64, D-65)", () => {
  it("defaults to OWASP m=19 MiB, t=2, p=1 in production", () => {
    expect(resolveHashConfig({})).toEqual({ appEnv: "production", params: OWASP_DEFAULT });
    expect(OWASP_DEFAULT).toEqual({ memoryKib: 19_456, iterations: 2, parallelism: 1 });
  });

  it("accepts every OWASP profile and anything stronger", () => {
    for (const p of OWASP_ARGON2ID_PROFILES) {
      expect(isAtLeastOwasp({ ...p, parallelism: 1 })).toBe(true);
      expect(isAtLeastOwasp({ memoryKib: p.memoryKib + 1024, iterations: p.iterations + 1, parallelism: 2 })).toBe(
        true,
      );
    }
  });

  it.each([
    ["19 MiB with one pass", { memoryKib: 19_456, iterations: 1, parallelism: 1 }],
    ["46 MiB minus 1 KiB with one pass", { memoryKib: 47_103, iterations: 1, parallelism: 1 }],
    ["7 MiB with four passes", { memoryKib: 7_168, iterations: 4, parallelism: 1 }],
    ["4 MiB with one pass", { memoryKib: 4_096, iterations: 1, parallelism: 1 }],
  ])("treats %s as weaker than OWASP", (_label, params) => {
    expect(isAtLeastOwasp(params)).toBe(false);
  });

  it.each(["development", "test"])("allows weaker parameters for APP_ENV=%s (D-65)", (appEnv) => {
    expect(resolveHashConfig({ APP_ENV: appEnv, ...light }).params).toEqual({
      memoryKib: 4096,
      iterations: 1,
      parallelism: 1,
    });
  });

  it.each([undefined, "", "production", "staging", "Development"])(
    "refuses weaker parameters when APP_ENV is %s (D-65)",
    (appEnv) => {
      expect(() => resolveHashConfig({ APP_ENV: appEnv, ...light })).toThrow(/weaker than OWASP/);
    },
  );

  it.each([
    ["memory below the floor", { PASSWORD_HASH_MEMORY_KIB: "512" }],
    ["memory above the isolate budget", { PASSWORD_HASH_MEMORY_KIB: "131072" }],
    ["non-integer iterations", { PASSWORD_HASH_ITERATIONS: "2.5" }],
    ["text parallelism", { PASSWORD_HASH_PARALLELISM: "two" }],
  ])("rejects %s", (_label, override) => {
    expect(() => resolveHashConfig({ APP_ENV: "test", ...override })).toThrow(/must be an integer/);
  });

  it("reads parameters back from a PHC string and flags a rehash only when they differ (P1-09)", () => {
    const encoded = "$argon2id$v=19$m=19456,t=2,p=1$c2FsdHNhbHRzYWx0c2FsdA$aGFzaGhhc2hoYXNoaGFzaGhhc2hoYXNoaGFzaGhhc2g";
    expect(parsePhcParams(encoded)).toEqual(OWASP_DEFAULT);
    expect(needsRehash(encoded, OWASP_DEFAULT)).toBe(false);
    expect(needsRehash(encoded, { ...OWASP_DEFAULT, iterations: 3 })).toBe(true);
    expect(needsRehash("$argon2i$v=19$m=19456,t=2,p=1$abc$def", OWASP_DEFAULT)).toBe(true);
    expect(parsePhcParams("not a hash")).toBeNull();
  });
});
