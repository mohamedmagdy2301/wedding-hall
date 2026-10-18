import { Plus } from "lucide-react";
import Link from "next/link";
import { Suspense } from "react";
import { z } from "zod";
import {
  BookingChip,
  MobileDefaultView,
  SpaceFilter,
  type CalendarBooking,
} from "@/components/calendar/calendar-client";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatCount } from "@/lib/digits";
import { addDays, cairoDate, formatIsoDate, formatIsoMonth, formatIsoWeekday } from "@/lib/time";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { getCalendarPageData } from "@/server/dal";

const tc = t.calendar;
const VIEWS = ["month", "week", "day"] as const;
type View = (typeof VIEWS)[number];

const paramsSchema = z.object({
  view: z.enum(VIEWS).optional().catch(undefined),
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional()
    .catch(undefined),
  space: z.uuid().optional().catch(undefined),
  all: z.literal("1").optional().catch(undefined),
});

/** Saturday on or before the date: the week starts on Saturday (D-104). */
function weekStart(date: string): string {
  const day = new Date(`${date}T00:00:00Z`).getUTCDay(); // Sunday = 0 … Saturday = 6
  return addDays(date, -((day + 1) % 7));
}

function monthStart(date: string): string {
  return `${date.slice(0, 7)}-01`;
}

function addMonths(date: string, months: number): string {
  const [y, m] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1 + months, 1)).toISOString().slice(0, 10);
}

/** The Cairo dates a view shows: a month grid of whole weeks, a week, or one day (≤ 42 days). */
function rangeOf(view: View, date: string): { from: string; to: string; days: string[] } {
  let from: string;
  let to: string;
  if (view === "month") {
    from = weekStart(monthStart(date));
    to = addDays(weekStart(addDays(addMonths(date, 1), -1)), 6);
  } else if (view === "week") {
    from = weekStart(date);
    to = addDays(from, 6);
  } else {
    from = date;
    to = date;
  }
  const days: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) days.push(d);
  return { from, to, days };
}

/**
 * S-04 (`bookings.view`): month, week (spaces × days × day/evening) and day views built on
 * the slots (D-104), colored by status. Expired and cancelled bookings are hidden unless
 * asked. An empty slot starts a booking with its space, date and slot.
 */
