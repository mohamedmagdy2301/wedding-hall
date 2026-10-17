"use client";

import { useState, useTransition } from "react";
import type { ActionError, ActionResult } from "@/server/action-core";

/** Calls a Server Action and tracks pending state and the returned error (codes from API.md). */
export function useServerAction<I, R>(action: (input: I) => Promise<ActionResult<R>>) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<ActionError | null>(null);

  function run(input: I, onSuccess?: (data: R) => void) {
    startTransition(async () => {
      const result = await action(input);
      if (result.ok) {
        setError(null);
        onSuccess?.(result.data);
      } else {
        setError(result.error);
      }
    });
  }

  return { run, pending, error, clearError: () => setError(null) };
}
