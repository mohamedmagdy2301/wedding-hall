import { SpacesPanel } from "@/components/settings/spaces-panel";
import { getSpacesPageData } from "@/server/dal";

/** S-13 "الأماكن والفترات" (`catalog.manage`). */
export default async function SpacesSettingsPage() {
  const { spaces, bufferMinutes } = await getSpacesPageData();
  return <SpacesPanel spaces={spaces} bufferMinutes={bufferMinutes} />;
}
