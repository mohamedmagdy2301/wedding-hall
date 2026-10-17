import { PackageForm } from "@/components/catalog/package-form";
import { getNewPackagePageData } from "@/server/dal";

/** A new package on a full page (P3-14): data, prices per slot × season, included services. */
export default async function NewPackagePage() {
  const options = await getNewPackagePageData();
  return <PackageForm {...options} />;
}
