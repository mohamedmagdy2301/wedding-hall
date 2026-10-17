import { ListPanel } from "@/components/settings/list-panel";
import { SUGGESTED } from "@/modules/settings/lists";
import { getListPageData } from "@/server/dal";

/** S-13 "تصنيفات المصروفات" (`settings.manage`). */
export default async function ExpenseCategoriesSettingsPage() {
  const { items } = await getListPageData("expenseCategories");
  return (
    <ListPanel kind="expenseCategories" items={items} suggested={SUGGESTED.expenseCategories.map((s) => s.name)} />
  );
}
