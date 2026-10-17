"use client";

import { useEffect, useRef, useState } from "react";
import { t } from "@/lib/i18n";

/** A short "saved" confirmation: call `flash()` after a successful submit. */
export function useSavedNote() {
  const [visible, setVisible] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  function flash() {
    setVisible(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setVisible(false), 4000);
  }

  const note = (
    <p role="status" className="text-sm text-muted-foreground" data-testid="saved-note">
      {visible ? t.settings.saved : ""}
    </p>
  );
  return { flash, note };
}
