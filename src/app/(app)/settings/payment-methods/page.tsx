import { ListPanel } from "@/components/settings/list-panel";
import { SUGGESTED } from "@/modules/settings/lists";
import { getListPageData } from "@/server/dal";

/** S-13 "طرق الدفع" (`settings.manage`). */
export default async function PaymentMethodsSettingsPage() {
  const { items } = await getListPageData("paymentMethods");
  return <ListPanel kind="paymentMethods" items={items} suggested={SUGGESTED.paymentMethods.map((s) => s.name)} />;
}
