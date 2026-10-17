import { PackagesList } from "@/components/catalog/packages-list";
import { getPackagesPageData } from "@/server/dal";

/** S-13 "الباكيجات" (`catalog.manage`): every package grouped by its space. */
export default async function PackagesSettingsPage() {
  const { packages } = await getPackagesPageData();
  return <PackagesList packages={packages} />;
}
