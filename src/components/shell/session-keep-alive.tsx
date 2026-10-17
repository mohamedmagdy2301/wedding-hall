"use client";

import { useEffect } from "react";
import { refreshSessionAction } from "@/server/actions/auth";

const KEY = "session-cookie-refreshed-at";
const INTERVAL_MS = 60 * 60 * 1000;

/**
 * The session slides in the database on every request (T-17), but a cookie can only be
 * re-issued by a Server Action. At most once an hour per tab, re-issue it with the slid expiry.
 */
export function SessionKeepAlive() {
  useEffect(() => {
    let last = 0;
    try {
      last = Number(sessionStorage.getItem(KEY) ?? 0);
    } catch {
      // Storage unavailable: refresh anyway.
    }
    if (Date.now() - last < INTERVAL_MS) return;
    void refreshSessionAction().then((result) => {
      if (!result.ok) return;
      try {
        sessionStorage.setItem(KEY, String(Date.now()));
      } catch {
        // Ignore.
      }
    });
  }, []);
  return null;
}
