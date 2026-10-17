import { SettingsNav } from "@/components/settings/settings-nav";
import { SETTINGS_REQUIREMENTS, SETTINGS_TABS } from "@/components/settings/tabs";
import { t } from "@/lib/i18n";
import { satisfies } from "@/modules/users-rbac/authorize";
import { requireAnyAccess } from "@/server/dal";

/** S-13 shell. An extra layer only: every tab page checks its own permission (P1-08). */
export default async function SettingsLayout({ children }: LayoutProps<"/settings">) {
  const user = await requireAnyAccess(SETTINGS_REQUIREMENTS);
  const tabs = SETTINGS_TABS.filter((tab) => satisfies(user, tab.requires)).map(({ key, href }) => ({ key, href }));
  return (
    <section className="grid gap-4">
      <h1 className="text-2xl font-bold">{t.settings.title}</h1>
      <SettingsNav tabs={tabs} />
      {children}
    </section>
  );
}
