"use client";

import { ArrowRight, Info, Trash2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Field, FormError } from "@/components/forms/field";
import { SelectField } from "@/components/forms/select-field";
import { useServerAction } from "@/components/forms/use-server-action";
import { useSavedNote } from "@/components/settings/saved-note";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { priceSetViolation, SLOT_KINDS, type PackagePrice, type SlotKind } from "@/domain/catalog";
import { parsePounds, piastersToInput } from "@/domain/money";
import { toAsciiDigits } from "@/lib/digits";
import { t } from "@/lib/i18n";
import type { PackageDetail, PackageFormOptions } from "@/modules/packages/service";
import { createPackageAction, updatePackageAction } from "@/server/actions/catalog";

const tp = t.settings.packages;
const messages: Record<string, string> = t.errors.messages;

type ItemRow = { serviceId: string; quantity: string; removable: boolean; removalCredit: string };

const cellKey = (slotKind: SlotKind, seasonId: string | null) => `${slotKind}|${seasonId ?? ""}`;

function initialCells(prices: PackagePrice[]) {
  return Object.fromEntries(prices.map((p) => [cellKey(p.slotKind, p.seasonId), piastersToInput(p.price)]));
}

/**
 * The package page (P3-14): data, prices per slot × season (BR-30, D-56, D-78) and included
 * services (BR-33, D-80). Edits carry the version the page was opened on (D-81); a stale
 * save is refused and the page asks for a refresh.
 */
