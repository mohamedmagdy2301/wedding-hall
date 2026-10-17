import { VenueForm } from "@/components/settings/venue-form";
import { getVenueSettingsPageData } from "@/server/dal";

/** S-13 "بيانات المنشأة" (`settings.manage`). */
export default async function VenueSettingsPage() {
  const { name, phone, address } = await getVenueSettingsPageData();
  return <VenueForm name={name} phone={phone} address={address} />;
}
