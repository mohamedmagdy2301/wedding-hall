"use client";

import { useEffect, useRef, useState } from "react";
import { t } from "@/lib/i18n";

/** A short "saved" confirmation: call `flash()` after a successful submit. `testId` tells two on one page apart. */
export function useSavedNote(testId = "saved-note") {
  const [visible, setVisible] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  function flash() {
    setVisible(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setVisible(false), 4000);
  }

  const note = (
    <p role="status" className="text-sm text-muted-foreground" data-testid={testId}>
      {visible ? t.settings.saved : ""}
    </p>
  );
  return { flash, note };
}
