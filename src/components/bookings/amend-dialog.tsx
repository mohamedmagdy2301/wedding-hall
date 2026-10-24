"use client";

import { AlertTriangle, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { CreditChoice, creditInput, type CreditMode, type CreditValue } from "@/components/discounts/credit-choice";
import { Field, FormError } from "@/components/forms/field";
import { useServerAction } from "@/components/forms/use-server-action";
import { DialogShell } from "@/components/payments/payments-panel";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { formatPiasters } from "@/domain/money";
import { formatCount } from "@/lib/digits";
import { fill, t } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { formatIsoDate } from "@/lib/time";
import type { ItemsPreview } from "@/modules/bookings/amend";
import type { ActionError } from "@/server/action-core";
import { previewItemsAction, updateItemsAction } from "@/server/actions/bookings";

const ta = t.amend;

export type AmendLine = {
  id: string;
  serviceId: string | null;
  name: string;
  pricingType: "fixed" | "per_unit" | "per_guest";
  quantity: number;
  source: "package" | "added" | "guest_adjustment";
  isRemoved: boolean;
  isExternal: boolean;
};

export type AmendOptions = {
  services: { id: string; name: string; pricingType: "fixed" | "per_unit" | "per_guest"; allowExternal: boolean }[];
  /** Included services the package allows to remove now (BR-33). */
  removable: string[];
};

type AddRow = { serviceId: string; quantity: string; isExternal: boolean; unitPrice: string };

/** An added service as one row: all its lines (confirmed and later), its units, external or not. */
function groupAdded(lines: AmendLine[]) {
  const groups = new Map<
    string,
    { serviceId: string; name: string; pricingType: AmendLine["pricingType"]; quantity: number; isExternal: boolean }
  >();
  for (const l of lines) {
    if (l.source === "package" || l.serviceId === null) continue;
    const g = groups.get(l.serviceId);
    if (g) g.quantity += l.quantity;
    else
      groups.set(l.serviceId, {
        serviceId: l.serviceId,
        name: l.name,
        pricingType: l.pricingType,
        quantity: l.quantity,
        isExternal: l.isExternal,
      });
  }
  return [...groups.values()];
}

/** UF-07 (BR-40..43, D-92, D-93, Q7-05): the server prices every change live; saving sends the total it showed. */
export function AmendDialog(props: {
  booking: { id: string; bookingNo: string; version: number; guests: number };
  lines: AmendLine[];
  options: AmendOptions;
  credit: { mode: CreditMode; methods: { id: string; name: string }[] };
  onClose: () => void;
  onDone: () => void;
}) {
  const { booking } = props;
  const added = useMemo(() => groupAdded(props.lines), [props.lines]);
  const included = props.lines.filter((l) => l.source === "package" && l.serviceId !== null);

  const [guests, setGuests] = useState(String(booking.guests));
  const [extraGuestPrice, setExtraGuestPrice] = useState("");
  const [servicePrices, setServicePrices] = useState<Record<string, string>>({});
  const [remove, setRemove] = useState<Set<string>>(new Set());
  const [quantities, setQuantities] = useState<Record<string, string>>({});
  const [removeIncluded, setRemoveIncluded] = useState<Set<string>>(new Set());
  const [restoreIncluded, setRestoreIncluded] = useState<Set<string>>(new Set());
  const [adds, setAdds] = useState<AddRow[]>([]);
  const [draft, setDraft] = useState<AddRow>({ serviceId: "", quantity: "1", isExternal: false, unitPrice: "" });
  const [overrideReason, setOverrideReason] = useState("");
  const [credit, setCredit] = useState<CreditValue>({
    resolution: "refund",
    methodId: props.credit.methods[0]?.id ?? "",
  });

  const [preview, setPreview] = useState<ItemsPreview | null>(null);
  const [previewError, setPreviewError] = useState<ActionError | null>(null);
  const [loading, setLoading] = useState(false);
  const save = useServerAction(updateItemsAction);
  // A save refused because prices moved (like D-124) brings a new preview.
  const priceChangedError = save.error?.code === "PRICE_CHANGED" ? save.error : null;

  const guestsUp = Number(guests) > booking.guests;
  const perGuest = added.filter((g) => g.pricingType === "per_guest" && !g.isExternal && !remove.has(g.serviceId));
  const changes = useMemo(
    () => ({
      guests,
      extraGuestUnitPrice: guestsUp ? extraGuestPrice : "",
      guestServicePrices: guestsUp
        ? Object.entries(servicePrices)
            .filter(([, v]) => v.trim() !== "")
            .map(([serviceId, unitPrice]) => ({ serviceId, unitPrice }))
        : [],
      add: adds.map((a) => ({ ...a, quantity: a.quantity || "1" })),
      remove: [...remove],
      quantities: Object.entries(quantities)
        .filter(
          ([serviceId, q]) =>
            !remove.has(serviceId) && q !== String(added.find((g) => g.serviceId === serviceId)?.quantity),
        )
        .map(([serviceId, quantity]) => ({ serviceId, quantity })),
      removeIncluded: [...removeIncluded],
      restoreIncluded: [...restoreIncluded],
    }),
    [
      guests,
      guestsUp,
      extraGuestPrice,
      servicePrices,
      adds,
      remove,
      quantities,
      removeIncluded,
      restoreIncluded,
      added,
    ],
  );

  // The server's preview, a moment after the last change.
  useEffect(() => {
    let current = true;
    const timer = setTimeout(async () => {
      setLoading(true);
      const result = await previewItemsAction({ bookingId: booking.id, changes });
      if (!current) return;
      setLoading(false);
      if (result.ok) {
        setPreview(result.data);
        setPreviewError(null);
      } else {
        setPreview(null);
        setPreviewError(result.error);
      }
    }, 300);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [booking.id, changes, priceChangedError]);

  const toggle = (set: Set<string>, setter: (s: Set<string>) => void, id: string) => {
    const next = new Set(set);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setter(next);
  };
  const draftService = props.options.services.find((s) => s.id === draft.serviceId);
  const errors = save.error?.fieldErrors ?? {};
  const diff = preview && preview.totalBefore !== null ? preview.totalAfter - preview.totalBefore : 0;

  return (
    <DialogShell
      testId="amend-dialog"
      title={fill(ta.title, { no: booking.bookingNo })}
      onClose={props.onClose}
      footer={
        <Button
          disabled={save.pending || loading || !preview || !preview.changed}
          data-testid="amend-submit"
          onClick={() =>
            preview &&
            save.run(
              {
                bookingId: booking.id,
                version: booking.version,
                expectedTotal: preview.totalAfter,
                changes,
                overrideReason,
                ...creditInput(preview.credit, preview.creditMode, credit),
              },
              props.onDone,
            )
          }
        >
          {save.pending ? t.common.saving : ta.save}
        </Button>
      }
    >
      <Field
        label={ta.guests}
        inputMode="numeric"
        value={guests}
        onChange={(e) => setGuests(e.target.value)}
        hint={ta.guestsHint}
        data-testid="amend-guests"
      />
      {guestsUp && (
        <div className="grid gap-2 sm:grid-cols-2">
          <Field
            label={ta.extraGuestPrice}
            inputMode="decimal"
            value={extraGuestPrice}
            onChange={(e) => setExtraGuestPrice(e.target.value)}
            data-testid="amend-extra-price"
          />
          {perGuest.map((g) => (
            <Field
              key={g.serviceId}
              label={fill(ta.servicePrice, { name: g.name })}
              inputMode="decimal"
              value={servicePrices[g.serviceId] ?? ""}
              onChange={(e) => setServicePrices({ ...servicePrices, [g.serviceId]: e.target.value })}
            />
          ))}
        </div>
      )}

      {added.length > 0 && (
        <div className="grid gap-1.5">
          <p className="text-sm font-medium">{ta.added}</p>
          <ul className="grid gap-1.5 text-sm">
            {added.map((g) => {
              const removed = remove.has(g.serviceId);
              const adjustable = g.pricingType === "per_unit" && !g.isExternal;
              return (
                <li key={g.serviceId} className="flex flex-wrap items-center gap-2" data-testid="amend-added">
                  <span className={cn("flex-1", removed && "text-muted-foreground line-through")}>
                    {g.name}
                    {g.isExternal && <span className="ms-1 text-xs text-muted-foreground">({ta.external})</span>}
                    {g.pricingType === "per_guest" && !g.isExternal && ` ×${formatCount(g.quantity)}`}
                  </span>
                  {adjustable && !removed && (
                    <Input
                      className="w-20"
                      inputMode="numeric"
                      aria-label={`${ta.quantity} ${g.name}`}
                      value={quantities[g.serviceId] ?? String(g.quantity)}
                      onChange={(e) => setQuantities({ ...quantities, [g.serviceId]: e.target.value })}
                    />
                  )}
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => toggle(remove, setRemove, g.serviceId)}
                    data-testid="amend-remove"
                  >
                    {removed ? ta.undo : ta.remove}
                  </Button>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {included.length > 0 && (
        <div className="grid gap-1.5">
          <p className="text-sm font-medium">{ta.included}</p>
          <ul className="grid gap-1.5 text-sm">
            {included.map((l) => {
              const id = l.serviceId!;
              const marked = l.isRemoved ? !restoreIncluded.has(id) : removeIncluded.has(id);
              const canToggle = l.isRemoved || props.options.removable.includes(id);
              return (
                <li key={l.id} className="flex items-center gap-2" data-testid="amend-included">
                  <span className={cn("flex-1", marked && "text-muted-foreground line-through")}>
                    {l.name}
                    {l.isRemoved && <span className="ms-1 text-xs">({ta.removedMark})</span>}
                  </span>
                  {canToggle && (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() =>
                        l.isRemoved
                          ? toggle(restoreIncluded, setRestoreIncluded, id)
                          : toggle(removeIncluded, setRemoveIncluded, id)
                      }
                    >
                      {l.isRemoved ? (marked ? ta.restore : ta.undo) : marked ? ta.undo : ta.remove}
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}

      <div className="grid gap-2 rounded-md border p-3">
        <p className="text-sm font-medium">{ta.addService}</p>
        {adds.length > 0 && (
          <ul className="grid gap-1 text-sm">
            {adds.map((a, index) => (
              <li key={index} className="flex items-center gap-2">
                <span className="flex-1">
                  {props.options.services.find((s) => s.id === a.serviceId)?.name} ×{a.quantity}
                  {a.isExternal && ` (${ta.external})`}
                  {a.unitPrice && ` — ${a.unitPrice}`}
                </span>
                <Button
                  size="icon"
                  variant="ghost"
                  aria-label={ta.remove}
                  onClick={() => setAdds(adds.filter((_, i) => i !== index))}
                >
                  <X />
                </Button>
              </li>
            ))}
          </ul>
        )}
        <div className="grid gap-2 sm:grid-cols-2">
          <Select
            value={draft.serviceId}
            onValueChange={(serviceId) => setDraft({ ...draft, serviceId, quantity: "1" })}
          >
            <SelectTrigger className="w-full" data-testid="amend-service">
              <SelectValue placeholder={ta.chooseService} />
            </SelectTrigger>
            <SelectContent>
              {props.options.services.map((s) => (
                <SelectItem key={s.id} value={s.id}>
                  {s.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {draftService?.pricingType === "per_unit" && (
            <Input
              inputMode="numeric"
              aria-label={ta.quantity}
              value={draft.quantity}
              onChange={(e) => setDraft({ ...draft, quantity: e.target.value })}
            />
          )}
          {!draft.isExternal && (
            <Input
              inputMode="decimal"
              placeholder={ta.typedPrice}
              aria-label={ta.typedPrice}
              value={draft.unitPrice}
              onChange={(e) => setDraft({ ...draft, unitPrice: e.target.value })}
              data-testid="amend-typed-price"
            />
          )}
          {draftService?.allowExternal && (
            <Label className="flex items-center gap-2 font-normal">
              <Checkbox
                checked={draft.isExternal}
                onCheckedChange={(v) => setDraft({ ...draft, isExternal: v === true, unitPrice: "" })}
              />
              {ta.external}
            </Label>
          )}
        </div>
        <Button
          size="sm"
          variant="outline"
          className="justify-self-start"
          disabled={!draft.serviceId}
          data-testid="amend-add"
          onClick={() => {
            setAdds([...adds, draft]);
            setDraft({ serviceId: "", quantity: "1", isExternal: false, unitPrice: "" });
          }}
        >
          {ta.add}
        </Button>
      </div>

      {loading && <p className="text-sm text-muted-foreground">{ta.loading}</p>}
      {previewError && <FormError error={previewError} />}
      {preview && !preview.changed && <p className="text-sm text-muted-foreground">{ta.nothing}</p>}
      {preview && preview.changed && (
        <div className="grid gap-2 rounded-md bg-muted/50 p-3 text-sm" data-testid="amend-preview">
          <div className="flex justify-between">
            <span>{ta.before}</span>
            <span className="tabular-nums">{formatPiasters(preview.totalBefore ?? 0)}</span>
          </div>
          {preview.newLines.map((l, i) => (
            <div key={`n${i}`} className="flex justify-between text-emerald-700 dark:text-emerald-300">
              <span>
                + {l.name} ×{formatCount(l.quantity)}
              </span>
              <span className="tabular-nums">{formatPiasters(l.lineTotal)}</span>
            </div>
          ))}
          {preview.voidedLines.map((l, i) => (
            <div key={`v${i}`} className="flex justify-between text-muted-foreground">
              <span>
                − {l.name} ×{formatCount(l.quantity)}
              </span>
              <span className="tabular-nums">{formatPiasters(-l.lineTotal)}</span>
            </div>
          ))}
          {preview.includedChanges.map((c, i) => (
            <div key={`i${i}`} className="flex justify-between">
              <span>
                {c.isRemoved ? "−" : "+"} {c.name}
              </span>
              <span className="tabular-nums">{formatPiasters(c.lineTotal)}</span>
            </div>
          ))}
          <div className="flex justify-between font-bold" data-testid="amend-total-after">
            <span>{ta.after}</span>
            <span className="tabular-nums">{formatPiasters(preview.totalAfter)}</span>
          </div>
          <div className="flex justify-between text-muted-foreground">
            <span>{ta.difference}</span>
            <span className="tabular-nums">{formatPiasters(diff)}</span>
          </div>
          {preview.overrideDiscountTotal > 0 && (
            <>
              <Alert>
                <AlertTriangle />
                <AlertDescription>
                  {fill(preview.overrideApprovedAtOnce ? ta.overrideApproved : ta.overrideDiscount, {
                    amount: formatPiasters(preview.overrideDiscountTotal),
                  })}
                </AlertDescription>
              </Alert>
              <Field
                label={ta.overrideReason}
                value={overrideReason}
                onChange={(e) => setOverrideReason(e.target.value)}
                error={errors.overrideReason}
                maxLength={280}
                data-testid="amend-override-reason"
              />
            </>
          )}
          {preview.installments.length > 0 && (
            <div>
              <p className="text-muted-foreground">{ta.schedule}</p>
              <ul className="ps-4">
                {preview.installments.map((l, i) => (
                  <li key={i} className="tabular-nums">
                    {formatIsoDate(l.dueDate)} — {formatPiasters(l.amount)}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {preview.credit > 0 && (
            <CreditChoice
              credit={preview.credit}
              mode={preview.creditMode}
              methods={props.credit.methods}
              value={credit}
              onChange={setCredit}
              error={errors["credit.methodId"]}
            />
          )}
        </div>
      )}
      {save.error?.code === "PRICE_CHANGED" ? (
        <Alert variant="destructive">
          <AlertDescription>{ta.priceChanged}</AlertDescription>
        </Alert>
      ) : (
        <FormError error={save.error} />
      )}
    </DialogShell>
  );
}
