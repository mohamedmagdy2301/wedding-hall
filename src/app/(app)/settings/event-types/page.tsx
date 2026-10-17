import { ListPanel } from "@/components/settings/list-panel";
import { SUGGESTED } from "@/modules/settings/lists";
import { getListPageData } from "@/server/dal";

/** S-13 "أنواع المناسبات" (`settings.manage`). */
export default async function EventTypesSettingsPage() {
  const { items } = await getListPageData("eventTypes");
  return <ListPanel kind="eventTypes" items={items} suggested={SUGGESTED.eventTypes.map((s) => s.name)} />;
}
