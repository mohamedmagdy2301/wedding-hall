import "server-only";
import { after } from "next/server";
import { cache } from "react";
import { getServerEnv } from "@/lib/env";
import { createDb, type Db } from "./client";

/** One connection per request, closed after the response is sent. */
export const getDb = cache((): Db => {
  const env = getServerEnv();
  const { db, close } = createDb(env.DATABASE_URL, { localWsProxy: env.NEON_LOCAL_WSPROXY });
  after(close);
  return db;
});
