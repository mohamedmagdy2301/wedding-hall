import { TimingForm } from "@/components/settings/timing-form";
import { getVenueSettingsPageData } from "@/server/dal";

/** S-13 "الوقت الفاصل ومدة المبدئي" (`settings.manage`). */
export default async function TimingSettingsPage() {
  const { bufferMinutes, tentativeHoldHours, maxBufferMinutes } = await getVenueSettingsPageData();
  return (
    <TimingForm
      bufferMinutes={bufferMinutes}
      tentativeHoldHours={tentativeHoldHours}
      maxBufferMinutes={maxBufferMinutes}
    />
  );
}
