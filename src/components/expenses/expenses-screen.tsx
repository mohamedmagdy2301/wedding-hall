"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { t } from "@/lib/i18n";
import { AddExpenseDialog, type CategoryOption } from "./expense-dialogs";

/** S-11's "add an expense" button and dialog (UF-10). */
export function AddExpenseButton(props: { categories: CategoryOption[]; today: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button onClick={() => setOpen(true)} data-testid="add-expense">
        {t.expenses.add}
      </Button>
      {open && (
        <AddExpenseDialog
          categories={props.categories}
          today={props.today}
          onClose={() => setOpen(false)}
          onDone={() => {
            setOpen(false);
            router.refresh();
          }}
        />
      )}
    </>
  );
}
