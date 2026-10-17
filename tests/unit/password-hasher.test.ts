import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { describe, expect, it } from "vitest";
import { createPasswordHasher, MAX_PASSWORD_LENGTH } from "@/modules/auth/password/hasher";
import { OWASP_DEFAULT } from "@/modules/auth/password/params";
import { loadArgon2ModuleFromDisk } from "@/modules/auth/password/wasm-node";

const wasmModule = loadArgon2ModuleFromDisk();
const fast = { memoryKib: 1024, iterations: 1, parallelism: 1 };

describe("password hasher (SEC-01, D-64)", () => {
  const hasher = createPasswordHasher(wasmModule, fast);

  it("hashes to an Argon2id PHC string with its parameters and a random salt", () => {
    const a = hasher.hash("كلمة سر طويلة 123");
    const b = hasher.hash("كلمة سر طويلة 123");
    expect(a).toMatch(/^\$argon2id\$v=19\$m=1024,t=1,p=1\$/);
    expect(a).not.toBe(b);
    expect(hasher.verify(a, "كلمة سر طويلة 123")).toBe(true);
    expect(hasher.verify(b, "كلمة سر طويلة 123")).toBe(true);
  });

  it("rejects a wrong password, a malformed hash and a non-Argon2id hash without throwing", () => {
    const encoded = hasher.hash("correct horse");
    expect(hasher.verify(encoded, "correct horsE")).toBe(false);
    expect(hasher.verify("garbage", "correct horse")).toBe(false);
    expect(hasher.verify(encoded.replace("$argon2id$", "$argon2i$"), "correct horse")).toBe(false);
    expect(hasher.verify(encoded.slice(0, -4), "correct horse")).toBe(false);
  });

  it("refuses passwords longer than the maximum", () => {
    const long = "a".repeat(MAX_PASSWORD_LENGTH + 1);
    expect(() => hasher.hash(long)).toThrow();
    expect(hasher.verify(hasher.hash("a".repeat(MAX_PASSWORD_LENGTH)), long)).toBe(false);
  });

  it("verifies hashes made with other parameters and asks for a rehash (P1-09)", () => {
    const owaspHasher = createPasswordHasher(wasmModule, OWASP_DEFAULT);
    const old = hasher.hash("pw-12345678");
    expect(owaspHasher.verify(old, "pw-12345678")).toBe(true);
    expect(owaspHasher.needsRehash(old)).toBe(true);
    expect(owaspHasher.needsRehash(owaspHasher.hash("pw-12345678"))).toBe(false);
  });

  /**
   * Regression guard for docs/spikes/PHASE1_HASHING.md §3a: on Workers a request cut off
   * mid-hash (CPU limit) corrupted the reused WASM instance, so every later login on that
   * isolate failed with "memory access out of bounds". vm's timeout terminates execution
   * inside WASM the same way. A cached-instance implementation fails this test within a
   * few interruptions; the fresh-instance-per-operation design must survive all of them.
   */
  it("keeps working after operations are interrupted mid-hash", () => {
    const strong = createPasswordHasher(wasmModule, OWASP_DEFAULT);
    const encoded = strong.hash("still-valid-123");
    let interrupted = 0;

    for (let i = 0; i < 30; i++) {
      try {
        vm.runInNewContext("run()", { run: () => strong.hash("interrupted") }, { timeout: 1 + (i % 12) });
      } catch (error) {
        expect(String(error)).toMatch(/timed out/);
        interrupted++;
      }
      expect(strong.verify(encoded, "still-valid-123")).toBe(true);
      expect(strong.verify(encoded, "wrong")).toBe(false);
    }

    // The harness must really cut operations off, or the test proves nothing.
    expect(interrupted).toBeGreaterThanOrEqual(25);
    expect(strong.verify(strong.hash("after-interruptions"), "after-interruptions")).toBe(true);
  });

  it("uses the vendored wasm of the exact pinned @phi-ag/argon2 version (D-64)", () => {
    const sha = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
    expect(sha("src/modules/auth/password/vendor/argon2.wasm")).toBe(
      sha("node_modules/@phi-ag/argon2/dist/argon2.wasm"),
    );
    const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { dependencies: Record<string, string> };
    expect(pkg.dependencies["@phi-ag/argon2"]).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
