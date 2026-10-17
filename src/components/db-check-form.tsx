"use client";

import { useActionState } from "react";
import { checkDatabase, type DbCheckState } from "@/server/actions/db-check";
import { t } from "@/lib/i18n";

const initialState: DbCheckState = { status: "idle" };

export function DbCheckForm() {
  const [state, action, pending] = useActionState(checkDatabase, initialState);

  return (
    <form action={action} className="rounded-lg border border-border bg-surface p-4">
      <h2 className="mb-3 font-medium">{t.dbCheck.title}</h2>
      <button
        type="submit"
        disabled={pending}
        className="rounded-md bg-primary px-4 py-2 text-primary-foreground disabled:opacity-60"
      >
        {pending ? t.dbCheck.pending : t.dbCheck.submit}
      </button>
      <div aria-live="polite" className="mt-3 text-sm" data-testid="db-check-result">
        {state.status === "ok" && (
          <p className="text-success">
            {t.dbCheck.ok} — {t.dbCheck.serverTime}:{" "}
            <time dir="ltr" dateTime={state.serverTime}>
              {state.serverTime}
            </time>
          </p>
        )}
        {state.status === "error" && <p className="text-danger">{t.dbCheck.failed}</p>}
      </div>
    </form>
  );
}
