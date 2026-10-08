import { PhotoFrame } from "@/components/photo";
import { Container, DraftNotice, FactText, PageHeader } from "@/components/ui";
import { photo } from "@/content/photos";
import { property } from "@/content/property";
import { pageMetadata } from "@/lib/metadata";

export const metadata = pageMetadata(
  "/location",
  "Location",
  "Where to find Lodge on the Lake at South Lakeland Leisure Village, near the Lake District.",
);

export default function LocationPage() {
  return (
    <>
      <PageHeader eyebrow="Location" title="Finding the lodge">
        <p>
          {property.name} is at {property.location.setting.value},{" "}
          {property.location.region.value}.
        </p>
      </PageHeader>

      <Container className="pt-12 sm:pt-14">
        <figure className="mx-auto max-w-[75rem]">
          <PhotoFrame
            photo={photo("deck-view-fountain")}
            aspect="aspect-[16/9]"
            sizes="(min-width: 1152px) 72rem, 100vw"
            priority
          />
          <figcaption className="mt-2 text-sm text-ink-muted">
            The view from the deck across the water.
          </figcaption>
        </figure>
      </Container>

      <Container className="grid gap-12 py-14 sm:py-16 lg:grid-cols-[1fr_1.2fr]">
        <section aria-labelledby="address-title">
          <h2 id="address-title" className="text-2xl">
            Address
          </h2>
          <p className="mt-3 leading-relaxed">
            <FactText
              fact={property.location.address}
              missing="Full address to follow"
            />
          </p>
          <p className="mt-3 text-sm text-ink-muted">
            The precise address and arrival instructions are shared with
            confirmed guests.
          </p>

          <h2 className="mt-10 text-2xl">Getting here</h2>
          <div className="mt-3 leading-relaxed">
            <FactText
              fact={property.location.directions}
              missing="Directions to follow"
            />
          </div>
        </section>

        <section aria-labelledby="nearby-title">
          <h2 id="nearby-title" className="text-2xl">
            Nearby
          </h2>
          <div className="mt-4">
            <DraftNotice title="The owner’s recommendations are on their way">
              This page will share the owner&rsquo;s own suggestions: walks from
              the door, places to eat, days out in the Lakes, and ideas for
              rainy afternoons. We&rsquo;d rather wait than publish generic
              lists.
            </DraftNotice>
          </div>
        </section>
      </Container>
    </>
  );
}
