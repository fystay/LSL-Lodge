import { Container, DraftNotice, PageHeader } from "@/components/ui";
import { pageMetadata } from "@/lib/metadata";

export const metadata = pageMetadata(
  "/terms",
  "Booking terms",
  "Terms and conditions for direct bookings at Lodge on the Lake.",
);

export default function TermsPage() {
  return (
    <>
      <PageHeader eyebrow="Policies" title="Booking terms" />
      <Container className="py-14 sm:py-16">
        <div className="prose-lodge">
          <DraftNotice title="Awaiting owner approval and legal review">
            These terms have not been written yet. They will be reviewed before
            any booking can be made, and you will be asked to accept them before
            you pay.
          </DraftNotice>
          <h2>What the terms will cover</h2>
          <ul>
            <li>Who you are contracting with, and how to reach them.</li>
            <li>How a booking is made and when it is confirmed.</li>
            <li>Prices, deposits, balance payments and due dates.</li>
            <li>Occupancy, house rules and leisure-village rules.</li>
            <li>Damage, security deposits (if any) and liability.</li>
            <li>Changes, cancellations and complaints.</li>
          </ul>
          <h2>How booking will work</h2>
          <p>
            A booking is confirmed only once your payment has been verified by
            our payment provider and your dates have been secured. Being
            redirected back to this website after paying is not, on its own,
            confirmation; you will receive a confirmation email with your
            booking reference.
          </p>
        </div>
      </Container>
    </>
  );
}
