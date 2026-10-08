import Link from "next/link";
import { Container, DraftNotice, FactText, PageHeader } from "@/components/ui";
import { property } from "@/content/property";
import { pageMetadata } from "@/lib/metadata";

export const metadata = pageMetadata(
  "/information",
  "Guest information",
  "Check-in and check-out, house rules, accessibility and practical information for Lodge on the Lake.",
);

export default function InformationPage() {
  return (
    <>
      <PageHeader eyebrow="Before you stay" title="Guest information">
        <p>The practical details, in one place.</p>
      </PageHeader>

      <Container className="py-14 sm:py-16">
        <dl className="max-w-3xl divide-y divide-sage-300/70 border-y border-sage-300/70">
          <Item term="Check-in">
            <FactText fact={property.checkInTime} render={(t) => `From ${t}`} />
          </Item>
          <Item term="Check-out">
            <FactText fact={property.checkOutTime} render={(t) => `By ${t}`} />
          </Item>
          <Item term="Minimum stay">
            <FactText
              fact={property.minimumStayNights}
              render={(n) => `${n} night${n === 1 ? "" : "s"}`}
            />
          </Item>
          <Item term="Maximum guests">
            <FactText fact={property.sleeps} />
          </Item>
          <Item term="Pets">
            <FactText fact={property.pets} />
          </Item>
          <Item term="Smoking">
            <FactText fact={property.smoking} />
          </Item>
          <Item term="Accessibility">
            <FactText fact={property.accessibility} />
          </Item>
          <Item term="Parking">
            <FactText fact={property.parking} />
          </Item>
        </dl>

        <section aria-labelledby="rules-title" className="mt-14 max-w-3xl">
          <h2 id="rules-title" className="text-2xl">
            House rules
          </h2>
          <div className="mt-4">
            <DraftNotice title="House rules awaiting the owner">
              The owner&rsquo;s house rules, including any leisure-village rules
              that apply to guests, will be published here before booking opens.
            </DraftNotice>
          </div>
        </section>

        <section
          aria-labelledby="calendar-title"
          className="prose-lodge mt-14 max-w-3xl"
        >
          <h2 id="calendar-title">How availability works</h2>
          <p>
            The lodge is also listed on Airbnb. Calendars are kept in step
            automatically, but updates between booking channels are not instant:
            they can take some time to pass between systems. Dates are only
            secured once our server has placed a hold for you during booking,
            and confirmed once payment is verified.
          </p>
          <p>
            Questions about a stay?{" "}
            <Link href="/contact">Contact the owner</Link>.
          </p>
        </section>
      </Container>
    </>
  );
}

function Item({ term, children }: { term: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-1 py-4 sm:grid-cols-[12rem_1fr] sm:gap-6">
      <dt className="font-semibold text-pine-900">{term}</dt>
      <dd>{children}</dd>
    </div>
  );
}
