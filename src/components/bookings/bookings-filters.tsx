"use client";

import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { DISPLAY_STATUSES } from "@/domain/booking-status";
import { SLOT_KINDS } from "@/domain/catalog";
import { t } from "@/lib/i18n";

const tf = t.bookings.filters;
const ALL = "all";

type Props = {
  spaces: { id: string; name: string }[];
  values: { search: string; status: string; spaceId: string | null; slotKind: string; from: string; to: string };
};

/** S-05 filters as a plain GET form: they live in the URL (like S-16). */
export function BookingsFilters({ spaces, values }: Props) {
  function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    for (const select of event.currentTarget.querySelectorAll<HTMLSelectElement>("select")) {
      if (select.value === ALL) select.disabled = true;
    }
    for (const input of event.currentTarget.querySelectorAll<HTMLInputElement>("input")) {
      if (input.value === "") input.disabled = true;
    }
  }

  const select = (id: string, name: string, label: string, value: string, all: string, items: [string, string][]) => (
    <div className="grid gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Select name={name} defaultValue={value || ALL}>
        <SelectTrigger id={id} className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL}>{all}</SelectItem>
          {items.map(([key, text]) => (
            <SelectItem key={key} value={key}>
              {text}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );

  return (
    <form
      method="get"
      onSubmit={onSubmit}
      className="grid gap-3 rounded-lg border bg-card p-4 sm:grid-cols-3 lg:grid-cols-6 lg:items-end"
    >
      <div className="grid gap-1.5 sm:col-span-3 lg:col-span-2">
        <Label htmlFor="bookings-search">{tf.search}</Label>
        <Input id="bookings-search" name="search" defaultValue={values.search} data-testid="bookings-search" />
      </div>
      {select(
        "bookings-status",
        "status",
        tf.status,
        values.status,
        tf.allStatuses,
        DISPLAY_STATUSES.map((s) => [s, t.bookings.statuses[s]]),
      )}
      {select(
        "bookings-space",
        "spaceId",
        tf.space,
        values.spaceId ?? "",
        tf.allSpaces,
        spaces.map((s) => [s.id, s.name]),
      )}
      {select(
        "bookings-slot",
        "slotKind",
        tf.slot,
        values.slotKind,
        tf.allSlots,
        SLOT_KINDS.map((k) => [k, t.bookings.slotKinds[k]]),
      )}
      <div className="grid gap-1.5">
        <Label htmlFor="bookings-from">{tf.from}</Label>
        <Input id="bookings-from" type="date" name="from" defaultValue={values.from} />
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="bookings-to">{tf.to}</Label>
        <Input id="bookings-to" type="date" name="to" defaultValue={values.to} />
      </div>
      <div className="flex gap-2">
        <Button type="submit">{tf.apply}</Button>
        <Button asChild variant="outline">
          <Link href="/bookings">{tf.reset}</Link>
        </Button>
      </div>
    </form>
  );
}
