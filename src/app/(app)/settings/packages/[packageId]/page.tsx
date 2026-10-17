import { PackageForm } from "@/components/catalog/package-form";
import { getPackagePageData } from "@/server/dal";

/** Edits a package with its prices and items, on the version it was opened on (D-81). */
export default async function EditPackagePage({ params }: PageProps<"/settings/packages/[packageId]">) {
  const { packageId } = await params;
  const { package: pkg, ...options } = await getPackagePageData(packageId);
  return <PackageForm {...options} package={pkg} />;
}
