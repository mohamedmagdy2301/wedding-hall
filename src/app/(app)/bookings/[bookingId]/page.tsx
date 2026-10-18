import { BookingView } from "@/components/bookings/booking-view";
import { getBookingPageData } from "@/server/dal";

/** S-07 (`bookings.view`). */
export default async function BookingPage({ params }: PageProps<"/bookings/[bookingId]">) {
  const { bookingId } = await params;
  const data = await getBookingPageData(bookingId);
  return <BookingView data={data} />;
}
