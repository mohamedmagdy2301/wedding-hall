"use client";

import { AlertTriangle } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { ConfirmDialog } from "@/components/forms/confirm-dialog";
import { useServerAction } from "@/components/forms/use-server-action";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { DisplayStatus } from "@/domain/booking-status";
import { formatPiasters } from "@/domain/money";
import { formatCount } from "@/lib/digits";
import { fill, t } from "@/lib/i18n";
import { formatCairoDateTime, formatCairoTime, formatIsoDate, formatIsoWeekday } from "@/lib/time";
import { extendTentativeAction } from "@/server/actions/bookings";
import { PriceBreakdownView, type BreakdownView } from "./price-breakdown";
import { StatusBadge } from "./status-badge";

const tp = t.bookings.page;
const auditActions: Record<string, string> = t.audit.actions;
const fieldLabels: Record<string, string> = tp.fields;

type Line = BreakdownView["lines"][number] & { externalFee: number };

export type BookingViewData = {
  booking: {
    id: string;
    bookingNo: string;
    status: string;
    version: number;
    spaceName: string;
    slotKind: "day" | "evening" | "full_day";
    startsAt: Date;
    endsAt: Date;
    tentativeExpiresAt: Date | null;
    customerId: string;
    customerName: string;
    customerPhone: string;
    customerAltPhone: string | null;
    eventTypeName: string | null;
    groomName: string | null;
    brideName: string | null;
    packageName: string | null;
    guests: number | null;
    seasonName: string | null;
    basePrice: number | null;
    extraGuestPrice: number | null;
    baseGuests: number | null;
    extraGuestsAmount: number | null;
    itemsTotal: number | null;
    removalCreditsTotal: number | null;
    discountAmount: number | null;
    total: number | null;
    notes: string | null;
    createdAt: Date;
    createdByName: string;
    eventDate: string;
    displayStatus: DisplayStatus;
  };
  lines: Line[];
  confirmedConflicts: { id: string; bookingNo: string }[];
  history: {
    id: string;
    at: Date;
    actorName: string | null;
    action: string;
    changes: { field: string; before: unknown; after: unknown }[];
  }[];
  canEdit: boolean;
  holdHours: number;
};

function show(field: string, value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  if (field === "total" && typeof value === "number") return formatPiasters(value);
  if (field === "slotKind" && typeof value === "string") return t.bookings.slotKinds[value as "day"] ?? value;
  if (field === "status" && typeof value === "string") return t.bookings.statuses[value as DisplayStatus] ?? value;
  if (Array.isArray(value)) return value.length === 0 ? "—" : value.join("، ");
  return String(value);
}