export default async function CalendarPage({ searchParams }: PageProps<"/calendar">) {
  const raw = await searchParams;
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) || undefined;
  const params = paramsSchema.parse({
    view: one(raw.view),
    date: one(raw.date),
    space: one(raw.space),
    all: one(raw.all),
  });
  const today = cairoDate(new Date());
  const view: View = params.view ?? "month";
  const date = params.date ?? today;
  const { from, to, days } = rangeOf(view, date);
  const data = await getCalendarPageData({ spaceIds: params.space ? [params.space] : [], from, to });
  const showAll = params.all === "1";
  const spaces = params.space ? data.spaces.filter((s) => s.id === params.space) : data.spaces;
  const visible = data.bookings.filter(
    (b) => showAll || (b.displayStatus !== "expired" && b.displayStatus !== "cancelled"),
  ) as CalendarBooking[];
  const spaceName = new Map(data.spaces.map((s) => [s.id, s.name]));

  const href = (changes: Partial<Record<"view" | "date" | "space" | "all", string | undefined>>) => {
    const next = new URLSearchParams();
    const merged = { view, date, space: params.space, all: params.all, ...changes };
    for (const [key, value] of Object.entries(merged)) if (value) next.set(key, value);
    return `/calendar?${next.toString()}`;
  };
  const step = (direction: 1 | -1) =>
    view === "month" ? addMonths(date, direction) : addDays(date, direction * (view === "week" ? 7 : 1));
  const newHref = (spaceId: string, day: string, slot: string) =>
    `/bookings/new?space=${spaceId}&date=${day}&slot=${slot}`;
  const canStart = (spaceActive: boolean, day: string) => data.canCreate && spaceActive && day >= today;
  const label = (b: CalendarBooking) =>
    `${params.space ? "" : `${spaceName.get(b.spaceId)} · `}${t.bookings.slotKinds[b.slotKind]} · ${b.customerName}`;
  const inHalf = (b: CalendarBooking, half: "day" | "evening") => b.slotKind === half || b.slotKind === "full_day";

  return (
    <section className="grid gap-4">
      <Suspense>
        <MobileDefaultView hasView={params.view !== undefined} />
      </Suspense>
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-bold">{tc.title}</h1>
        <nav className="flex gap-1" aria-label={tc.title}>
          {VIEWS.map((v) => (
            <Button key={v} asChild size="sm" variant={v === view ? "default" : "outline"}>
              <Link href={href({ view: v })} aria-current={v === view ? "page" : undefined}>
                {tc.views[v]}
              </Link>
            </Button>
          ))}
        </nav>
        <div className="flex gap-1">
          <Button asChild size="sm" variant="outline">
            <Link href={href({ date: step(-1) })}>{tc.previous}</Link>
          </Button>
          <Button asChild size="sm" variant="outline">
            <Link href={href({ date: today })}>{tc.today}</Link>
          </Button>
          <Button asChild size="sm" variant="outline">
            <Link href={href({ date: step(1) })}>{tc.next}</Link>
          </Button>
        </div>
        <Suspense>
          <SpaceFilter spaces={data.spaces} value={params.space ?? ""} />
        </Suspense>
        <Button asChild size="sm" variant="ghost">
          <Link href={href({ all: showAll ? undefined : "1" })} data-testid="calendar-show-all">
            {showAll ? tc.hideAll : tc.showAll}
          </Link>
        </Button>
        {data.canCreate && (
          <Button asChild size="sm" className="ms-auto">
            <Link href="/bookings/new">
              <Plus />
              {t.shell.newBooking}
            </Link>
          </Button>
        )}
      </div>
      <p className="text-sm text-muted-foreground" data-testid="calendar-range">
        {view === "day"
          ? `${formatIsoWeekday(date)} ${formatIsoDate(date)}`
          : view === "month"
            ? formatIsoMonth(date)
            : `${formatIsoDate(from)} – ${formatIsoDate(to)}`}
      </p>

      {data.spaces.length === 0 && <p className="text-sm text-muted-foreground">{tc.noSpaces}</p>}

      {view === "month" && (
        <div className="overflow-x-auto">
          <div
            className="grid min-w-[42rem] grid-cols-7 gap-px rounded-lg border bg-border"
            data-testid="calendar-month"
          >
            {tc.weekdays.map((w) => (
              <div key={w} className="bg-muted px-2 py-1 text-center text-xs font-medium">
                {w}
              </div>
            ))}
            {days.map((day) => {
              const dayBookings = visible.filter((b) => b.eventDate === day);
              const outside = day.slice(0, 7) !== date.slice(0, 7);
              return (
                <div
                  key={day}
                  className={cn("grid min-h-24 content-start gap-1 bg-card p-1.5", outside && "bg-muted/40")}
                >
                  <div className="flex items-center justify-between">
                    <Link
                      href={href({ view: "day", date: day })}
                      className={cn(
                        "text-xs",
                        day === today ? "rounded bg-primary px-1 text-primary-foreground" : "text-muted-foreground",
                      )}
                    >
                      {formatCount(Number(day.slice(8)))}
                    </Link>
                    {data.canCreate && day >= today && (
                      <Link
                        href={`/bookings/new?date=${day}${params.space ? `&space=${params.space}` : ""}`}
                        aria-label={`${tc.newHere} ${day}`}
                        className="text-xs text-muted-foreground hover:text-foreground"
                      >
                        <Plus className="size-3.5" />
                      </Link>
                    )}
                  </div>
                  {dayBookings.map((b) => (
                    <BookingChip key={b.id} booking={b} label={label(b)} />
                  ))}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {view === "week" && (
        <div className="overflow-x-auto rounded-lg border bg-card">
          <table className="w-full min-w-[56rem] table-fixed border-collapse text-sm" data-testid="calendar-week">
            <thead>
              <tr>
                <th className="w-32 border-b p-2 text-start font-medium">{tc.space}</th>
                {days.map((day, i) => (
                  <th key={day} className={cn("border-b p-2 text-center font-medium", day === today && "bg-muted")}>
                    <div>{tc.weekdays[i]}</div>
                    <div className="text-xs font-normal text-muted-foreground">{formatIsoDate(day)}</div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {spaces.map((space) => (
                <tr key={space.id}>
                  <th className="border-b p-2 text-start align-top font-medium">{space.name}</th>
                  {days.map((day) => (
                    <td key={day} className="border-b border-s p-1 align-top">
                      {(["day", "evening"] as const).map((half) => {
                        const here = visible.filter(
                          (b) => b.spaceId === space.id && b.eventDate === day && inHalf(b, half),
                        );
                        return (
                          <div
                            key={half}
                            className="grid min-h-10 gap-1 border-b border-dashed py-1 last:border-b-0"
                            data-testid={`cell-${space.id}-${day}-${half}`}
                          >
                            <span className="text-[10px] text-muted-foreground">{t.bookings.slotKinds[half]}</span>
                            {here.map((b) => (
                              <BookingChip key={b.id} booking={b} label={b.customerName} />
                            ))}
                            {here.length === 0 && canStart(space.isActive, day) && (
                              <Link
                                href={newHref(space.id, day, half)}
                                className="text-xs text-muted-foreground hover:text-foreground"
                                data-testid="calendar-new"
                              >
                                + {tc.newHere}
                              </Link>
                            )}
                          </div>
                        );
                      })}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {view === "day" && (
        <div className="grid gap-3 sm:grid-cols-2" data-testid="calendar-day">
          {spaces.map((space) => (
            <Card key={space.id} className="gap-3 py-4">
              <CardHeader className="px-4">
                <CardTitle className="text-base">{space.name}</CardTitle>
              </CardHeader>
              <CardContent className="grid gap-3 px-4">
                {(["day", "evening"] as const).map((half) => {
                  const here = visible.filter((b) => b.spaceId === space.id && b.eventDate === date && inHalf(b, half));
                  const slot = space[half];
                  return (
                    <div key={half} className="grid gap-1.5">
                      <p className="text-sm font-medium">
                        {t.bookings.slotKinds[half]}{" "}
                        <span className="text-xs font-normal text-muted-foreground" dir="ltr">
                          {slot.start} – {slot.end}
                        </span>
                      </p>
                      {here.map((b) => (
                        <BookingChip
                          key={b.id}
                          booking={b}
                          label={`${b.customerName} · ${t.bookings.slotKinds[b.slotKind]}`}
                        />
                      ))}
                      {here.length === 0 && canStart(space.isActive, date) && (
                        <Link
                          href={newHref(space.id, date, half)}
                          className="text-sm text-muted-foreground hover:text-foreground"
                          data-testid="calendar-new"
                        >
                          + {tc.newHere}
                        </Link>
                      )}
                    </div>
                  );
                })}
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </section>
  );
}
