import { AddExpenseButton } from "@/components/expenses/expenses-screen";
import { ExpensesTable } from "@/components/expenses/expenses-table";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatPiasters } from "@/domain/money";
import { t } from "@/lib/i18n";
import { getExpensesPageData } from "@/server/dal";

const te = t.expenses;

/** S-11 (`expenses.view`): filters by period and category, the list, adding, voiding, and the period's profit. */
export default async function ExpensesPage({ searchParams }: PageProps<"/expenses">) {
  const raw = await searchParams;
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) || undefined;
  const data = await getExpensesPageData({ from: one(raw.from), to: one(raw.to), categoryId: one(raw.categoryId) });

  return (
    <section className="grid gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-bold">{te.title}</h1>
        {data.canRecord && (
          <div className="ms-auto">
            <AddExpenseButton categories={data.categories} today={data.today} />
          </div>
        )}
      </div>
      <p className="text-sm text-muted-foreground">{te.hint}</p>
      <form method="get" className="flex flex-wrap items-end gap-3 rounded-lg border bg-card p-4">
        <div className="grid gap-1.5">
          <Label htmlFor="expenses-from">{te.from}</Label>
          <Input id="expenses-from" type="date" name="from" defaultValue={data.filters.from} />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="expenses-to">{te.to}</Label>
          <Input id="expenses-to" type="date" name="to" defaultValue={data.filters.to} />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="expenses-category">{te.category}</Label>
          <select
            id="expenses-category"
            name="categoryId"
            defaultValue={data.filters.categoryId ?? ""}
            className="h-9 rounded-md border bg-transparent px-3 text-sm"
          >
            <option value="">{te.allCategories}</option>
            {data.categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </div>
        <Button type="submit">{te.apply}</Button>
      </form>

      {data.summary && (
        <Card className="py-4" data-testid="period-profit">
          <CardContent className="grid gap-2 px-4 text-sm">
            <h2 className="font-medium">{te.summaryTitle}</h2>
            <dl className="grid gap-x-4 gap-y-1 sm:grid-cols-[12rem_1fr]">
              <dt className="text-muted-foreground">{te.collected}</dt>
              <dd className="tabular-nums" data-testid="period-collected">
                {formatPiasters(data.summary.collected)}
              </dd>
              <dt className="text-muted-foreground">{te.total}</dt>
              <dd className="tabular-nums">{formatPiasters(data.summary.expenses)}</dd>
              <dt className="text-muted-foreground">{te.net}</dt>
              <dd className="font-bold tabular-nums" data-testid="period-net">
                {formatPiasters(data.summary.net)}
              </dd>
            </dl>
            <p className="text-xs text-muted-foreground">{te.collectedHint}</p>
          </CardContent>
        </Card>
      )}

      {data.rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">{te.empty}</p>
      ) : (
        <ExpensesTable rows={data.rows} canVoid={data.canVoid} />
      )}
      <p className="text-sm" data-testid="expenses-total">
        <span className="text-muted-foreground">{te.total}: </span>
        <span className="font-medium tabular-nums">{formatPiasters(data.total)}</span>
      </p>
    </section>
  );
}
