import { Container, DraftNotice, FactText, PageHeader } from "@/components/ui";
import { property } from "@/content/property";
import { pageMetadata } from "@/lib/metadata";

export const metadata = pageMetadata(
  "/privacy",
  "Privacy notice",
  "How Lodge on the Lake collects, uses and protects personal information.",
);

/**
 * Draft privacy notice describing what this website actually does. Must be
 * completed by the owner (controller details, retention periods) and reviewed
 * against UK GDPR / Data Protection Act 2018 before launch.
 */
export default function PrivacyPage() {
  return (
    <>
      <PageHeader eyebrow="Policies" title="Privacy notice" />
      <Container className="py-14 sm:py-16">
        <div className="prose-lodge">
          <DraftNotice title="Draft — awaiting owner details and legal review">
            This notice describes how the website is designed to handle personal
            information. It will be completed and reviewed before bookings open.
          </DraftNotice>

          <h2>Who we are</h2>
          <p>
            The data controller is{" "}
            <FactText
              fact={property.contact.legalName}
              missing="the owner of Lodge on the Lake (legal name to follow)"
            />
            . Contact:{" "}
            <FactText
              fact={property.contact.email}
              missing="email address to follow"
            />
            .
          </p>

          <h2>What we collect and why</h2>
          <ul>
            <li>
              <strong>Enquiries:</strong> your name, email address and message,
              so we can reply.
            </li>
            <li>
              <strong>Bookings:</strong> your name, email address, stay dates
              and number of guests, so we can provide your stay and contact you
              about it. A phone number only if needed to reach you about your
              arrival.
            </li>
            <li>
              <strong>Payments:</strong> handled by Stripe on its own secure
              pages. We never see or store your card details; we keep a record
              of the amounts paid.
            </li>
          </ul>

          <h2>Calendars</h2>
          <p>
            To prevent double bookings we exchange availability with Airbnb and
            the owner&rsquo;s calendar. Only dates are shared and imported, not
            guest details.
          </p>

          <h2>Cookies</h2>
          <p>
            The website uses only cookies that are strictly necessary for it to
            work. We do not use advertising or analytics cookies. If that
            changes, we will ask for your consent first.
          </p>

          <h2>How long we keep it</h2>
          <p>
            Retention periods are being confirmed. Booking records are kept for
            as long as needed for accounting and legal obligations, then
            deleted.
          </p>

          <h2>Your rights</h2>
          <p>
            You can ask for a copy of your information, ask us to correct or
            delete it, or object to how we use it. You can also complain to the
            Information Commissioner&rsquo;s Office (ico.org.uk).
          </p>
        </div>
      </Container>
    </>
  );
}
