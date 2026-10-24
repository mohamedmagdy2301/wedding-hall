import { ApprovalsTable } from "@/components/discounts/approvals-table";
import { t } from "@/lib/i18n";
import { getApprovalsPageData } from "@/server/dal";

/** S-10 (`discounts.approve`): pending discount requests (BR-50, UF-06). */
export default async function ApprovalsPage() {
  const data = await getApprovalsPageData();
  return (
    <section className="grid gap-4">
      <h1 className="text-2xl font-bold">{t.discounts.approvalsTitle}</h1>
      <p className="text-sm text-muted-foreground">{t.discounts.pendingHint}</p>
      <ApprovalsTable rows={data.rows} creditMode={data.creditMode} methods={data.methods} />
    </section>
  );
}
