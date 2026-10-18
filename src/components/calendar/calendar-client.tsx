"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { STATUS_STYLES, StatusBadge } from "@/components/bookings/status-badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { DisplayStatus } from "@/domain/booking-status";
import { formatPiasters } from "@/domain/money";
import { formatCount } from "@/lib/digits";
import { t } from "@/lib/i18n";
import { formatCairoTime, formatIsoDate } from "@/lib/time";
import { cn } from "@/lib/utils";

const tc = t.calendar;
const ALL = "all";

export type CalendarBooking = {
  id: string;
  bookingNo: string;
  spaceId: string;
  slotKind: "day" | "evening" | "full_day";
  startsAt: Date | string;
  endsAt: Date | string;
  displayStatus: DisplayStatus;
  guests: number | null;
  total: number | null;
  customerName: string;
  eventDate: string;
};

/** A booking in the calendar: colored by status (S-04); a click opens a quick summary. */
export function BookingChip({ booking, label }: { booking: CalendarBooking; label: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        data-testid="calendar-booking"
        data-status={booking.displayStatus}
        className={cn(
          "w-full truncate rounded border px-1.5 py-0.5 text-start text-xs",
          STATUS_STYLES[booking.displayStatus],
        )}
      >
        {label}
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <span dir="ltr">{booking.bookingNo}</span>
              <StatusBadge status={booking.displayStatus} />
            </DialogTitle>
          </DialogHeader>
          <dl className="grid grid-cols-[8rem_1fr] gap-y-1.5 text-sm">
            <dt className="text-muted-foreground">{t.bookings.customer}</dt>
            <dd>{booking.customerName}</dd>
            <dt className="text-muted-foreground">{t.bookings.date}</dt>
            <dd>
              {formatIsoDate(booking.eventDate)} — {t.bookings.slotKinds[booking.slotKind]} (
              {formatCairoTime(booking.startsAt)} – {formatCairoTime(booking.endsAt)})
            </dd>
            <dt className="text-muted-foreground">{t.bookings.page.guests}</dt>
            <dd>{booking.guests === null ? "—" : formatCount(booking.guests)}</dd>
            <dt className="text-muted-foreground">{t.bookings.total}</dt>
            <dd>{booking.total === null ? t.bookings.noPrice : formatPiasters(booking.total)}</dd>
          </dl>
          <DialogFooter>
            <Button asChild>
              <Link href={`/bookings/${booking.id}`}>{tc.open}</Link>
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

/** The space filter: changing it reloads the calendar with the same view and date. */
export function SpaceFilter({ spaces, value }: { spaces: { id: string; name: string }[]; value: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  return (
    <div className="flex items-center gap-2">
      <Label htmlFor="calendar-space" className="shrink-0">
        {tc.space}
      </Label>
      <Select
        value={value || ALL}
        onValueChange={(v) => {
          const next = new URLSearchParams(params.toString());
          if (v === ALL) next.delete("space");
          else next.set("space", v);
          router.push(`${pathname}?${next.toString()}`);
        }}
      >
        <SelectTrigger id="calendar-space" className="w-48" data-testid="calendar-space">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL}>{tc.allSpaces}</SelectItem>
          {spaces.map((s) => (
            <SelectItem key={s.id} value={s.id}>
              {s.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

/** D-104: the day view is the default on phones — applied once when the URL names no view. */
export function MobileDefaultView({ hasView }: { hasView: boolean }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  useEffect(() => {
    if (hasView || window.matchMedia("(min-width: 640px)").matches) return;
    const next = new URLSearchParams(params.toString());
    next.set("view", "day");
    router.replace(`${pathname}?${next.toString()}`);
  }, [hasView, params, pathname, router]);
  return null;
}
