import * as nodeCrypto from "node:crypto";
import Argon2, { Argon2Type, Argon2Version } from "@phi-ag/argon2";
import phiWasm from "../../../../../node_modules/@phi-ag/argon2/dist/argon2.wasm?module";
import { argon2id as edgeArgon2id, argon2Verify as edgeArgon2Verify, setWASMModules } from "argon2-wasm-edge";
import edgeArgon2Wasm from "argon2-wasm-edge/wasm/argon2.wasm?module";
import edgeBlake2bWasm from "argon2-wasm-edge/wasm/blake2b.wasm?module";
import { notFound, spikeAuthorized } from "../guard";

/**
 * Step 1.0 (D-58): one hash + one verify per request, so CPU from `wrangler tail`
 * divided by two is the cost of a login. `noop` measures the request overhead.
 */

const PASSWORD = "correct horse battery staple";
const encoder = new TextEncoder();

let phi: Argon2 | undefined;
async function phiArgon2() {
  phi ??= new Argon2(await WebAssembly.instantiate(phiWasm));
  return phi;
}

let edgeReady = false;
function edgeInit() {
  if (!edgeReady) {
    setWASMModules({ argon2WASM: edgeArgon2Wasm, blake2bWASM: edgeBlake2bWasm });
    edgeReady = true;
  }
}

type Argon2Params = { m: number; t: number; p: number };

async function phiHashVerify({ m, t, p }: Argon2Params) {
  const argon2 = await phiArgon2();
  const { encoded } = argon2.hash(PASSWORD, {
    memoryCost: m,
    timeCost: t,
    parallelism: p,
    hashLength: 32,
    type: Argon2Type.Argon2id,
    version: Argon2Version.Version13,
  });
  return { encoded, verified: argon2.tryVerify(encoded, PASSWORD).success };
}

async function edgeHashVerify({ m, t, p }: Argon2Params) {
  edgeInit();
  const encoded = await edgeArgon2id({
    password: PASSWORD,
    salt: crypto.getRandomValues(new Uint8Array(16)),
    memorySize: m,
    iterations: t,
    parallelism: p,
    hashLength: 32,
    outputType: "encoded",
  });
  return { encoded, verified: await edgeArgon2Verify({ password: PASSWORD, hash: encoded }) };
}

type ScryptParams = { N: number; r: number; p: number };

function scryptDerive(salt: Uint8Array, { N, r, p }: ScryptParams): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    nodeCrypto.scrypt(PASSWORD, salt, 32, { N, r, p, maxmem: 160 * 1024 * 1024 }, (err, key) =>
      err ? reject(err) : resolve(key),
    ),
  );
}

async function scryptHashVerify(params: ScryptParams) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const stored = await scryptDerive(salt, params);
  const candidate = await scryptDerive(salt, params);
  return {
    encoded: `scrypt N=${params.N} r=${params.r} p=${params.p}`,
    verified: nodeCrypto.timingSafeEqual(stored, candidate),
  };
}

async function pbkdf2Derive(salt: Uint8Array<ArrayBuffer>, iterations: number) {
  const key = await crypto.subtle.importKey("raw", encoder.encode(PASSWORD), "PBKDF2", false, ["deriveBits"]);
  return new Uint8Array(
    await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, key, 256),
  );
}

async function pbkdf2HashVerify(iterations: number) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const stored = await pbkdf2Derive(salt, iterations);
  const candidate = await pbkdf2Derive(salt, iterations);
  return { encoded: `pbkdf2-sha256 i=${iterations}`, verified: nodeCrypto.timingSafeEqual(stored, candidate) };
}

const PRESETS: Record<string, () => Promise<{ encoded: string; verified: boolean }>> = {
  noop: async () => ({ encoded: "", verified: true }),
  "pbkdf2-100k": () => pbkdf2HashVerify(100_000),
  // OWASP Argon2id: m=19 MiB t=2 p=1, and the m=46 MiB t=1 p=1 alternative; RFC 9106 second choice m=64 MiB t=3 p=4.
  "phi-19m-t2": () => phiHashVerify({ m: 19_456, t: 2, p: 1 }),
  "phi-46m-t1": () => phiHashVerify({ m: 47_104, t: 1, p: 1 }),
  "phi-64m-t3-p4": () => phiHashVerify({ m: 65_536, t: 3, p: 4 }),
  "edge-19m-t2": () => edgeHashVerify({ m: 19_456, t: 2, p: 1 }),
  "edge-46m-t1": () => edgeHashVerify({ m: 47_104, t: 1, p: 1 }),
  // OWASP scrypt: N=2^17 r=8 p=1 needs 128 MiB (the isolate limit); the 64/32 MiB equivalents fit.
  "scrypt-n17-p1": () => scryptHashVerify({ N: 2 ** 17, r: 8, p: 1 }),
  "scrypt-n16-p2": () => scryptHashVerify({ N: 2 ** 16, r: 8, p: 2 }),
  "scrypt-n15-p3": () => scryptHashVerify({ N: 2 ** 15, r: 8, p: 3 }),
};

export async function POST(request: Request) {
  if (!spikeAuthorized(request)) return notFound();
  const preset = new URL(request.url).searchParams.get("preset") ?? "";
  if (preset === "probe") {
    return Response.json({
      nodeArgon2: typeof (nodeCrypto as Record<string, unknown>).argon2,
      nodeScrypt: typeof nodeCrypto.scrypt,
    });
  }
  const run = PRESETS[preset];
  if (!run) return Response.json({ error: "unknown preset", presets: Object.keys(PRESETS) }, { status: 400 });
  try {
    const { encoded, verified } = await run();
    return Response.json({ preset, verified, prefix: encoded.split("$").slice(0, 4).join("$") });
  } catch (error) {
    return Response.json({ preset, error: error instanceof Error ? error.message : "unknown" }, { status: 500 });
  }
}
