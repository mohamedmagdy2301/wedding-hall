import { z } from "zod";
import { BookingWizard } from "@/components/bookings/booking-wizard";
import { SLOT_KINDS } from "@/domain/catalog";
import { getNewBookingPageData } from "@/server/dal";

const prefillSchema = z.object({
  space: z.uuid().optional().catch(undefined),
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional()
    .catch(undefined),
  slot: z.enum(SLOT_KINDS).optional().catch(undefined),
});

/** S-06 (`bookings.create`). An empty calendar slot opens it with the space, date and slot (S-04). */
export default async function NewBookingPage({ searchParams }: PageProps<"/bookings/new">) {
  const raw = await searchParams;
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) || undefined;
  const prefill = prefillSchema.parse({ space: one(raw.space), date: one(raw.date), slot: one(raw.slot) });
  const { options, canView } = await getNewBookingPageData();
  return (
    <BookingWizard
      options={options}
      canView={canView}
      prefill={{ spaceId: prefill.space, date: prefill.date, slot: prefill.slot }}
    />
  );
}
