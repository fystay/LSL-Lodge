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
          <DraftNotice title="Awaiting owner approval">
            The cancellation and refund terms have not been set yet. No booking
            can be made until the owner has approved this policy, and it will be
            shown to you in full before you pay.
          </DraftNotice>
          <h2>What this policy will cover</h2>
          <ul>
            <li>How much notice is needed for a full or partial refund.</li>
            <li>What happens to a deposit, and to a balance already paid.</li>
            <li>How to cancel, and how long refunds take to reach you.</li>
            <li>What happens if we ever need to cancel your stay.</li>
            <li>Arriving late, leaving early, and no-shows.</li>
          </ul>
          <p>
            Your statutory rights are not affected. Questions?{" "}
            <Link href="/contact">Contact us</Link>.
          </p>
        </div>
      </Container>
    </>
  );
}
