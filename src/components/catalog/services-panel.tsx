"use client";

import { MoreHorizontal, Plus } from "lucide-react";
import { useState } from "react";
import { ConfirmDialog } from "@/components/forms/confirm-dialog";
import { Field, FormError } from "@/components/forms/field";
import { SelectField } from "@/components/forms/select-field";
import { useServerAction } from "@/components/forms/use-server-action";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { PricingType, ServiceCategory } from "@/domain/catalog";
import { formatPiasters, piastersToInput } from "@/domain/money";
import { t } from "@/lib/i18n";
import type { ServiceRow } from "@/modules/catalog/services";
import { createServiceAction, setServiceActiveAction, updateServiceAction } from "@/server/actions/catalog";

const ts = t.settings.services;

function ServiceDialog({ service, onOpenChange }: { service?: ServiceRow; onOpenChange: (open: boolean) => void }) {
  const create = useServerAction(createServiceAction);
  const update = useServerAction(updateServiceAction);
  const { pending, error } = service ? update : create;
  const [category, setCategory] = useState<ServiceCategory>(service?.category ?? "service");
  const [pricingType, setPricingType] = useState<PricingType>(service?.pricingType ?? "fixed");
  const [allowExternal, setAllowExternal] = useState(service?.allowExternal ?? false);
  // The pricing type gives a package's quantity its meaning (D-80).
  const typeLocked = (service?.packageCount ?? 0) > 0;

  function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const input = {
      name: form.get("name"),
      category,
      pricingType,
      unitPrice: form.get("unitPrice"),
      allowExternal,
      externalFee: allowExternal ? form.get("externalFee") : "",
    };
    const done = () => onOpenChange(false);
    if (service) update.run({ ...input, serviceId: service.id }, done);
    else create.run(input, done);
  }

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{service ? ts.editTitle : ts.add}</DialogTitle>
        </DialogHeader>
        <form onSubmit={onSubmit} className="grid gap-4" noValidate>
          <FormError error={error?.fieldErrors ? null : error} />
          <Field label={t.settings.name} name="name" defaultValue={service?.name} error={error?.fieldErrors?.name} />
          <SelectField
            label={ts.category}
            value={category}
            onChange={setCategory}
            options={ts.categories}
            testId="service-category"
          />
          <SelectField
            label={ts.pricingType}
            value={pricingType}
            onChange={setPricingType}
            options={ts.pricingTypes}
            testId="service-pricing-type"
            disabled={typeLocked}
            hint={typeLocked ? ts.pricingTypeLocked : undefined}
            error={error?.fieldErrors?.pricingType}
          />
          <Field
            label={ts.unitPrice}
            name="unitPrice"
            inputMode="decimal"
            dir="ltr"
            className="text-start"
            defaultValue={service ? piastersToInput(service.unitPrice) : ""}
            hint={ts.unitPriceHint}
            error={error?.fieldErrors?.unitPrice}
          />
          <div className="flex items-center gap-2">
            <Checkbox
              id="allow-external"
              checked={allowExternal}
              onCheckedChange={(c) => setAllowExternal(c === true)}
            />
            <Label htmlFor="allow-external" className="font-normal">
              {ts.allowExternal}
            </Label>
          </div>
          {allowExternal && (
            <Field
              label={ts.externalFee}
              name="externalFee"
              inputMode="decimal"
              dir="ltr"
              className="text-start"
              defaultValue={service?.externalFee ? piastersToInput(service.externalFee) : ""}
              hint={ts.externalFeeHint}
              error={error?.fieldErrors?.externalFee}
            />
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              {t.common.cancel}
            </Button>
            <Button type="submit" disabled={pending}>
              {pending ? t.common.saving : t.common.save}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

const ALL = "all";

/** S-13 "الخدمات" (`catalog.manage`, D-12, D-13, D-39). No delete: deactivate only (D-82). */
export function ServicesPanel({ services }: { services: ServiceRow[] }) {
  const [dialog, setDialog] = useState<{ kind: "create" } | { kind: "edit" | "toggle"; service: ServiceRow } | null>(
    null,
  );
  const [filter, setFilter] = useState<ServiceCategory | typeof ALL>(ALL);
  const setActive = useServerAction(setServiceActiveAction);
  const close = () => setDialog(null);
  const shown = filter === ALL ? services : services.filter((s) => s.category === filter);

  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <Button onClick={() => setDialog({ kind: "create" })}>
          <Plus />
          {ts.add}
        </Button>
        <SelectField
          label={ts.category}
          value={filter}
          onChange={setFilter}
          options={{ [ALL]: ts.allCategories, ...ts.categories }}
          testId="service-filter"
        />
      </div>
      <div className="overflow-x-auto rounded-lg border bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t.settings.name}</TableHead>
              <TableHead>{ts.category}</TableHead>
              <TableHead>{ts.pricingType}</TableHead>
              <TableHead>{ts.price}</TableHead>
              <TableHead>{ts.external}</TableHead>
              <TableHead>{ts.inPackages}</TableHead>
              <TableHead>{t.settings.status}</TableHead>
              <TableHead>
                <span className="sr-only">{t.common.actions}</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {shown.length === 0 && (
              <TableRow>
                <TableCell colSpan={8} className="text-muted-foreground">
                  {t.settings.empty}
                </TableCell>
              </TableRow>
            )}
            {shown.map((service) => (
              <TableRow key={service.id} data-testid="service-row">
                <TableCell className="font-medium">{service.name}</TableCell>
                <TableCell>{ts.categories[service.category]}</TableCell>
                <TableCell className="whitespace-nowrap">{ts.pricingTypes[service.pricingType]}</TableCell>
                <TableCell className="whitespace-nowrap">{formatPiasters(service.unitPrice)}</TableCell>
                <TableCell className="whitespace-nowrap">
                  {!service.allowExternal
                    ? ts.externalNotAllowed
                    : service.externalFee > 0
                      ? `${ts.externalAllowed} ${formatPiasters(service.externalFee)}`
                      : ts.externalNoFee}
                </TableCell>
                <TableCell>{service.packageCount}</TableCell>
                <TableCell>
                  <Badge variant={service.isActive ? "outline" : "destructive"}>
                    {service.isActive ? t.settings.active : t.settings.inactive}
                  </Badge>
                </TableCell>
                <TableCell>
                  <div className="flex justify-end">
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon-sm" aria-label={`${t.common.actions}: ${service.name}`}>
                          <MoreHorizontal />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onSelect={() => setDialog({ kind: "edit", service })}>
                          {t.settings.edit}
                        </DropdownMenuItem>
                        <DropdownMenuItem onSelect={() => setDialog({ kind: "toggle", service })}>
                          {service.isActive ? t.settings.deactivate : t.settings.activate}
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      {dialog?.kind === "create" && <ServiceDialog onOpenChange={close} />}
      {dialog?.kind === "edit" && <ServiceDialog service={dialog.service} onOpenChange={close} />}
      {dialog?.kind === "toggle" && (
        <ConfirmDialog
          open
          onOpenChange={close}
          title={`${dialog.service.isActive ? ts.deactivateTitle : t.settings.activate}: ${dialog.service.name}`}
          description={
            dialog.service.isActive
              ? [
                  ts.deactivateDescription,
                  dialog.service.packageCount > 0
                    ? ts.deactivateInPackages.replace("{n}", String(dialog.service.packageCount))
                    : "",
                ]
                  .filter(Boolean)
                  .join(" ")
              : ""
          }
          confirmLabel={dialog.service.isActive ? t.settings.deactivate : t.settings.activate}
          destructive={dialog.service.isActive}
          pending={setActive.pending}
          error={setActive.error}
          onConfirm={() => setActive.run({ serviceId: dialog.service.id, active: !dialog.service.isActive }, close)}
        />
      )}
    </div>
  );
}
