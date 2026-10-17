import { redirect } from "next/navigation";
import { SETTINGS_REQUIREMENTS, SETTINGS_TABS } from "@/components/settings/tabs";
import { satisfies } from "@/modules/users-rbac/authorize";
import { requireAnyAccess } from "@/server/dal";

/** Opens the first tab the user may see. */
export default async function SettingsPage() {
  const user = await requireAnyAccess(SETTINGS_REQUIREMENTS);
  const first = SETTINGS_TABS.find((tab) => satisfies(user, tab.requires));
  redirect(first?.href ?? "/forbidden");
}
