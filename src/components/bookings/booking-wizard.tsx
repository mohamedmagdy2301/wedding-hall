"use client";

import { AlertTriangle, Check, Info, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { Field, FormError } from "@/components/forms/field";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { defaultSlotTimes } from "@/domain/booking-time";
import { SLOT_KINDS, type SlotKind } from "@/domain/catalog";
import { formatPiasters } from "@/domain/money";
import type { PriceBreakdown } from "@/domain/pricing";
import { formatCount, toAsciiDigits } from "@/lib/digits";
import { fill, t } from "@/lib/i18n";
import { formatCairoDateTime, isIsoDate } from "@/lib/time";
import { cn } from "@/lib/utils";
import { normalizeEgyptianMobile } from "@/modules/auth/login-id";
import type { BookingFormOptions, TentativeForEdit } from "@/modules/bookings/queries";
import type { ActionError, ActionResult } from "@/server/action-core";
import {
  checkAvailabilityAction,
  createConfirmedAction,
  createTentativeAction,
  lookupCustomerAction,
  updateTentativeAction,
} from "@/server/actions/bookings";
import { quotePriceAction } from "@/server/actions/pricing";
import { ConfirmDepositDialog } from "@/components/payments/confirm-deposit-dialog";
import type { PaymentFormOptions } from "@/modules/payments/queries";
import { PriceBreakdownView, type BreakdownView } from "./price-breakdown";

const tw = t.bookings.wizard;
const NONE = "none";

type Added = { serviceId: string; quantity: string; isExternal: boolean };
type Overlap = { id: string; bookingNo: string };
type Availability = {
  startsAt: string | Date;
  endsAt: string | Date;
  blockedUntil: string | Date;
  intrudesOtherSlot: boolean;
  confirmedConflicts: Overlap[];
  tentativeOverlaps: Overlap[];
};
type Match = { id: string; name: string; phone: string; bookingCount: number };

export type WizardPrefill = { spaceId?: string; date?: string; slot?: SlotKind };

/** Which step shows a field, to jump there when the server refuses it. */
function stepOf(field: string): number {
  if (/^(spaceId|eventDate|slotKind|startTime|endTime)/.test(field)) return 0;
  if (/^(eventTypeId|packageId|guests)/.test(field)) return 1;
  if (/^(items|removedServiceIds)/.test(field)) return 2;
  return 3;
}

const toView = (b: PriceBreakdown): BreakdownView => ({ ...b, seasonal: b.seasonId !== null });

/** `value` once it has been stable for `ms` (live checks while typing). */
function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return debounced;
}

/**
 * A read-only action run live for the current request (null = nothing to ask). Each answer
 * is kept with the request it answers, so a late answer to an old request is never shown.
 */
function useLive<R>(request: object | null, run: (input: unknown) => Promise<ActionResult<R>>, ms: number) {
  const key = request ? JSON.stringify(request) : null;
  const debounced = useDebounced(key, ms);
  const [answer, setAnswer] = useState<{ key: string; result: ActionResult<R> } | null>(null);
  useEffect(() => {
    if (!debounced) return;
    let cancelled = false;
    run(JSON.parse(debounced)).then((result) => {
      if (!cancelled) setAnswer({ key: debounced, result });
    });
    return () => {
      cancelled = true;
    };
  }, [debounced, run]);
  const current = key !== null && answer?.key === key ? answer.result : null;
  return {
    data: current?.ok ? current.data : null,
    error: current && !current.ok ? current.error : null,
    loading: key !== null && answer?.key !== key,
  };
}

/**
 * S-06 (UF-03): the booking wizard in five steps with the live price beside it (below on
 * mobile). "Save as tentative" is available from the first step (D-09); "confirm with a
 * deposit" saves it confirmed at once (BR-23) for whoever may confirm (D-123). The same
 * wizard edits a tentative booking (D-101), which is confirmed from its page.
 */
