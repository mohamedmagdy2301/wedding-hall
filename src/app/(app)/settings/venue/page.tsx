import { LogoPanel } from "@/components/settings/logo-panel";
import { VenueForm } from "@/components/settings/venue-form";
import { getVenueSettingsPageData } from "@/server/dal";

/** S-13 "بيانات المنشأة" (`settings.manage`), with the logo (D-70). */
export default async function VenueSettingsPage() {
  const { name, phone, address, logoUrl } = await getVenueSettingsPageData();
  return (
    <div className="grid gap-8">
      <VenueForm name={name} phone={phone} address={address} />
      <LogoPanel logoUrl={logoUrl} />
    </div>
  );
}
