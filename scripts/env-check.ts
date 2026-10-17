import { config } from "dotenv";

// Prints only each key's name and whether it is set. Never prints values (SEC-32).
const REQUIRED = ["DATABASE_URL", "DATABASE_URL_UNPOOLED"];
const OPTIONAL = ["NEON_LOCAL_WSPROXY", "TEST_DATABASE_URL"];

const loaded: Record<string, string> = {};
config({ path: [".env.secrets.local", ".env.local", ".env"], processEnv: loaded, quiet: true });

const isSet = (name: string) => Boolean(loaded[name] ?? process.env[name]);
const width = Math.max(...[...REQUIRED, ...OPTIONAL].map((n) => n.length));
const line = (name: string, note = "") => `${name.padEnd(width)}  ${isSet(name) ? "set" : "missing"}${note}`;

for (const name of REQUIRED) console.log(line(name));
for (const name of OPTIONAL) console.log(line(name, " (optional)"));

const missing = REQUIRED.filter((name) => !isSet(name));
if (missing.length > 0) process.exit(1);
