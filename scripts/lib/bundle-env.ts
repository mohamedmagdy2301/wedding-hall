/**
 * OpenNext embeds the values of Next.js env files into the Worker bundle at build
 * time, so these files must never hold secrets. Shared by check-bundle-env.ts.
 */
export const BUNDLED_ENV_FILES = [
  ".env",
  ".env.local",
  ...["production", "development", "test"].flatMap((m) => [`.env.${m}`, `.env.${m}.local`]),
];

const SECRET_KEY = /(SECRET|TOKEN|PASSWORD|PRIVATE|API_KEY|ACCESS_KEY)/i;
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

function isNonLocalDatabaseUrl(key: string, value: string): boolean {
  if (!/DATABASE_URL/i.test(key) || value === "") return false;
  try {
    return !LOCAL_HOSTS.has(new URL(value).hostname);
  } catch {
    return true;
  }
}

/** Returns "<source>: <KEY>" for each offending key. Never includes values. */
export function findBundledSecrets(source: string, vars: Record<string, string>): string[] {
  return Object.entries(vars)
    .filter(([key, value]) => (SECRET_KEY.test(key) && value !== "") || isNonLocalDatabaseUrl(key, value))
    .map(([key]) => `${source}: ${key}`);
}
