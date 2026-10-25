import "server-only";
import { headers } from "next/headers";
import { getDb } from "@/db/request";
import { createFileStore, fileStoreConfigFrom, type FileStore } from "@/lib/r2";
import type { RequestMeta } from "@/modules/shared/context";
import type { ActionDeps } from "./action-core";
import { getPasswordHasher } from "./password";
import { readSessionToken } from "./session-cookie";

/** Client IP and device for login events (P1-07). Cloudflare sets cf-connecting-ip. */
export async function requestMeta(): Promise<RequestMeta> {
  const h = await headers();
  const ip = h.get("cf-connecting-ip") ?? h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? h.get("x-real-ip");
  return { ip: ip || null, userAgent: h.get("user-agent") };
}

let fileStore: FileStore | null | undefined;

/** R2 from the environment, built once per isolate (it holds no connection). */
export function getFileStore(): FileStore | null {
  if (fileStore === undefined) {
    const config = fileStoreConfigFrom(process.env);
    fileStore = config ? createFileStore(config) : null;
  }
  return fileStore;
}

export async function actionDeps(): Promise<ActionDeps> {
  return {
    db: getDb(),
    hasher: getPasswordHasher(),
    now: new Date(),
    files: getFileStore(),
    sessionToken: await readSessionToken(),
    requestMeta: await requestMeta(),
  };
}
