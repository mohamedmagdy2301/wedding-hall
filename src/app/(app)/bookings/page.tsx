import { Plus } from "lucide-react";
import Link from "next/link";
import { BookingsFilters } from "@/components/bookings/bookings-filters";
import { StatusBadge } from "@/components/bookings/status-badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatPiasters } from "@/domain/money";
import { t } from "@/lib/i18n";
import { formatCairoTime, formatIsoDate } from "@/lib/time";
import { bookingListSchema } from "@/modules/bookings/schemas";
import { getBookingsPageData } from "@/server/dal";

const tb = t.bookings;

/** S-05 (`bookings.view`). Filters come from the URL and are validated before use (SEC-20); invalid ones are dropped. */
export default async function BookingsPage({ searchParams }: PageProps<"/bookings">) {
  const raw = await searchParams;
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) || undefined;
  const pick = (key: string) => {
    const value = one(raw[key]);
    return bookingListSchema.shape[key as keyof typeof bookingListSchema.shape].safeParse(value).success
      ? value
      : undefined;
  };
  const filters = bookingListSchema.parse({
    search: pick("search"),
    status: pick("status"),
    spaceId: pick("spaceId"),
    slotKind: pick("slotKind"),
    from: pick("from"),
    to: pick("to"),
    page: pick("page"),
  });
  const data = await getBookingsPageData(filters);
  const pages = Math.max(1, Math.ceil(data.total / data.pageSize));
  const query = (page: number) => {
    const params = new URLSearchParams();
    for (const key of ["search", "status", "spaceId", "slotKind", "from", "to"] as const) {
      const value = filters[key];
      if (value) params.set(key, value);
    }
    params.set("page", String(page));
    return `/bookings?${params.toString()}`;
  };

  return (
    <section className="grid gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-bold">{tb.listTitle}</h1>
        {data.canCreate && (
          <Button asChild className="ms-auto">
            <Link href="/bookings/new">
              <Plus />
              {t.shell.newBooking}
            </Link>
          </Button>
        )}
      </div>
      <BookingsFilters spaces={data.spaces} values={filters} />
      <div className="overflow-x-auto rounded-lg border bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{tb.number}</TableHead>
              <TableHead>{tb.date}</TableHead>
              <TableHead>{tb.space}</TableHead>
              <TableHead>{tb.slot}</TableHead>
              <TableHead>{tb.customer}</TableHead>
              <TableHead>{tb.total}</TableHead>
              <TableHead>{tb.status}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.rows.length === 0 && (
              <TableRow>
                <TableCell colSpan={7} className="text-muted-foreground">
                  {tb.empty}
                </TableCell>
              </TableRow>
            )}
            {data.rows.map((row) => (
              <TableRow key={row.id} data-testid="booking-row">
                <TableCell>
                  <Link
                    href={`/bookings/${row.id}`}
                    className="font-medium underline-offset-4 hover:underline"
                    dir="ltr"
                  >
                    {row.bookingNo}
                  </Link>
                </TableCell>
                <TableCell className="whitespace-nowrap">
                  {formatIsoDate(row.eventDate)}{" "}
                  <span className="text-muted-foreground">{formatCairoTime(row.startsAt)}</span>
                </TableCell>
                <TableCell>{row.spaceName}</TableCell>
                <TableCell>{tb.slotKinds[row.slotKind]}</TableCell>
                <TableCell>
                  {row.customerName}{" "}
                  <span className="text-xs text-muted-foreground" dir="ltr">
                    {row.customerPhone}
                  </span>
                </TableCell>
                <TableCell className="whitespace-nowrap tabular-nums">
                  {row.total === null ? (
                    <span className="text-muted-foreground">{tb.noPrice}</span>
                  ) : (
                    formatPiasters(row.total)
                  )}
                </TableCell>
                <TableCell>
                  <StatusBadge status={row.displayStatus} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      {pages > 1 && (
        <nav className="flex items-center gap-3 text-sm">
          <Button asChild variant="outline" size="sm" disabled={data.page <= 1}>
            <Link href={query(Math.max(1, data.page - 1))} aria-disabled={data.page <= 1}>
              {t.audit.previous}
            </Link>
          </Button>
          <span>
            {t.audit.page} {data.page} {t.audit.of} {pages}
          </span>
          <Button asChild variant="outline" size="sm">
            <Link href={query(Math.min(pages, data.page + 1))} aria-disabled={data.page >= pages}>
              {t.audit.next}
            </Link>
          </Button>
        </nav>
      )}
    </section>
  );
}
