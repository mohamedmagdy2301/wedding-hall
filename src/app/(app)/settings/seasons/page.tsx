import { SeasonsPanel } from "@/components/settings/seasons-panel";
import { getSeasonsPageData } from "@/server/dal";

/** S-13 "المواسم" (`catalog.manage`, D-66). */
export default async function SeasonsSettingsPage() {
  const { seasons } = await getSeasonsPageData();
  return <SeasonsPanel seasons={seasons} />;
}