/** S-07: the booking's header, actions and tabs (summary, items and price, history — D-108). */
export function BookingView({ data }: { data: BookingViewData }) {
  const router = useRouter();
  const { booking: b } = data;
  const [extending, setExtending] = useState(false);
  const extend = useServerAction(extendTentativeAction);
  const isTentative = b.status === "tentative";

  const breakdown: BreakdownView | null =
    b.total === null
      ? null
      : {
          basePrice: b.basePrice ?? 0,
          seasonal: b.seasonName !== null,
          extraGuests: b.guests !== null && b.baseGuests !== null ? Math.max(0, b.guests - b.baseGuests) : 0,
          extraGuestPrice: b.extraGuestPrice ?? 0,
          extraGuestsAmount: b.extraGuestsAmount ?? 0,
          lines: data.lines,
          itemsTotal: b.itemsTotal ?? 0,
          externalFeesTotal: data.lines.filter((l) => l.isExternal).reduce((sum, l) => sum + l.externalFee, 0),
          removalCreditsTotal: b.removalCreditsTotal ?? 0,
          subtotal: b.total + (b.discountAmount ?? 0),
          discountAmount: b.discountAmount ?? 0,
          total: b.total,
        };

  return (
    <section className="grid gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-bold" dir="ltr">
          {b.bookingNo}
        </h1>
        <StatusBadge status={b.displayStatus} />
        <div className="ms-auto flex gap-2">
          {isTentative && data.canEdit && (
            <>
              <Button variant="outline" onClick={() => setExtending(true)} data-testid="extend-booking">
                {tp.extend}
              </Button>
              <Button asChild>
                <Link href={`/bookings/${b.id}/edit`}>{tp.edit}</Link>
              </Button>
            </>
          )}
        </div>
      </div>

      <Card className="py-4">
        <CardContent className="grid gap-2 px-4 text-sm sm:grid-cols-2">
          <p>
            <span className="text-muted-foreground">{t.bookings.space}: </span>
            {b.spaceName} — {t.bookings.slotKinds[b.slotKind]}
          </p>
          <p>
            <span className="text-muted-foreground">{t.bookings.date}: </span>
            {formatIsoWeekday(b.eventDate)} {formatIsoDate(b.eventDate)} ({formatCairoTime(b.startsAt)} –{" "}
            {formatCairoTime(b.endsAt)})
          </p>
          <p>
            <span className="text-muted-foreground">{t.bookings.customer}: </span>
            <Link href={`/customers/${b.customerId}`} className="underline-offset-4 hover:underline">
              {b.customerName}
            </Link>{" "}
            <span dir="ltr">{b.customerPhone}</span>
          </p>
          <p data-testid="booking-total">
            <span className="text-muted-foreground">{t.bookings.total}: </span>
            {b.total === null ? t.bookings.noPrice : formatPiasters(b.total)}
          </p>
          {isTentative && b.tentativeExpiresAt && (
            <p className="sm:col-span-2" data-testid="booking-expiry">
              <span className="text-muted-foreground">
                {b.displayStatus === "expired" ? tp.expired : tp.expiresAt}:{" "}
              </span>
              {formatCairoDateTime(b.tentativeExpiresAt)}
            </p>
          )}
        </CardContent>
      </Card>

      {data.confirmedConflicts.length > 0 && b.displayStatus === "conflicting" && (
        <Alert variant="destructive" data-testid="booking-conflict">
          <AlertTriangle />
          <AlertDescription>
            {fill(tp.conflict, { numbers: data.confirmedConflicts.map((c) => c.bookingNo).join("، ") })}
          </AlertDescription>
        </Alert>
      )}

      <Tabs defaultValue="summary" dir="rtl">
        <TabsList>
          <TabsTrigger value="summary">{tp.tabs.summary}</TabsTrigger>
          <TabsTrigger value="items">{tp.tabs.items}</TabsTrigger>
          <TabsTrigger value="history">{tp.tabs.history}</TabsTrigger>
        </TabsList>
        <TabsContent value="summary">
          <Card className="py-4">
            <CardContent className="px-4">
              <dl className="grid gap-x-4 gap-y-2 text-sm sm:grid-cols-[10rem_1fr]">
                <dt className="text-muted-foreground">{tp.eventType}</dt>
                <dd>{b.eventTypeName ?? "—"}</dd>
                {(b.groomName || b.brideName) && (
                  <>
                    <dt className="text-muted-foreground">{tp.groom}</dt>
                    <dd>{b.groomName ?? "—"}</dd>
                    <dt className="text-muted-foreground">{tp.bride}</dt>
                    <dd>{b.brideName ?? "—"}</dd>
                  </>
                )}
                <dt className="text-muted-foreground">{tp.package}</dt>
                <dd>{b.packageName ?? "—"}</dd>
                <dt className="text-muted-foreground">{tp.guests}</dt>
                <dd>{b.guests === null ? "—" : formatCount(b.guests)}</dd>
                <dt className="text-muted-foreground">{tp.phones}</dt>
                <dd dir="ltr" className="text-end sm:text-start">
                  {[b.customerPhone, b.customerAltPhone].filter(Boolean).join(" / ")}
                </dd>
                <dt className="text-muted-foreground">{tp.notes}</dt>
                <dd className="whitespace-pre-wrap">{b.notes ?? "—"}</dd>
                <dt className="text-muted-foreground">{tp.createdBy}</dt>
                <dd>
                  {b.createdByName} — {formatCairoDateTime(b.createdAt)}
                </dd>
              </dl>
              <p className="mt-4 text-xs text-muted-foreground">{tp.paymentsLater}</p>
            </CardContent>
          </Card>
        </TabsContent>
        <TabsContent value="items">
          <Card className="py-4">
            <CardContent className="px-4">
              {breakdown ? (
                <PriceBreakdownView breakdown={breakdown} />
              ) : (
                <p className="text-sm text-muted-foreground">{t.bookings.noPrice}</p>
              )}
            </CardContent>
          </Card>
        </TabsContent>
        <TabsContent value="history">
          <Card className="py-4">
            <CardContent className="px-4">
              {data.history.length === 0 && <p className="text-sm text-muted-foreground">{tp.historyEmpty}</p>}
              <ol className="grid gap-3 text-sm" data-testid="booking-history">
                {data.history.map((h) => (
                  <li key={h.id} className="grid gap-1 border-b pb-3 last:border-b-0">
                    <p>
                      <span className="font-medium">{auditActions[h.action] ?? h.action}</span>
                      <span className="text-muted-foreground">
                        {" "}
                        — {h.actorName ?? t.audit.system} — {formatCairoDateTime(h.at)}
                      </span>
                    </p>
                    {h.changes.length > 0 && (
                      <ul className="grid gap-0.5 ps-4 text-muted-foreground">
                        {h.changes.map((c) => (
                          <li key={c.field}>
                            {fieldLabels[c.field] ?? c.field}: {show(c.field, c.before)} ← {show(c.field, c.after)}
                          </li>
                        ))}
                      </ul>
                    )}
                  </li>
                ))}
              </ol>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      <ConfirmDialog
        open={extending}
        onOpenChange={setExtending}
        title={`${tp.extendTitle} ${b.bookingNo}`}
        description={fill(tp.extendDescription, { hours: data.holdHours })}
        confirmLabel={tp.extend}
        pending={extend.pending}
        error={extend.error}
        onConfirm={() =>
          extend.run({ bookingId: b.id, version: b.version }, () => {
            setExtending(false);
            router.refresh();
          })
        }
      />
    </section>
  );
}
