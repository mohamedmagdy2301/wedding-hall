import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { t } from "@/lib/i18n";
import { formatCairoDateTime } from "@/lib/time";
import type { AuditRow } from "@/modules/audit/service";

const actionLabels: Record<string, string> = t.audit.actions;
const entityLabels: Record<string, string> = t.audit.entities;

function Json({ label, value }: { label: string; value: unknown }) {
  if (value === null || value === undefined) return null;
  return (
    <div className="grid gap-1">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      <pre dir="ltr" className="max-w-full overflow-x-auto rounded-md bg-muted p-2 text-start text-xs">
        {JSON.stringify(value, null, 2)}
      </pre>
    </div>
  );
}

type Props = {
  rows: AuditRow[];
  total: number;
  page: number;
  pageSize: number;
  query: Record<string, string | undefined>;
};

/** S-16 rows with before/after. Times are shown in Cairo time (CLAUDE.md rule 9). */
export function AuditTable({ rows, total, page, pageSize, query }: Props) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const href = (p: number) => {
    const params = new URLSearchParams(Object.entries(query).filter((e): e is [string, string] => Boolean(e[1])));
    params.set("page", String(p));
    return `/audit?${params}`;
  };

  if (rows.length === 0) return <p className="text-muted-foreground">{t.audit.empty}</p>;

  return (
    <div className="grid gap-3">
      <div className="overflow-x-auto rounded-lg border bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t.audit.time}</TableHead>
              <TableHead>{t.audit.actor}</TableHead>
              <TableHead>{t.audit.action}</TableHead>
              <TableHead>{t.audit.entityType}</TableHead>
              <TableHead>{t.audit.details}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.id} className="align-top">
                <TableCell className="whitespace-nowrap">{formatCairoDateTime(row.createdAt)}</TableCell>
                <TableCell>{row.actorName ?? t.audit.system}</TableCell>
                <TableCell>{actionLabels[row.action] ?? row.action}</TableCell>
                <TableCell>{entityLabels[row.entityType] ?? row.entityType}</TableCell>
                <TableCell className="max-w-md">
                  {(row.before !== null || row.after !== null || row.meta !== null) && (
                    <details>
                      <summary className="cursor-pointer text-sm text-primary">{t.audit.details}</summary>
                      <div className="mt-2 grid gap-2">
                        <Json label={t.audit.before} value={row.before} />
                        <Json label={t.audit.after} value={row.after} />
                        <Json label={t.audit.meta} value={row.meta} />
                      </div>
                    </details>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <nav className="flex items-center gap-2 text-sm" aria-label={t.audit.page}>
        <Button
          asChild
          variant="outline"
          size="sm"
          aria-disabled={page <= 1}
          className={page <= 1 ? "pointer-events-none opacity-50" : ""}
        >
          <Link href={href(page - 1)}>{t.audit.previous}</Link>
        </Button>
        <span className="text-muted-foreground">
          {t.audit.page} {page} {t.audit.of} {pages}
        </span>
        <Button
          asChild
          variant="outline"
          size="sm"
          aria-disabled={page >= pages}
          className={page >= pages ? "pointer-events-none opacity-50" : ""}
        >
          <Link href={href(page + 1)}>{t.audit.next}</Link>
        </Button>
      </nav>
    </div>
  );
}
