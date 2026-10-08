import Link from "next/link";
import { Container, PageHeader } from "@/components/ui";
import { privateRouteMetadata } from "@/lib/metadata";

export const metadata = { title: "Your booking", ...privateRouteMetadata };

/**
 * Guest booking status. In Phase 2–3 this page will look up a booking by its
 * reference plus an unguessable access token (stored hashed), never by
 * reference alone, and show only that guest's booking.
 */
export default function BookingConfirmationPage() {
  return (
    <>
      <PageHeader eyebrow="Your booking" title="Booking status" />
      <Container className="py-14 sm:py-16">
        <div className="prose-lodge">
          <p>
            Online booking is not open yet, so there are no bookings to show. If
            you have arranged a stay with the owner, please{" "}
            <Link href="/contact">get in touch</Link> with any questions.
          </p>
        </div>
      </Container>
    </>
  );
}
