import Link from "next/link";
import { Container, DraftNotice, PageHeader } from "@/components/ui";
import { pageMetadata } from "@/lib/metadata";

export const metadata = pageMetadata(
  "/cancellation-policy",
  "Cancellation policy",
  "How cancellations and refunds work for direct bookings at Lodge on the Lake.",
);

export default function CancellationPolicyPage() {
  return (
    <>
      <PageHeader eyebrow="Policies" title="Cancellation policy" />
      <Container className="py-14 sm:py-16">
        <div className="prose-lodge">
          <h2>Free cancellation for 24 hours</h2>
          <p>
            You can cancel for a <strong>full refund</strong> within 24 hours of
            making your booking. The 24 hours start when you submit your booking
            (when we first hold your dates), not when your payment completes,
            and they don&rsquo;t restart.
          </p>
          <p>
            After that, your booking is <strong>non-refundable</strong>.
          </p>
          <h2>How it works</h2>
          <ul>
            <li>
              The exact time your free cancellation ends is shown before you
              pay, on the payment page and in your confirmation email.
            </li>
            <li>
              To get a refund, your cancellation must reach us{" "}
              <strong>before</strong> that time. A cancellation received at or
              after it is non-refundable.
            </li>
            <li>
              Cancel from your booking page (the link in your confirmation
              email). You&rsquo;ll see whether a refund applies before you
              confirm.
            </li>
            <li>
              Refunds go back to the card you paid with. We&rsquo;ll email you
              when our payment provider confirms the refund; banks usually take
              5–10 working days to show it.
            </li>
          </ul>
          <DraftNotice title="Still to be confirmed">
            What happens if we ever need to cancel your stay, and how no-shows,
            late arrivals and early departures are handled, are still being
            finalised. This page is also awaiting legal review.
          </DraftNotice>
          <p>
            Your statutory rights are not affected. Questions?{" "}
            <Link href="/contact">Contact us</Link>.
          </p>
        </div>
      </Container>
    </>
  );
}
