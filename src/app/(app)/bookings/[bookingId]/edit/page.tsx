import { BookingWizard } from "@/components/bookings/booking-wizard";
import { getEditBookingPageData } from "@/server/dal";

/** S-06 editing a tentative booking on the version it was opened on (D-101). */
export default async function EditBookingPage({ params }: PageProps<"/bookings/[bookingId]/edit">) {
  const { bookingId } = await params;
  const { booking, options, canView } = await getEditBookingPageData(bookingId);
  return <BookingWizard options={options} booking={booking} canView={canView} />;
}
