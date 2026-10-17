import { config } from "dotenv";

// Scripts run outside Next.js. Secrets live in .env.secrets.local, which Next.js and
// OpenNext never read (so they are never embedded in the Worker bundle).
config({ path: [".env.secrets.local", ".env.local", ".env"], quiet: true });

export function requireEnv(...names: string[]): string {
  for (const name of names) {
    const value = process.env[name];
    if (value) return value;
  }
  throw new Error(`Missing environment variable: ${names.join(" or ")}`);
}
