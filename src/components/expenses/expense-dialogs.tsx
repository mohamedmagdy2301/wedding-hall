"use client";

import { useId, useState } from "react";
import { Field, FormError } from "@/components/forms/field";
import { useServerAction } from "@/components/forms/use-server-action";
import { DialogShell } from "@/components/payments/payments-panel";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { formatPiasters } from "@/domain/money";
import { fill, t } from "@/lib/i18n";
import { createExpenseAction, voidExpenseAction } from "@/server/actions/expenses";

const te = t.expenses;

export type CategoryOption = { id: string; name: string; isActive: boolean };

/** UF-10: category, amount, day (up to today — Q10-01), description, optional booking number (Q10-02). */
export function AddExpenseDialog(props: {
  categories: CategoryOption[];
  today: string;
  /** From the booking page: the number is fixed. */
  bookingNo?: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const action = useServerAction(createExpenseAction);
  const active = props.categories.filter((c) => c.isActive);
  const selectId = useId();
  const [categoryId, setCategoryId] = useState(active[0]?.id ?? "");
  const [amount, setAmount] = useState("");
  const [spentOn, setSpentOn] = useState(props.today);
  const [description, setDescription] = useState("");
  const [bookingNo, setBookingNo] = useState(props.bookingNo ?? "");
  const errors = action.error?.fieldErrors ?? {};

  return (
    <DialogShell
      testId="add-expense-dialog"
      title={props.bookingNo ? fill(te.addForBooking, { no: props.bookingNo }) : te.addTitle}
      description={te.hint}
      onClose={props.onClose}
      footer={
        <Button
          disabled={action.pending || active.length === 0}
          onClick={() => action.run({ categoryId, amount, spentOn, description, bookingNo }, props.onDone)}
          data-testid="expense-submit"
        >
          {action.pending ? t.common.saving : t.common.save}
        </Button>
      }
    >
      {active.length === 0 && <p className="text-sm text-destructive">{te.noCategories}</p>}
      <div className="grid gap-1.5">
        <Label htmlFor={selectId}>{te.category}</Label>
        <Select value={categoryId} onValueChange={setCategoryId}>
          <SelectTrigger
            id={selectId}
            className="w-full sm:w-72"
            data-testid="expense-category"
            aria-invalid={errors.categoryId ? true : undefined}
          >
            <SelectValue placeholder={te.chooseCategory} />
          </SelectTrigger>
          <SelectContent>
            {active.map((c) => (
              <SelectItem key={c.id} value={c.id}>
                {c.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {errors.categoryId && <p className="text-xs text-destructive">{errors.categoryId}</p>}
      </div>
      <Field
        label={te.amount}
        inputMode="decimal"
        value={amount}
        onChange={(e) => setAmount(e.target.value)}
        error={errors.amount}
        data-testid="expense-amount"
      />
      <Field
        label={te.spentOn}
        type="date"
        max={props.today}
        value={spentOn}
        onChange={(e) => setSpentOn(e.target.value)}
        hint={te.spentOnHint}
        error={errors.spentOn}
        data-testid="expense-date"
      />
      <Field
        label={te.description}
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        error={errors.description}
        maxLength={300}
        data-testid="expense-description"
      />
      {!props.bookingNo && (
        <Field
          label={te.bookingNo}
          dir="ltr"
          value={bookingNo}
          onChange={(e) => setBookingNo(e.target.value)}
          hint={te.bookingNoHint}
          error={errors.bookingNo}
          data-testid="expense-booking-no"
        />
      )}
      <FormError error={action.error} />
    </DialogShell>
  );
}

/** BR-95: voided once, with its reason. */
export function VoidExpenseDialog(props: {
  expense: { id: string; amount: number };
  onClose: () => void;
  onDone: () => void;
}) {
  const action = useServerAction(voidExpenseAction);
  const [reason, setReason] = useState("");
  return (
    <DialogShell
      testId="void-expense-dialog"
      title={fill(te.voidTitle, { amount: formatPiasters(props.expense.amount) })}
      description={te.voidDescription}
      onClose={props.onClose}
      footer={
        <Button
          variant="destructive"
          disabled={action.pending}
          onClick={() => action.run({ expenseId: props.expense.id, reason }, props.onDone)}
          data-testid="void-expense-submit"
        >
          {action.pending ? t.common.saving : te.voidConfirm}
        </Button>
      }
    >
      <Field
        label={te.voidReason}
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        error={action.error?.fieldErrors?.reason}
        maxLength={300}
        data-testid="void-expense-reason"
      />
      <FormError error={action.error} />
    </DialogShell>
  );
}
