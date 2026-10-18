import { cn } from "@/lib/utils";
import type { DisplayStatus } from "@/domain/booking-status";
import { t } from "@/lib/i18n";

/** S-04 status colors, shared by the calendar, the lists and the booking page. */
export const STATUS_STYLES: Record<DisplayStatus, string> = {
  tentative: "border-amber-300 bg-amber-50 text-amber-900 dark:bg-amber-950 dark:text-amber-100",
  conflicting: "border-red-300 bg-red-50 text-red-900 dark:bg-red-950 dark:text-red-100",
  expired: "border-zinc-300 bg-zinc-100 text-zinc-500 dark:bg-zinc-900 dark:text-zinc-400",
  confirmed: "border-emerald-300 bg-emerald-50 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-100",
  completed: "border-sky-300 bg-sky-50 text-sky-900 dark:bg-sky-950 dark:text-sky-100",
  cancelled: "border-zinc-300 bg-zinc-100 text-zinc-500 line-through dark:bg-zinc-900 dark:text-zinc-400",
};

/** `owing`: a completed booking with money still due shows "تم – عليه متبقي" (BR-24, D-23). */
export function StatusBadge({
  status,
  className,
  owing,
}: {
  status: DisplayStatus;
  className?: string;
  owing?: boolean;
}) {
  return (
    <span
      data-testid="booking-status"
      data-status={status}
      data-owing={owing ? "true" : undefined}
      className={cn(
        "inline-flex h-5 items-center rounded-4xl border px-2 text-xs font-medium whitespace-nowrap",
        STATUS_STYLES[status],
        owing && "border-orange-300 bg-orange-50 text-orange-900 dark:bg-orange-950 dark:text-orange-100",
        className,
      )}
    >
      {owing ? t.bookings.completedDue : t.bookings.statuses[status]}
    </span>
  );
}
