import { AwsClient } from "aws4fetch";
import { z } from "zod";

/**
 * Private files in Cloudflare R2 over its S3 API (ARCHITECTURE, P9-01, P9-02): the server
 * uploads and deletes, and a viewer gets a link signed for a few minutes (SEC-30). Locally
 * and in tests the same code talks to versitygw (docker compose). Built on fetch and
 * WebCrypto only, so it runs on Workers, Node and the test runner alike.
 */
export type FileStore = {
  put(key: string, body: Uint8Array<ArrayBuffer>, contentType: string): Promise<void>;
  /** A GET link that stops working after `expiresSeconds` (checked by R2, not by us). */
  signedGetUrl(key: string, expiresSeconds: number): Promise<string>;
  delete(key: string): Promise<void>;
};

const configSchema = z.object({
  R2_ENDPOINT: z.url(),
  R2_BUCKET: z.string().regex(/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/),
  // R2 takes `auto`; versitygw wants `us-east-1`.
  R2_REGION: z.string().min(1).default("auto"),
  R2_ACCESS_KEY_ID: z.string().min(1),
  R2_SECRET_ACCESS_KEY: z.string().min(1),
});

export type FileStoreConfig = z.infer<typeof configSchema>;

/** The versitygw service in docker-compose.yml. Its keys are local-only, not secrets. */
export const LOCAL_FILE_STORE: FileStoreConfig = {
  R2_ENDPOINT: "http://localhost:54331",
  R2_BUCKET: "wedding-hall",
  R2_REGION: "us-east-1",
  R2_ACCESS_KEY_ID: "local-dev-key",
  R2_SECRET_ACCESS_KEY: "local-dev-secret",
};

/** `null` when the R2 keys are not set (a venue before its bucket exists); uploads then refuse. */
export function fileStoreConfigFrom(source: Record<string, string | undefined>): FileStoreConfig | null {
  if (!source.R2_ENDPOINT) return source.NODE_ENV === "development" ? LOCAL_FILE_STORE : null;
  const parsed = configSchema.safeParse(source);
  if (!parsed.success) {
    // Only field names are reported; values may be secrets (SEC-32).
    throw new Error(`Invalid R2 environment: ${parsed.error.issues.map((i) => i.path.join(".")).join(", ")}`);
  }
  return parsed.data;
}

export function createFileStore(config: FileStoreConfig): FileStore {
  const client = new AwsClient({
    accessKeyId: config.R2_ACCESS_KEY_ID,
    secretAccessKey: config.R2_SECRET_ACCESS_KEY,
    service: "s3",
    region: config.R2_REGION,
  });
  const base = `${config.R2_ENDPOINT.replace(/\/$/, "")}/${config.R2_BUCKET}`;
  const urlOf = (key: string) => `${base}/${key.split("/").map(encodeURIComponent).join("/")}`;

  const expectOk = async (response: Response, operation: string) => {
    // Drain the body so the connection is released (Workers counts open sockets).
    await response.arrayBuffer();
    if (!response.ok) throw new Error(`R2 ${operation} failed with ${response.status}`);
  };

  return {
    async put(key, body, contentType) {
      const response = await client.fetch(urlOf(key), {
        method: "PUT",
        body,
        headers: { "content-type": contentType, "content-length": String(body.byteLength) },
      });
      await expectOk(response, "put");
    },
    async signedGetUrl(key, expiresSeconds) {
      const url = new URL(urlOf(key));
      url.searchParams.set("X-Amz-Expires", String(expiresSeconds));
      const signed = await client.sign(url.toString(), { method: "GET", aws: { signQuery: true } });
      return signed.url;
    },
    async delete(key) {
      const response = await client.fetch(urlOf(key), { method: "DELETE" });
      // Deleting a key that is already gone is fine.
      if (response.status === 404) return void (await response.arrayBuffer());
      await expectOk(response, "delete");
    },
  };
}

/** Creates the local bucket (versitygw) if missing — for dev, tests and seeding only. */
export async function ensureLocalBucket(config: FileStoreConfig = LOCAL_FILE_STORE): Promise<void> {
  const client = new AwsClient({
    accessKeyId: config.R2_ACCESS_KEY_ID,
    secretAccessKey: config.R2_SECRET_ACCESS_KEY,
    service: "s3",
    region: config.R2_REGION,
  });
  const response = await client.fetch(`${config.R2_ENDPOINT}/${config.R2_BUCKET}`, { method: "PUT" });
  await response.arrayBuffer();
  // 409: the bucket already exists.
  if (!response.ok && response.status !== 409)
    throw new Error(`creating the local bucket failed with ${response.status}`);
}
