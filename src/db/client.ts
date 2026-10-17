import { neonConfig, Pool } from "@neondatabase/serverless";
import { drizzle, type NeonDatabase } from "drizzle-orm/neon-serverless";
import * as schema from "./schema";

export type Db = NeonDatabase<typeof schema>;

export type DbHandle = {
  db: Db;
  close: () => Promise<void>;
};

type CreateDbOptions = {
  /** host:port of a local Neon wsproxy (docker compose); unset for real Neon. */
  localWsProxy?: string;
};

/**
 * Creates a WebSocket-backed connection (supports interactive transactions).
 * On Workers a connection must not outlive the request that created it, so callers
 * create one per request and close it when the request is done.
 */
export function createDb(connectionString: string, options: CreateDbOptions = {}): DbHandle {
  if (options.localWsProxy) {
    const proxy = options.localWsProxy;
    neonConfig.wsProxy = () => `${proxy}/v1`;
    neonConfig.useSecureWebSocket = false;
    neonConfig.pipelineTLS = false;
    neonConfig.pipelineConnect = false;
  }
  const pool = new Pool({ connectionString });
  // Idle-connection errors (e.g. the socket dropping at request end) are emitted as
  // events; without a listener they surface as uncaught errors in the Workers runtime.
  pool.on("error", (error: Error) => {
    console.error("database pool error:", error.message);
  });
  const db = drizzle({ client: pool, schema });
  return { db, close: () => pool.end() };
}
