import Link from "next/link";
import { z } from "zod";
import { CustomerDialog } from "@/components/customers/customer-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatCount } from "@/lib/digits";
import { t } from "@/lib/i18n";
import { getCustomersPageData } from "@/server/dal";

const tc = t.customers;

const paramsSchema = z.object({
  search: z.string().trim().max(80).catch(""),
  page: z.coerce.number().int().min(1).max(100_000).catch(1),
});

/** S-08 list (`bookings.view`): search by name or mobile (D-106). */
export default async function CustomersPage({ searchParams }: PageProps<"/customers">) {
  const raw = await searchParams;
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) || undefined;
  const params = paramsSchema.parse({ search: one(raw.search) ?? "", page: one(raw.page) ?? 1 });
  const data = await getCustomersPageData(params);
  const pages = Math.max(1, Math.ceil(data.total / data.pageSize));
  const pageHref = (page: number) => `/customers?${new URLSearchParams({ search: params.search, page: String(page) })}`;

  return (
    <section className="grid gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-bold">{tc.title}</h1>
        {data.canManage && (
          <div className="ms-auto">
            <CustomerDialog />
          </div>
        )}
      </div>
      <form method="get" className="flex flex-wrap items-end gap-2 rounded-lg border bg-card p-4">
        <div className="grid flex-1 gap-1.5">
          <label htmlFor="customers-search" className="text-sm font-medium">
            {tc.search}
          </label>
          <Input id="customers-search" name="search" defaultValue={params.search} data-testid="customers-search" />
        </div>
        <Button type="submit">{tc.apply}</Button>
      </form>
      <div className="overflow-x-auto rounded-lg border bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{tc.name}</TableHead>
              <TableHead>{tc.phone}</TableHead>
              <TableHead>{tc.bookings}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.rows.length === 0 && (
              <TableRow>
                <TableCell colSpan={3} className="text-muted-foreground">
                  {tc.empty}
                </TableCell>
              </TableRow>
            )}
            {data.rows.map((c) => (
              <TableRow key={c.id} data-testid="customer-row">
                <TableCell>
                  <Link href={`/customers/${c.id}`} className="font-medium underline-offset-4 hover:underline">
                    {c.name}
                  </Link>
                </TableCell>
                <TableCell dir="ltr" className="text-end">
                  {[c.phone, c.altPhone].filter(Boolean).join(" / ")}
                </TableCell>
                <TableCell>{formatCount(c.bookingCount)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      {pages > 1 && (
        <nav className="flex items-center gap-3 text-sm">
          <Button asChild variant="outline" size="sm">
            <Link href={pageHref(Math.max(1, data.page - 1))}>{t.audit.previous}</Link>
          </Button>
          <span>
            {t.audit.page} {data.page} {t.audit.of} {pages}
          </span>
          <Button asChild variant="outline" size="sm">
            <Link href={pageHref(Math.min(pages, data.page + 1))}>{t.audit.next}</Link>
          </Button>
        </nav>
      )}
    </section>
  );
}
