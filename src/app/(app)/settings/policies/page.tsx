import { PoliciesForm } from "@/components/settings/policies-form";
import { getVenueSettingsPageData } from "@/server/dal";

/** S-13 "السياسات" (`settings.manage`). */
export default async function PoliciesSettingsPage() {
  return <PoliciesForm settings={await getVenueSettingsPageData()} />;
}
