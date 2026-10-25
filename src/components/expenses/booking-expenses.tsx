"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { formatPiasters } from "@/domain/money";
import { t } from "@/lib/i18n";
import type { BookingExpenses } from "@/modules/expenses/queries";
import { AddExpenseDialog, type CategoryOption } from "./expense-dialogs";
import { ExpensesTable } from "./expenses-table";

const te = t.expenses;

/** S-07 "ملخص" (D-50, Q10-03): the booking's expenses, their total, and its net for `reports.financial`. */
export function BookingExpensesSection(props: {
  booking: { bookingNo: string };
  expenses: BookingExpenses;
  /** `null` without `expenses.record`. */
  categories: CategoryOption[] | null;
  canVoid: boolean;
  today: string;
}) {
  const router = useRouter();
  const [adding, setAdding] = useState(false);
  const { expenses } = props;
  return (
    <Card className="mt-4 py-4">
      <CardContent className="grid gap-3 px-4" data-testid="booking-expenses">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="font-medium">{te.onBooking}</h2>
          {props.categories && (
            <Button
              size="sm"
              variant="outline"
              className="ms-auto"
              onClick={() => setAdding(true)}
              data-testid="add-expense"
            >
              {te.add}
            </Button>
          )}
        </div>
        {expenses.rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">{te.bookingEmpty}</p>
        ) : (
          <ExpensesTable rows={expenses.rows} canVoid={props.canVoid} showBooking={false} />
        )}
        <dl className="grid gap-x-4 gap-y-1 text-sm sm:grid-cols-[14rem_1fr]">
          <dt className="text-muted-foreground">{te.total}</dt>
          <dd data-testid="booking-expenses-total">{formatPiasters(expenses.total)}</dd>
          {expenses.net && (
            <>
              <dt className="text-muted-foreground">{te.collected}</dt>
              <dd>{formatPiasters(expenses.net.collected)}</dd>
              <dt className="text-muted-foreground">{te.bookingNet}</dt>
              <dd className="font-medium" data-testid="booking-net">
                {formatPiasters(expenses.net.net)}
              </dd>
            </>
          )}
        </dl>
      </CardContent>
      {adding && props.categories && (
        <AddExpenseDialog
          categories={props.categories}
          today={props.today}
          bookingNo={props.booking.bookingNo}
          onClose={() => setAdding(false)}
          onDone={() => {
            setAdding(false);
            router.refresh();
          }}
        />
      )}
    </Card>
  );
}
