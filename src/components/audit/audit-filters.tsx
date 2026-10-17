"use client";

import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { t } from "@/lib/i18n";
import { AUDIT_ENTITY_TYPES } from "@/modules/audit/catalog";

const ALL = "all";

type Props = {
  actors: { id: string; name: string }[];
  values: { actor?: string; entity?: string; from?: string; to?: string };
};

/** A plain GET form: filters live in the URL, so they survive reloads and can be shared. */
export function AuditFilters({ actors, values }: Props) {
  function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    // Drop the "all" placeholders so the URL only carries real filters.
    for (const select of event.currentTarget.querySelectorAll<HTMLSelectElement>("select")) {
      if (select.value === ALL) select.disabled = true;
    }
  }

  return (
    <form
      method="get"
      onSubmit={onSubmit}
      className="grid gap-3 rounded-lg border bg-card p-4 sm:grid-cols-5 sm:items-end"
    >
      <div className="grid gap-1.5">
        <Label htmlFor="audit-actor">{t.audit.actor}</Label>
        <Select name="actor" defaultValue={values.actor ?? ALL}>
          <SelectTrigger id="audit-actor" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>{t.audit.allActors}</SelectItem>
            {actors.map((a) => (
              <SelectItem key={a.id} value={a.id}>
                {a.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="audit-entity">{t.audit.entityType}</Label>
        <Select name="entity" defaultValue={values.entity ?? ALL}>
          <SelectTrigger id="audit-entity" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>{t.audit.allEntities}</SelectItem>
            {AUDIT_ENTITY_TYPES.map((e) => (
              <SelectItem key={e} value={e}>
                {t.audit.entities[e]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="audit-from">{t.audit.from}</Label>
        <Input id="audit-from" type="date" name="from" defaultValue={values.from} />
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="audit-to">{t.audit.to}</Label>
        <Input id="audit-to" type="date" name="to" defaultValue={values.to} />
      </div>
      <div className="flex gap-2">
        <Button type="submit">{t.audit.apply}</Button>
        <Button asChild variant="outline">
          <Link href="/audit">{t.audit.reset}</Link>
        </Button>
      </div>
    </form>
  );
}
