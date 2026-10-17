import { config } from "dotenv";

// Scripts run outside Next.js, so load the same env files it would (.env.local first).
config({ path: [".env.local", ".env"], quiet: true });

export function requireEnv(...names: string[]): string {
  for (const name of names) {
    const value = process.env[name];
    if (value) return value;
  }
  throw new Error(`Missing environment variable: ${names.join(" or ")}`);
}
