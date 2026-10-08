import { Gallery } from "@/components/gallery";
import {
  ButtonLink,
  Container,
  DraftNotice,
  FactText,
  PageHeader,
} from "@/components/ui";
import { photos } from "@/content/photos";
import { property } from "@/content/property";
import { pageMetadata } from "@/lib/metadata";

export const metadata = pageMetadata(
  "/stay",
  "The lodge",
  "Inside Lodge on the Lake: bedrooms, living space, decking and practical details.",
);

export default function StayPage() {
  return (
    <>
      <PageHeader eyebrow="The lodge" title="A lodge to settle into">
        <p>
          Three bedrooms, two bathrooms and space for up to six, with the lake
          in view. Room-by-room details and photographs are being prepared with
          the owner.
        </p>
      </PageHeader>

      <Container className="py-14 sm:py-16">
        <h2 className="sr-only">Photographs</h2>
        <Gallery photos={photos} />
        <p className="mt-4 text-sm text-ink-muted">
          Photography of the lodge is being arranged. Placeholders show the
          views that will appear here.
        </p>
      </Container>

      <section
        aria-labelledby="details-title"
        className="border-t border-sage-300/60"
      >
        <Container className="grid gap-12 py-14 sm:py-16 lg:grid-cols-[1fr_1.4fr]">
          <h2 id="details-title" className="text-title">
            At a glance
          </h2>
          <dl className="divide-y divide-sage-300/70 border-y border-sage-300/70">
            <Row term="Sleeps">
              <FactText
                fact={property.sleeps}
                render={(n) => `Up to ${n} guests`}
              />
            </Row>
            <Row term="Bedrooms">
              <FactText fact={property.bedrooms} />
            </Row>
            <Row term="Beds">
              <FactText
                fact={property.bedConfiguration}
                render={(beds) => beds.join(", ")}
              />
            </Row>
            <Row term="Bathrooms">
              <FactText fact={property.bathrooms} />
            </Row>
            <Row term="Outdoor space">
              <FactText fact={property.features[1]} />
            </Row>
            <Row term="Views">
              <FactText fact={property.features[0]} />
            </Row>
            <Row term="Parking">
              <FactText fact={property.parking} />
            </Row>
            <Row term="Wi-Fi">
              <FactText fact={property.wifi} />
            </Row>
            <Row term="Accessibility">
              <FactText fact={property.accessibility} />
            </Row>
          </dl>
        </Container>
      </section>

      <section aria-labelledby="amenities-title" className="bg-limestone/60">
        <Container className="py-14 sm:py-16">
          <h2 id="amenities-title" className="text-title">
            Amenities
          </h2>
          <div className="mt-6 max-w-2xl">
            <DraftNotice title="Amenities list awaiting the owner">
              Only facilities the owner has confirmed will be listed here, so
              you can rely on what you read. If something matters to your stay,
              please ask.
            </DraftNotice>
          </div>
          <ButtonLink href="/contact" variant="secondary" className="mt-8">
            Ask a question
          </ButtonLink>
        </Container>
      </section>
    </>
  );
}

function Row({ term, children }: { term: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-1 py-4 sm:grid-cols-[12rem_1fr] sm:gap-6">
      <dt className="font-semibold text-pine-900">{term}</dt>
      <dd className="text-ink">{children}</dd>
    </div>
  );
}
