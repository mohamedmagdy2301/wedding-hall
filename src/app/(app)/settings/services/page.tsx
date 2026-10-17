import { ServicesPanel } from "@/components/catalog/services-panel";
import { getServicesPageData } from "@/server/dal";

/** S-13 "الخدمات" (`catalog.manage`). */
export default async function ServicesSettingsPage() {
  const { services } = await getServicesPageData();
  return <ServicesPanel services={services} />;
}