export function BookingWizard({
  options,
  booking,
  prefill = {},
  canView,
  paymentOptions = null,
}: {
  options: BookingFormOptions;
  booking?: TentativeForEdit;
  prefill?: WizardPrefill;
  canView: boolean;
  paymentOptions?: PaymentFormOptions | null;
}) {
  const router = useRouter();
  const selectableSpaces = options.spaces.filter((s) => s.isActive || s.id === booking?.spaceId);
  const firstSpace =
    options.spaces.find((s) => s.id === prefill.spaceId && s.isActive) ?? selectableSpaces.find((s) => s.isActive);

  const [step, setStep] = useState(0);
  const [spaceId, setSpaceId] = useState(booking?.spaceId ?? firstSpace?.id ?? "");
  const [eventDate, setEventDate] = useState(booking?.eventDate ?? prefill.date ?? "");
  const [slotKind, setSlotKind] = useState<SlotKind>(booking?.slotKind ?? prefill.slot ?? "evening");
  const [startTime, setStartTime] = useState(booking?.startTime ?? "");
  const [endTime, setEndTime] = useState(booking?.endTime ?? "");
  const [eventTypeId, setEventTypeId] = useState(booking?.eventTypeId ?? "");
  const [packageId, setPackageId] = useState(booking?.packageId ?? "");
  const [guests, setGuests] = useState(booking?.guests ? String(booking.guests) : "");
  const [removed, setRemoved] = useState<string[]>(booking?.removedServiceIds ?? []);
  const [added, setAdded] = useState<Added[]>(
    (booking?.items ?? []).map((i) => ({
      serviceId: i.serviceId,
      quantity: String(i.quantity),
      isExternal: i.isExternal,
    })),
  );
  const [customerId, setCustomerId] = useState<string | null>(booking?.customerId ?? null);
  const [linkedName, setLinkedName] = useState(booking ? `${booking.customerName} (${booking.customerPhone})` : "");
  const [phone, setPhone] = useState("");
  const [name, setName] = useState("");
  const [altPhone, setAltPhone] = useState("");
  const [groomName, setGroomName] = useState(booking?.groomName ?? "");
  const [brideName, setBrideName] = useState(booking?.brideName ?? "");
  const [notes, setNotes] = useState(booking?.notes ?? "");
  const [note, setNote] = useState<string | null>(null);

  const [error, setError] = useState<ActionError | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [quickOpen, setQuickOpen] = useState(false);
  const [showPriceMobile, setShowPriceMobile] = useState(false);

  const space = options.spaces.find((s) => s.id === spaceId);
  const defaults = space ? defaultSlotTimes(space, slotKind) : { start: "", end: "" };
  const shownStart = startTime || defaults.start;
  const shownEnd = endTime || defaults.end;
  const eventType = options.eventTypes.find((e) => e.id === eventTypeId);
  const spacePackages = options.packages.filter(
    (p) => p.spaceId === spaceId && ((p.isActive && p.bookableSlots.includes(slotKind)) || p.id === booking?.packageId),
  );
  const pkg = options.packages.find((p) => p.id === packageId);
  const serviceById = useMemo(() => new Map(options.services.map((s) => [s.id, s])), [options.services]);
  const guestsNumber = Number(toAsciiDigits(guests.trim()));
  const guestsValid = guests.trim() !== "" && Number.isInteger(guestsNumber) && guestsNumber >= 1;
  const overCapacity = guestsValid && space?.capacityMax != null && guestsNumber > space.capacityMax;
  const fieldErrors = error?.fieldErrors ?? {};
  const normalizedPhone = normalizeEgyptianMobile(phone);
  const hasCustomer = customerId !== null || (name.trim() !== "" && normalizedPhone !== null);

  // Live availability (D-99): the server computes the times, the buffer and the overlaps.
  const live = useLive<Availability>(
    canView && spaceId && isIsoDate(eventDate)
      ? { spaceId, eventDate, slotKind, startTime, endTime, excludeBookingId: booking?.id }
      : null,
    checkAvailabilityAction,
    300,
  );
  const { data: availability, error: availabilityError, loading: checking } = live;

  // Live price (pricing.quote, D-87).
  const quote = useLive<PriceBreakdown>(
    canView && packageId && guestsValid && isIsoDate(eventDate)
      ? {
          spaceId,
          packageId,
          slotKind,
          eventDate,
          guests,
          items: added.map((a) => ({ serviceId: a.serviceId, quantity: a.quantity || "1", isExternal: a.isExternal })),
          removedServiceIds: removed,
        }
      : null,
    quotePriceAction,
    350,
  );
  const { data: price, error: priceError, loading: pricing } = quote;

  // D-28: suggest customers with this number.
  const lookup = useLive<Match[]>(
    !customerId && normalizedPhone ? { phone: normalizedPhone } : null,
    lookupCustomerAction,
    250,
  );
  const matches = lookup.data ?? [];

  function chooseSpace(id: string) {
    setSpaceId(id);
    setStartTime("");
    setEndTime("");
    if (packageId && options.packages.find((p) => p.id === packageId)?.spaceId !== id) {
      setPackageId("");
      setRemoved([]);
      setAdded([]);
      setNote(tw.changeSpaceDropsPackage);
    }
  }

  function chooseSlot(kind: SlotKind) {
    setSlotKind(kind);
    setStartTime("");
    setEndTime("");
    if (pkg && !pkg.bookableSlots.includes(kind)) {
      setPackageId("");
      setRemoved([]);
      setAdded([]);
    }
  }

  function choosePackage(id: string) {
    setPackageId(id === NONE ? "" : id);
    setRemoved([]);
    setAdded([]);
  }

  function linkCustomer(match: Match) {
    setCustomerId(match.id);
    setLinkedName(`${match.name} (${match.phone})`);
  }

  function payload() {
    return {
      spaceId,
      eventDate,
      slotKind,
      startTime,
      endTime,
      customer: customerId ? { customerId } : { name, phone, altPhone },
      eventTypeId,
      groomName,
      brideName,
      packageId,
      guests,
      items: packageId
        ? added.map((a) => ({ serviceId: a.serviceId, quantity: a.quantity, isExternal: a.isExternal }))
        : [],
      removedServiceIds: packageId ? removed : [],
      notes,
    };
  }

  async function save() {
    if (!hasCustomer) {
      setQuickOpen(true);
      return;
    }
    setSaving(true);
    const result = booking
      ? await updateTentativeAction({ ...payload(), bookingId: booking.id, version: booking.version })
      : await createTentativeAction(payload());
    setSaving(false);
    if (result.ok) {
      setQuickOpen(false);
      router.push(`/bookings/${"id" in result.data ? result.data.id : booking?.id}`);
      router.refresh();
      return;
    }
    setError(result.error);
    const first = Object.keys(result.error.fieldErrors ?? {})[0];
    if (first && !quickOpen) setStep(stepOf(first));
  }

  const list = (rows: Overlap[]) => rows.map((r) => r.bookingNo).join("، ");
  const priceView = price ? toView(price) : null;

  const steps = [
    // 1. Space and time.
    <div key="space" className="grid gap-4">
      <div className="grid gap-1.5">
        <Label htmlFor="wizard-space">{tw.space}</Label>
        <Select value={spaceId} onValueChange={chooseSpace}>
          <SelectTrigger id="wizard-space" className="w-full sm:w-72" data-testid="wizard-space">
            <SelectValue placeholder={tw.chooseSpace} />
          </SelectTrigger>
          <SelectContent>
            {selectableSpaces.map((s) => (
              <SelectItem key={s.id} value={s.id}>
                {s.name}
                {!s.isActive && ` (${tw.inactiveSpace})`}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {fieldErrors.spaceId && <p className="text-xs text-destructive">{fieldErrors.spaceId}</p>}
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label={tw.date}
          type="date"
          value={eventDate}
          onChange={(e) => setEventDate(e.target.value)}
          error={fieldErrors.eventDate}
          data-testid="wizard-date"
        />
        <div className="grid gap-1.5">
          <Label htmlFor="wizard-slot">{tw.slot}</Label>
          <Select value={slotKind} onValueChange={(v) => chooseSlot(v as SlotKind)}>
            <SelectTrigger id="wizard-slot" className="w-full" data-testid="wizard-slot">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SLOT_KINDS.map((k) => (
                <SelectItem key={k} value={k}>
                  {t.bookings.slotKinds[k]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {fieldErrors.slotKind && <p className="text-xs text-destructive">{fieldErrors.slotKind}</p>}
        </div>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label={tw.startTime}
          type="time"
          value={shownStart}
          onChange={(e) => setStartTime(e.target.value)}
          error={fieldErrors.startTime}
          data-testid="wizard-start"
        />
        <Field
          label={tw.endTime}
          type="time"
          value={shownEnd}
          onChange={(e) => setEndTime(e.target.value)}
          error={fieldErrors.endTime}
          data-testid="wizard-end"
        />
      </div>
      <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
        <span>{tw.timesHint}</span>
        {(startTime || endTime) && (
          <Button
            type="button"
            variant="link"
            size="sm"
            className="h-auto p-0"
            onClick={() => (setStartTime(""), setEndTime(""))}
          >
            {tw.resetTimes}
          </Button>
        )}
      </div>
      <div aria-live="polite" className="grid gap-2" data-testid="availability">
        {checking && <p className="text-sm text-muted-foreground">{tw.checking}</p>}
        {!checking && availabilityError && <FormError error={availabilityError} />}
        {!checking && availability && (
          <>
            <p className="text-sm">
              {fill(tw.runs, {
                start: formatCairoDateTime(availability.startsAt),
                end: formatCairoDateTime(availability.endsAt),
                blocked: formatCairoDateTime(availability.blockedUntil),
              })}
            </p>
            {availability.confirmedConflicts.length > 0 && (
              <Alert variant="destructive" data-testid="confirmed-conflict">
                <AlertTriangle />
                <AlertDescription>
                  {fill(tw.confirmedConflict, { numbers: list(availability.confirmedConflicts) })}
                </AlertDescription>
              </Alert>
            )}
            {availability.tentativeOverlaps.length > 0 && (
              <Alert data-testid="tentative-overlap">
                <Info />
                <AlertDescription>
                  {fill(tw.tentativeOverlap, { numbers: list(availability.tentativeOverlaps) })}
                </AlertDescription>
              </Alert>
            )}
            {availability.intrudesOtherSlot && (
              <Alert>
                <Info />
                <AlertDescription>{tw.intrudes}</AlertDescription>
              </Alert>
            )}
            {availability.confirmedConflicts.length === 0 && availability.tentativeOverlaps.length === 0 && (
              <p className="flex items-center gap-1 text-sm text-emerald-700 dark:text-emerald-400">
                <Check className="size-4" />
                {tw.available}
              </p>
            )}
          </>
        )}
      </div>
    </div>,

    // 2. Event type, package and guests.
    <div key="package" className="grid gap-4">
      <div className="grid gap-1.5">
        <Label htmlFor="wizard-event-type">{tw.eventType}</Label>
        <Select value={eventTypeId || NONE} onValueChange={(v) => setEventTypeId(v === NONE ? "" : v)}>
          <SelectTrigger id="wizard-event-type" className="w-full sm:w-72" data-testid="wizard-event-type">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NONE}>{tw.noEventType}</SelectItem>
            {options.eventTypes
              .filter((e) => e.isActive || e.id === booking?.eventTypeId)
              .map((e) => (
                <SelectItem key={e.id} value={e.id}>
                  {e.name}
                </SelectItem>
              ))}
          </SelectContent>
        </Select>
        {fieldErrors.eventTypeId && <p className="text-xs text-destructive">{fieldErrors.eventTypeId}</p>}
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="wizard-package">{tw.package}</Label>
        <Select value={packageId || NONE} onValueChange={choosePackage}>
          <SelectTrigger id="wizard-package" className="w-full sm:w-72" data-testid="wizard-package">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NONE}>{tw.noPackage}</SelectItem>
            {spacePackages.map((p) => (
              <SelectItem key={p.id} value={p.id}>
                {p.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">{tw.packageNotForSlot}</p>
        {fieldErrors.packageId && <p className="text-xs text-destructive">{fieldErrors.packageId}</p>}
      </div>
      <Field
        label={tw.guests}
        inputMode="numeric"
        value={guests}
        onChange={(e) => setGuests(e.target.value)}
        error={fieldErrors.guests ?? (overCapacity ? tw.overCapacity : undefined)}
        hint={space?.capacityMax != null ? fill(tw.capacity, { n: formatCount(space.capacityMax) }) : undefined}
        className="sm:w-40"
        data-testid="wizard-guests"
      />
    </div>,

    // 3. Customization (BR-33, BR-34, D-90).
    <div key="items" className="grid gap-5">
      {!pkg ? (
        <p className="text-sm text-muted-foreground">{tw.needPackage}</p>
      ) : (
        <>
          <div className="grid gap-2">
            <h3 className="font-medium">{tw.includedTitle}</h3>
            <ul className="grid gap-2">
              {pkg.items.map((item) => {
                const service = serviceById.get(item.serviceId);
                const id = `remove-${item.serviceId}`;
                return (
                  <li
                    key={item.serviceId}
                    className="flex flex-wrap items-center gap-2 text-sm"
                    data-testid="included-item"
                  >
                    <span className="min-w-40">
                      {service?.name}
                      {item.quantity > 1 && ` ×${formatCount(item.quantity)}`}
                    </span>
                    {item.removable ? (
                      <label htmlFor={id} className="flex items-center gap-2">
                        <Checkbox
                          id={id}
                          checked={removed.includes(item.serviceId)}
                          onCheckedChange={(checked) =>
                            setRemoved((current) =>
                              checked ? [...current, item.serviceId] : current.filter((r) => r !== item.serviceId),
                            )
                          }
                        />
                        {tw.removeIncluded}
                        <span className="text-xs text-muted-foreground">
                          ({fill(tw.removalCredit, { amount: formatPiasters(item.removalCredit) })})
                        </span>
                      </label>
                    ) : (
                      <span className="text-xs text-muted-foreground">{tw.notRemovable}</span>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
          <div className="grid gap-2">
            <h3 className="font-medium">{tw.addedTitle}</h3>
            {added.length === 0 && <p className="text-sm text-muted-foreground">{tw.noAdded}</p>}
            <ul className="grid gap-2">
              {added.map((a, index) => {
                const service = serviceById.get(a.serviceId);
                const error = fieldErrors[`items.${a.serviceId}`] ?? fieldErrors[`items.${index}.quantity`];
                return (
                  <li key={a.serviceId} className="grid gap-1" data-testid="added-item">
                    <div className="flex flex-wrap items-center gap-3 text-sm">
                      <span className="min-w-40">{service?.name}</span>
                      {service?.pricingType === "per_unit" && (
                        <Input
                          aria-label={`${tw.quantity}: ${service.name}`}
                          inputMode="numeric"
                          className="w-20"
                          value={a.quantity}
                          onChange={(e) =>
                            setAdded((cur) => cur.map((x, i) => (i === index ? { ...x, quantity: e.target.value } : x)))
                          }
                        />
                      )}
                      {service?.allowExternal && (
                        <label className="flex items-center gap-2">
                          <Checkbox
                            checked={a.isExternal}
                            onCheckedChange={(checked) =>
                              setAdded((cur) =>
                                cur.map((x, i) => (i === index ? { ...x, isExternal: checked === true } : x)),
                              )
                            }
                          />
                          {tw.external}
                          <span className="text-xs text-muted-foreground">
                            ({fill(tw.externalFee, { amount: formatPiasters(service.externalFee) })})
                          </span>
                        </label>
                      )}
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`${tw.removeAdded}: ${service?.name}`}
                        onClick={() => setAdded((cur) => cur.filter((_, i) => i !== index))}
                      >
                        <Trash2 />
                      </Button>
                    </div>
                    {error && <p className="text-xs text-destructive">{error}</p>}
                  </li>
                );
              })}
            </ul>
            <Select
              value=""
              onValueChange={(id) => {
                const service = serviceById.get(id);
                // A removed included service comes back as an external provider only (D-90).
                const external = removed.includes(id);
                if (service) setAdded((cur) => [...cur, { serviceId: id, quantity: "1", isExternal: external }]);
              }}
            >
              <SelectTrigger className="w-full sm:w-72" data-testid="wizard-add-service">
                <SelectValue placeholder={tw.addService} />
              </SelectTrigger>
              <SelectContent>
                {options.services
                  .filter((s) => s.isActive && !added.some((a) => a.serviceId === s.id))
                  .map((s) => (
                    <SelectItem key={s.id} value={s.id}>
                      {s.name}
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
          </div>
        </>
      )}
      {priceError && <FormError error={priceError} />}
    </div>,

    // 4. Customer (D-28).
    <div key="customer" className="grid gap-4">
      {customerId ? (
        <div className="flex flex-wrap items-center gap-2 text-sm" data-testid="linked-customer">
          <span className="text-muted-foreground">{tw.linkedTo}</span>
          <span className="font-medium">{linkedName}</span>
          <Button type="button" variant="link" size="sm" className="h-auto p-0" onClick={() => setCustomerId(null)}>
            {tw.changeCustomer}
          </Button>
        </div>
      ) : (
        <CustomerFields
          phone={phone}
          setPhone={setPhone}
          name={name}
          setName={setName}
          altPhone={altPhone}
          setAltPhone={setAltPhone}
          matches={matches}
          onUse={linkCustomer}
          errors={fieldErrors}
        />
      )}
      {eventType?.isWedding && (
        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label={tw.groomName}
            value={groomName}
            onChange={(e) => setGroomName(e.target.value)}
            error={fieldErrors.groomName}
          />
          <Field
            label={tw.brideName}
            value={brideName}
            onChange={(e) => setBrideName(e.target.value)}
            error={fieldErrors.brideName}
          />
          <p className="text-xs text-muted-foreground sm:col-span-2">{tw.namesHint}</p>
        </div>
      )}
      <div className="grid gap-1.5">
        <Label htmlFor="wizard-notes">{tw.notes}</Label>
        <textarea
          id="wizard-notes"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={3}
          maxLength={1000}
          className="rounded-md border bg-transparent px-3 py-2 text-sm shadow-xs focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
        />
      </div>
    </div>,

    // 5. Summary.
    <div key="summary" className="grid gap-3 text-sm" data-testid="wizard-summary">
      <dl className="grid gap-x-4 gap-y-2 sm:grid-cols-[10rem_1fr]">
        <dt className="text-muted-foreground">{tw.space}</dt>
        <dd>{space?.name}</dd>
        <dt className="text-muted-foreground">{tw.date}</dt>
        <dd>
          {eventDate} — {t.bookings.slotKinds[slotKind]} ({shownStart} – {shownEnd})
        </dd>
        <dt className="text-muted-foreground">{tw.eventType}</dt>
        <dd>{eventType?.name ?? tw.noEventType}</dd>
        <dt className="text-muted-foreground">{tw.package}</dt>
        <dd>{pkg ? `${pkg.name} — ${guests} ${t.bookings.page.guests}` : tw.noPackage}</dd>
        <dt className="text-muted-foreground">{t.bookings.customer}</dt>
        <dd>{customerId ? linkedName : name ? `${name} (${phone})` : "—"}</dd>
      </dl>
      {availability && availability.confirmedConflicts.length > 0 && (
        <Alert variant="destructive">
          <AlertTriangle />
          <AlertDescription>
            {fill(tw.confirmedConflict, { numbers: list(availability.confirmedConflicts) })}
          </AlertDescription>
        </Alert>
      )}
      <p className="text-muted-foreground">{fill(tw.expiresNote, { hours: options.timing.tentativeHoldHours })}</p>
    </div>,
  ];

  const priceCard = (
    <Card className="gap-3 py-4">
      <CardHeader className="px-4">
        <CardTitle className="text-base">{tw.priceTitle}</CardTitle>
      </CardHeader>
      <CardContent className="px-4">
        {pricing && <p className="text-sm text-muted-foreground">{tw.pricing}</p>}
        {!pricing && priceView && <PriceBreakdownView breakdown={priceView} />}
        {!pricing && !priceView && !priceError && <p className="text-sm text-muted-foreground">{tw.priceEmpty}</p>}
        {!pricing && priceError && <p className="text-sm text-destructive">{priceError.message}</p>}
      </CardContent>
    </Card>
  );

  return (
    <div className="grid gap-6 pb-24 lg:grid-cols-[1fr_20rem] lg:pb-0">
      <div className="grid content-start gap-5">
        <h1 className="text-2xl font-bold">
          {booking ? (
            <>
              {t.bookings.editTitle} <span dir="ltr">{booking.bookingNo}</span>
            </>
          ) : (
            t.bookings.newTitle
          )}
        </h1>
        <ol className="flex flex-wrap gap-2" aria-label={t.bookings.newTitle}>
          {tw.steps.map((label, index) => (
            <li key={label}>
              <button
                type="button"
                onClick={() => setStep(index)}
                aria-current={step === index ? "step" : undefined}
                className={cn(
                  "rounded-full border px-3 py-1 text-sm",
                  step === index
                    ? "border-primary bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:bg-muted",
                )}
              >
                <span className="me-1.5 inline-flex size-5 items-center justify-center rounded-full border border-current text-xs">
                  {formatCount(index + 1)}
                </span>
                {label}
              </button>
            </li>
          ))}
        </ol>
        {note && (
          <Alert>
            <Info />
            <AlertDescription>{note}</AlertDescription>
          </Alert>
        )}
        <FormError error={error} />
        <Card className="py-5">
          <CardContent className="px-5">{steps[step]}</CardContent>
        </Card>
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" variant="outline" disabled={step === 0} onClick={() => setStep(step - 1)}>
            {tw.back}
          </Button>
          {step < steps.length - 1 && (
            <Button type="button" variant="outline" onClick={() => setStep(step + 1)}>
              {tw.next}
            </Button>
          )}
          {!booking && paymentOptions && (
            <Button
              type="button"
              variant="secondary"
              disabled={saving || !price || !hasCustomer}
              onClick={() => setConfirming(true)}
              data-testid="wizard-confirm"
              className="ms-auto"
            >
              {tw.confirmDeposit}
            </Button>
          )}
          <Button
            type="button"
            disabled={saving || !spaceId || !eventDate}
            onClick={save}
            data-testid="save-tentative"
            className={cn(!(!booking && paymentOptions) && "ms-auto")}
          >
            {saving ? tw.saving : booking ? tw.saveChanges : tw.saveTentative}
          </Button>
        </div>
      </div>

      <aside className="hidden lg:block">{priceCard}</aside>

      {/* Mobile: the total stays visible at the bottom, the breakdown opens above it. */}
      <div
        className="fixed inset-x-0 bottom-0 z-20 border-t bg-card p-3 shadow-lg lg:hidden"
        data-testid="mobile-price-bar"
      >
        {showPriceMobile && <div className="mb-3 max-h-[50vh] overflow-y-auto">{priceCard}</div>}
        <button
          type="button"
          className="flex w-full items-center justify-between text-sm font-medium"
          onClick={() => setShowPriceMobile(!showPriceMobile)}
          aria-expanded={showPriceMobile}
        >
          <span>{t.bookings.price.total}</span>
          <span className="tabular-nums">{priceView ? formatPiasters(priceView.total) : "—"}</span>
        </button>
      </div>

      {confirming && paymentOptions && price && (
        <ConfirmDepositDialog
          open
          onOpenChange={setConfirming}
          title={t.payments.confirm.createTitle}
          total={price.total}
          eventDate={eventDate}
          options={paymentOptions}
          submit={(fields) => createConfirmedAction({ ...payload(), ...fields })}
          onDone={(data) => {
            setConfirming(false);
            router.push(`/bookings/${data.id}`);
            router.refresh();
          }}
        />
      )}

      <Dialog open={quickOpen} onOpenChange={setQuickOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{tw.quickTitle}</DialogTitle>
            <DialogDescription>{tw.quickDescription}</DialogDescription>
          </DialogHeader>
          <CustomerFields
            phone={phone}
            setPhone={setPhone}
            name={name}
            setName={setName}
            altPhone={altPhone}
            setAltPhone={setAltPhone}
            matches={matches}
            onUse={linkCustomer}
            errors={fieldErrors}
            compact
          />
          <FormError error={error} />
          <DialogFooter>
            <Button variant="outline" onClick={() => setQuickOpen(false)}>
              {t.common.cancel}
            </Button>
            <Button disabled={saving || !hasCustomer} onClick={save} data-testid="quick-save">
              {saving ? tw.saving : tw.saveTentative}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function CustomerFields(props: {
  phone: string;
  setPhone: (v: string) => void;
  name: string;
  setName: (v: string) => void;
  altPhone: string;
  setAltPhone: (v: string) => void;
  matches: Match[];
  onUse: (m: Match) => void;
  errors: Record<string, string>;
  compact?: boolean;
}) {
  return (
    <div className="grid gap-4">
      <Field
        label={tw.phone}
        inputMode="tel"
        dir="ltr"
        value={props.phone}
        onChange={(e) => props.setPhone(e.target.value)}
        error={props.errors["customer.phone"]}
        hint={tw.phoneHint}
        data-testid="customer-phone"
      />
      {props.matches.length > 0 && (
        <div className="grid gap-2 rounded-md border p-3 text-sm" data-testid="customer-matches">
          <p className="text-muted-foreground">{tw.matches}</p>
          {props.matches.map((m) => (
            <div key={m.id} className="flex flex-wrap items-center justify-between gap-2">
              <span>
                {m.name} — {fill(tw.bookingsCount, { n: formatCount(m.bookingCount) })}
              </span>
              <Button type="button" size="sm" variant="outline" onClick={() => props.onUse(m)}>
                {tw.useCustomer}
              </Button>
            </div>
          ))}
          <p className="text-xs text-muted-foreground">
            {tw.newCustomer}: {tw.name} ↓
          </p>
        </div>
      )}
      <Field
        label={tw.name}
        value={props.name}
        onChange={(e) => props.setName(e.target.value)}
        error={props.errors["customer.name"] ?? props.errors.customer}
        data-testid="customer-name"
      />
      {!props.compact && (
        <Field
          label={tw.altPhone}
          inputMode="tel"
          dir="ltr"
          value={props.altPhone}
          onChange={(e) => props.setAltPhone(e.target.value)}
          error={props.errors["customer.altPhone"]}
        />
      )}
    </div>
  );
}
