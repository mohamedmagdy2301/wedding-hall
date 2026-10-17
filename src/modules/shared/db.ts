import type { Db } from "@/db/client";

/** A transaction handle. Audit writes require one (CLAUDE.md rule 7, SEC-41). */
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

export type DbOrTx = Db | Tx;