export function PackageForm({
  spaces,
  seasons,
  services,
  package: pkg,
}: PackageFormOptions & { package?: PackageDetail }) {
  const router = useRouter();
  const create = useServerAction(createPackageAction);
  const update = useServerAction(updatePackageAction);
  const { pending, error } = pkg ? update : create;
  const saved = useSavedNote();

  const activeSpaces = spaces.filter((s) => s.isActive);
  const [spaceId, setSpaceId] = useState(pkg?.spaceId ?? activeSpaces[0]?.id ?? "");
  const [version, setVersion] = useState(pkg?.version ?? 1);
  const [baseGuests, setBaseGuests] = useState(pkg ? String(pkg.baseGuests) : "");
  const [isActive, setIsActive] = useState(pkg?.isActive ?? true);
  const [cells, setCells] = useState<Record<string, string>>(initialCells(pkg?.prices ?? []));
  const [items, setItems] = useState<ItemRow[]>(
    (pkg?.items ?? []).map((i) => ({
      serviceId: i.serviceId,
      quantity: String(i.quantity),
      removable: i.removable,
      removalCredit: i.removable ? piastersToInput(i.removalCredit) : "",
    })),
  );

  const space = spaces.find((s) => s.id === spaceId);
  const serviceById = new Map(services.map((s) => [s.id, s]));
  const inactiveSeasonIds = new Set(seasons.filter((s) => !s.isActive).map((s) => s.id));
  // An inactive season shows only while it still has prices on this package (D-78).
  const seasonRows = seasons.filter(
    (s) => s.isActive || SLOT_KINDS.some((k) => (cells[cellKey(k, s.id)] ?? "") !== ""),
  );
  const rows = [{ id: null as string | null, name: tp.regular, isActive: true }, ...seasonRows];

  // The prices as they will be sent, in order, so field errors map back to their cell.
  const sent = rows.flatMap((row) =>
    SLOT_KINDS.flatMap((slotKind) => {
      const value = cells[cellKey(slotKind, row.id)] ?? "";
      return value.trim() === "" ? [] : [{ slotKind, seasonId: row.id, price: value }];
    }),
  );
  const parsed = sent.flatMap((p) => {
    const price = parsePounds(p.price);
    return price && price > 0 ? [{ ...p, price }] : [];
  });
  // Mirrors the server's check while typing (the server checks again under the row lock).
  const live =
    parsed.length === sent.length
      ? priceSetViolation(parsed, { active: isActive, inactiveSeasonIds, existing: pkg?.prices ?? [] })
      : null;

  const fieldErrors = error?.fieldErrors ?? {};
  const cellError = (slotKind: SlotKind, seasonId: string | null) => {
    const index = sent.findIndex((p) => p.slotKind === slotKind && p.seasonId === seasonId);
    return index >= 0 ? fieldErrors[`prices.${index}.price`] : undefined;
  };

  const guests = Number(toAsciiDigits(baseGuests));
  const overCapacity = space?.capacityMax != null && Number.isInteger(guests) && guests > space.capacityMax;

  const addable = services.filter((s) => s.isActive && !items.some((i) => i.serviceId === s.id));
  const setItem = (index: number, patch: Partial<ItemRow>) =>
    setItems((current) => current.map((item, i) => (i === index ? { ...item, ...patch } : item)));

  function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const fields = {
      name: form.get("name"),
      description: form.get("description"),
      baseGuests,
      extraGuestPrice: form.get("extraGuestPrice"),
      isActive,
      prices: sent,
      items: items.map((i) => ({
        serviceId: i.serviceId,
        quantity: serviceById.get(i.serviceId)?.pricingType === "per_unit" ? i.quantity : "1",
        removable: i.removable,
        removalCredit: i.removable ? i.removalCredit : "",
      })),
    };
    if (pkg) {
      update.run({ ...fields, packageId: pkg.id, version }, (data) => {
        setVersion(data.version);
        saved.flash();
      });
    } else {
      create.run({ ...fields, spaceId }, () => router.push("/settings/packages"));
    }
  }

  if (!pkg && activeSpaces.length === 0) {
    return <p className="text-sm text-muted-foreground">{tp.noActiveSpace}</p>;
  }

  return (
    <form onSubmit={onSubmit} className="grid max-w-4xl gap-6" noValidate>
      <div className="flex flex-wrap items-center gap-3">
        <Button asChild variant="ghost" size="sm">
          <Link href="/settings/packages">
            <ArrowRight />
            {tp.back}
          </Link>
        </Button>
        <h2 className="text-lg font-semibold">{pkg ? `${tp.editTitle}: ${pkg.name}` : tp.newTitle}</h2>
      </div>

      {error?.code === "CONCURRENT_MODIFICATION" ? (
        <Alert variant="destructive" role="alert" data-testid="package-conflict">
          <AlertDescription className="flex flex-wrap items-center gap-3">
            {error.message}
            <Button type="button" size="sm" variant="outline" onClick={() => window.location.reload()}>
              {tp.reload}
            </Button>
          </AlertDescription>
        </Alert>
      ) : (
        <FormError error={error && Object.keys(fieldErrors).length > 0 ? null : error} />
      )}

      <section className="grid gap-4 sm:grid-cols-2">
        {pkg ? (
          <div className="grid gap-1.5">
            <Label>{tp.space}</Label>
            <p className="text-sm">
              {space?.name} {space && !space.isActive && <Badge variant="destructive">{tp.spaceInactive}</Badge>}
            </p>
            <p className="text-xs text-muted-foreground">{tp.spaceFixed}</p>
          </div>
        ) : (
          <SelectField
            label={tp.space}
            value={spaceId}
            onChange={setSpaceId}
            options={Object.fromEntries(activeSpaces.map((s) => [s.id, s.name]))}
            testId="package-space"
            hint={tp.spaceFixed}
            error={fieldErrors.spaceId}
          />
        )}
        <Field label={t.settings.name} name="name" defaultValue={pkg?.name} error={fieldErrors.name} />
        <div className="sm:col-span-2">
          <Field
            label={tp.description}
            name="description"
            defaultValue={pkg?.description ?? ""}
            error={fieldErrors.description}
          />
        </div>
        <Field
          label={tp.baseGuests}
          inputMode="numeric"
          dir="ltr"
          className="text-start"
          value={baseGuests}
          onChange={(e) => setBaseGuests(e.target.value)}
          hint={tp.baseGuestsHint}
          error={fieldErrors.baseGuests}
        />
        <Field
          label={tp.extraGuestPrice}
          name="extraGuestPrice"
          inputMode="decimal"
          dir="ltr"
          className="text-start"
          defaultValue={pkg ? piastersToInput(pkg.extraGuestPrice) : ""}
          error={fieldErrors.extraGuestPrice}
        />
        {overCapacity && (
          <p className="text-sm text-amber-700 sm:col-span-2 dark:text-amber-400" data-testid="capacity-warning">
            {tp.capacityWarning.replace("{n}", String(space?.capacityMax))}
          </p>
        )}
        <div className="grid gap-1 sm:col-span-2">
          <div className="flex items-center gap-2">
            <Checkbox id="package-active" checked={isActive} onCheckedChange={(c) => setIsActive(c === true)} />
            <Label htmlFor="package-active" className="font-normal">
              {tp.active}
            </Label>
          </div>
          <p className="text-xs text-muted-foreground">{tp.activeHint}</p>
        </div>
      </section>

      <section className="grid gap-2" aria-labelledby="prices-title">
        <h3 id="prices-title" className="font-semibold">
          {tp.prices}
        </h3>
        <p className="text-sm text-muted-foreground">{tp.pricesHint}</p>
        <div className="overflow-x-auto rounded-lg border bg-card">
          <Table data-testid="price-grid">
            <TableHeader>
              <TableRow>
                <TableHead>{tp.priceRow}</TableHead>
                {SLOT_KINDS.map((k) => (
                  <TableHead key={k}>{tp.slotKinds[k]}</TableHead>
                ))}
                <TableHead>
                  <span className="sr-only">{t.common.actions}</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => {
                const locked = !row.isActive;
                return (
                  <TableRow key={row.id ?? "regular"} className={locked ? "opacity-60" : undefined}>
                    <TableCell className="font-medium whitespace-nowrap">
                      {row.name}
                      {locked && <p className="text-xs font-normal text-muted-foreground">{tp.inactiveSeason}</p>}
                    </TableCell>
                    {SLOT_KINDS.map((slotKind) => {
                      const key = cellKey(slotKind, row.id);
                      const cellErr = cellError(slotKind, row.id);
                      return (
                        <TableCell key={slotKind} className="min-w-28">
                          <Input
                            aria-label={`${row.name} — ${tp.slotKinds[slotKind]}`}
                            data-testid={`price-${row.id === null ? "regular" : row.id}-${slotKind}`}
                            inputMode="decimal"
                            dir="ltr"
                            className="text-start"
                            readOnly={locked}
                            value={cells[key] ?? ""}
                            aria-invalid={cellErr ? true : undefined}
                            onChange={(e) => setCells((c) => ({ ...c, [key]: e.target.value }))}
                          />
                          {cellErr && <p className="mt-1 text-xs text-destructive">{cellErr}</p>}
                        </TableCell>
                      );
                    })}
                    <TableCell>
                      {locked && (
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-sm"
                          aria-label={`${tp.clearSeason}: ${row.name}`}
                          onClick={() =>
                            setCells((c) => {
                              const next = { ...c };
                              for (const k of SLOT_KINDS) delete next[cellKey(k, row.id)];
                              return next;
                            })
                          }
                        >
                          <Trash2 />
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
        {(fieldErrors.prices || live) && (
          <p className="text-sm text-destructive" data-testid="prices-error">
            {fieldErrors.prices ?? (live ? messages[live] : "")}
          </p>
        )}
        <p className="flex items-start gap-2 text-sm text-muted-foreground" data-testid="price-note">
          <Info aria-hidden className="mt-0.5 size-4 shrink-0" />
          {tp.priceNote}
        </p>
      </section>

      <section className="grid gap-2" aria-labelledby="items-title">
        <h3 id="items-title" className="font-semibold">
          {tp.items}
        </h3>
        <p className="text-sm text-muted-foreground">{tp.itemsHint}</p>
        <div className="overflow-x-auto rounded-lg border bg-card">
          <Table data-testid="item-table">
            <TableHeader>
              <TableRow>
                <TableHead>{t.settings.name}</TableHead>
                <TableHead>{tp.quantity}</TableHead>
                <TableHead>{tp.removable}</TableHead>
                <TableHead>{tp.removalCredit}</TableHead>
                <TableHead>
                  <span className="sr-only">{t.common.actions}</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.length === 0 && (
                <TableRow>
                  <TableCell colSpan={5} className="text-muted-foreground">
                    {tp.noItems}
                  </TableCell>
                </TableRow>
              )}
              {items.map((item, index) => {
                const service = serviceById.get(item.serviceId);
                const perUnit = service?.pricingType === "per_unit";
                const err = (field: string) => fieldErrors[`items.${index}.${field}`];
                return (
                  <TableRow key={item.serviceId} data-testid="item-row">
                    <TableCell className="font-medium">
                      {service?.name}
                      <span className="ms-2 text-xs text-muted-foreground">
                        {service && t.settings.services.pricingTypes[service.pricingType]}
                      </span>
                      {service && !service.isActive && (
                        <Badge variant="destructive" className="ms-2">
                          {tp.inactiveService}
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell className="min-w-24">
                      <Input
                        aria-label={`${tp.quantity}: ${service?.name}`}
                        inputMode="numeric"
                        dir="ltr"
                        className="text-start"
                        disabled={!perUnit}
                        title={perUnit ? undefined : tp.quantityFixed}
                        value={perUnit ? item.quantity : "1"}
                        aria-invalid={err("quantity") ? true : undefined}
                        onChange={(e) => setItem(index, { quantity: e.target.value })}
                      />
                      {err("quantity") && <p className="mt-1 text-xs text-destructive">{err("quantity")}</p>}
                    </TableCell>
                    <TableCell>
                      <Checkbox
                        aria-label={`${tp.removable}: ${service?.name}`}
                        checked={item.removable}
                        onCheckedChange={(c) => setItem(index, { removable: c === true })}
                      />
                    </TableCell>
                    <TableCell className="min-w-28">
                      <Input
                        aria-label={`${tp.removalCredit}: ${service?.name}`}
                        inputMode="decimal"
                        dir="ltr"
                        className="text-start"
                        disabled={!item.removable}
                        value={item.removable ? item.removalCredit : ""}
                        aria-invalid={err("removalCredit") ? true : undefined}
                        onChange={(e) => setItem(index, { removalCredit: e.target.value })}
                      />
                      {err("removalCredit") && <p className="mt-1 text-xs text-destructive">{err("removalCredit")}</p>}
                    </TableCell>
                    <TableCell>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`${tp.removeItem}: ${service?.name}`}
                        onClick={() => setItems((current) => current.filter((_, i) => i !== index))}
                      >
                        <Trash2 />
                      </Button>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
        {fieldErrors.items && <p className="text-sm text-destructive">{fieldErrors.items}</p>}
        {services.length === 0 ? (
          <p className="text-sm text-muted-foreground">{tp.noServices}</p>
        ) : (
          addable.length > 0 && (
            <div className="grid gap-1.5">
              <Label htmlFor="add-item">{tp.addItem}</Label>
              <Select
                value=""
                onValueChange={(serviceId) =>
                  setItems((current) => [...current, { serviceId, quantity: "1", removable: false, removalCredit: "" }])
                }
              >
                <SelectTrigger id="add-item" className="w-full sm:w-72" data-testid="add-item">
                  <SelectValue placeholder={tp.chooseService} />
                </SelectTrigger>
                <SelectContent>
                  {addable.map((s) => (
                    <SelectItem key={s.id} value={s.id}>
                      {s.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )
        )}
      </section>

      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" disabled={pending}>
          {pending ? t.common.saving : t.common.save}
        </Button>
        {saved.note}
      </div>
    </form>
  );
}
