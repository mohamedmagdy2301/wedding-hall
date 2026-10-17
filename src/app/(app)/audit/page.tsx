import { z } from "zod";
import { AuditFilters } from "@/components/audit/audit-filters";
import { AuditTable } from "@/components/audit/audit-table";
import { t } from "@/lib/i18n";
import { AUDIT_ENTITY_TYPES } from "@/modules/audit/catalog";
import { getAuditPageData } from "@/server/dal";

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const filtersSchema = z.object({
  actor: z.uuid().optional().catch(undefined),
  entity: z.enum(AUDIT_ENTITY_TYPES).optional().catch(undefined),
  from: date.optional().catch(undefined),
  to: date.optional().catch(undefined),
  page: z.coerce.number().int().min(1).max(10_000).optional().catch(undefined),
});

/** S-16 (`audit.view`). Filters come from the URL and are validated before use (SEC-20). */
export default async function AuditPage({ searchParams }: PageProps<"/audit">) {
  const raw = await searchParams;
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) || undefined;
  const filters = filtersSchema.parse({
    actor: one(raw.actor),
    entity: one(raw.entity),
    from: one(raw.from),
    to: one(raw.to),
    page: one(raw.page),
  });
  const data = await getAuditPageData({
    actorId: filters.actor,
    entityType: filters.entity,
    from: filters.from,
    to: filters.to,
    page: filters.page,
  });

  return (
    <section className="grid gap-4">
      <h1 className="text-2xl font-bold">{t.audit.title}</h1>
      <AuditFilters actors={data.actors} values={filters} />
      <AuditTable
        rows={data.rows}
        total={data.total}
        page={data.page}
        pageSize={data.pageSize}
        query={{ actor: filters.actor, entity: filters.entity, from: filters.from, to: filters.to }}
      />
    </section>
  );
}
