import { describe, expect, it } from "vitest";
import { BUNDLED_ENV_FILES, findBundledSecrets } from "../../scripts/lib/bundle-env";

describe("bundled env secret guard (SEC-31)", () => {
  it("covers every env file OpenNext embeds, but not .env.secrets.local", () => {
    expect(BUNDLED_ENV_FILES).toEqual(
      expect.arrayContaining([".env", ".env.local", ".env.production", ".env.development.local"]),
    );
    expect(BUNDLED_ENV_FILES).not.toContain(".env.secrets.local");
  });

  it("flags a non-local database URL and secret-looking keys", () => {
    const problems = findBundledSecrets(".env.local", {
      DATABASE_URL: "postgresql://u:p@ep-x.eu-central-1.aws.neon.tech/neondb",
      SPIKE_TOKEN: "abc",
      R2_SECRET_ACCESS_KEY: "xyz",
    });
    expect(problems).toEqual([
      ".env.local: DATABASE_URL",
      ".env.local: SPIKE_TOKEN",
      ".env.local: R2_SECRET_ACCESS_KEY",
    ]);
  });

  it("allows local docker URLs, empty values and non-secret keys", () => {
    expect(
      findBundledSecrets(".env.development.local", {
        DATABASE_URL: "postgres://postgres:postgres@localhost:54329/wedding_hall_dev",
        NEON_LOCAL_WSPROXY: "localhost:54330",
        SPIKE_TOKEN: "",
      }),
    ).toEqual([]);
  });

  it("never echoes values in its findings (SEC-32)", () => {
    const [finding] = findBundledSecrets(".env", { DATABASE_URL: "postgres://user:topsecret@db.example.com/x" });
    expect(finding).not.toContain("topsecret");
  });
});
