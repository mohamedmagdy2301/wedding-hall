import { describe, expect, it } from "vitest";
import { parseServerEnv } from "@/lib/env";

describe("parseServerEnv", () => {
  it("accepts a postgres URL and treats an empty proxy as unset", () => {
    const env = parseServerEnv({
      DATABASE_URL: "postgresql://user:pass@host/db?sslmode=require",
      NEON_LOCAL_WSPROXY: "",
    });
    expect(env.DATABASE_URL).toMatch(/^postgresql:\/\//);
    expect(env.NEON_LOCAL_WSPROXY).toBeUndefined();
  });

  it("rejects a missing or non-postgres DATABASE_URL", () => {
    expect(() => parseServerEnv({})).toThrow(/DATABASE_URL/);
    expect(() => parseServerEnv({ DATABASE_URL: "mysql://x" })).toThrow(/DATABASE_URL/);
  });

  it("never includes secret values in the error message (SEC-32)", () => {
    const secret = "https://user:topsecret@host/db";
    expect(() => parseServerEnv({ DATABASE_URL: secret })).toThrow(
      expect.objectContaining({ message: expect.not.stringContaining("topsecret") }),
    );
  });
});
