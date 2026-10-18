"use client";

import { Printer } from "lucide-react";
import { Button } from "@/components/ui/button";

/** Opens the browser's print dialog (print or save as PDF — CLAUDE.md rule 10). */
export function PrintButton({ label }: { label: string }) {
  return (
    <Button size="sm" onClick={() => window.print()} data-testid="print-receipt">
      <Printer />
      {label}
    </Button>
  );
}
