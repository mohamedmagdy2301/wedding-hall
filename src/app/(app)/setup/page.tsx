import { SetupChecklist } from "@/components/settings/setup-checklist";
import { t } from "@/lib/i18n";
import { getSetupPageData } from "@/server/dal";

/** S-14 the owner's guided setup (UF-02). */
export default async function SetupPage() {
  const { steps, timing } = await getSetupPageData();
  return (
    <section className="grid max-w-3xl gap-4">
      <h1 className="text-2xl font-bold">{t.setup.title}</h1>
      <p className="text-muted-foreground">{t.setup.intro}</p>
      <SetupChecklist steps={steps} timing={timing} />
      <p className="text-sm text-muted-foreground">{t.setup.readiness}</p>
    </section>
  );
}
