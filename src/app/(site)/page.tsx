import Link from "next/link";
import { BookingSearch } from "@/components/booking-search";
import { PhotoFrame } from "@/components/photo";
import { Container, Eyebrow, FactText, ButtonLink } from "@/components/ui";
import { photo } from "@/content/photos";
import { property, searchLimits } from "@/content/property";
import { pageMetadata } from "@/lib/metadata";

export const metadata = pageMetadata(
  "/",
  `${property.name} — lakeside lodge in South Lakeland`,
  "A quiet lakeside lodge at South Lakeland Leisure Village, near the Lake District, offered directly by its owner.",
);

const TIME_ZONE = "Europe/London";

export default function HomePage() {
  return (
    <>
      <section aria-labelledby="hero-title" className="relative">
        <Container className="grid gap-10 pt-10 pb-14 sm:pt-14 lg:grid-cols-[1.05fr_1fr] lg:items-center lg:gap-14 lg:pb-20">
          <div>
            <Eyebrow>{property.location.setting.value}</Eyebrow>
            <h1 id="hero-title" className="mt-4 text-display">
              Slow mornings, <em className="text-pine-700">lake light</em>, and
              room to breathe.
            </h1>
            <p className="mt-6 max-w-xl text-lg leading-relaxed text-ink-muted">
              {property.name} is a lakeside lodge{" "}
              {property.location.region.value}: a calm base for walking,
              reading, and doing very little at all.
            </p>
          </div>
          <PhotoFrame
            photo={photo("hero")}
            priority
            sizes="(min-width: 1024px) 50vw, 100vw"
            aspect="aspect-[5/4]"
          />
        </Container>

        <Container className="pb-16 lg:-mt-6">
          <h2 className="sr-only">Search dates</h2>
          <BookingSearch
            maxGuests={searchLimits.maxGuests}
            minNights={searchLimits.minNights}
            timeZone={TIME_ZONE}
          />
          <p className="mt-3 text-sm text-ink-muted">
            Online booking opens soon. Searching now shows what to expect;
            nothing is reserved.
          </p>
        </Container>
      </section>

      <section
        aria-labelledby="lodge-title"
        className="border-y border-sage-300/60 bg-limestone/60"
      >
        <Container className="grid gap-12 py-16 sm:py-20 lg:grid-cols-[1fr_1.1fr]">
          <div>
            <Eyebrow>The lodge</Eyebrow>
            <h2 id="lodge-title" className="mt-3 text-title">
              Made for unhurried days
            </h2>
            <p className="mt-5 max-w-lg text-lg leading-relaxed text-ink-muted">
              Space for family or friends, a deck for long evenings, and views
              across the water. Everything you need is set out simply, so the
              setting can take centre stage.
            </p>
            <ButtonLink href="/stay" variant="secondary" className="mt-8">
              Inside the lodge
            </ButtonLink>
          </div>

          <dl className="grid grid-cols-2 gap-px self-start overflow-hidden rounded-soft border border-sage-300 bg-sage-300">
            <Stat label="Sleeps">
              <FactText fact={property.sleeps} render={(n) => `Up to ${n}`} />
            </Stat>
            <Stat label="Bedrooms">
              <FactText fact={property.bedrooms} />
            </Stat>
            <Stat label="Bathrooms">
              <FactText fact={property.bathrooms} />
            </Stat>
            <Stat label="Outside">
              <FactText fact={property.features[1]} />
            </Stat>
          </dl>
        </Container>
      </section>

      <section aria-labelledby="setting-title">
        <Container className="grid gap-12 py-16 sm:py-20 lg:grid-cols-2 lg:items-center">
          <PhotoFrame
            photo={photo("deck-view")}
            sizes="(min-width: 1024px) 50vw, 100vw"
          />
          <div>
            <Eyebrow>The setting</Eyebrow>
            <h2 id="setting-title" className="mt-3 text-title">
              On the edge of the Lake District
            </h2>
            <p className="mt-5 max-w-lg text-lg leading-relaxed text-ink-muted">
              The lodge sits within {property.location.setting.value},{" "}
              {property.location.region.value}. Local recommendations from the
              owner — walks, places to eat, and rainy-day ideas — are on their
              way.
            </p>
            <Link
              href="/location"
              className="mt-8 inline-flex min-h-11 items-center font-semibold text-pine-800 underline underline-offset-4"
            >
              Location and getting here
            </Link>
          </div>
        </Container>
      </section>

      <section
        aria-labelledby="direct-title"
        className="bg-pine-900 text-sage-100"
      >
        <Container className="grid gap-10 py-16 sm:py-20 lg:grid-cols-[1.2fr_1fr] lg:items-end">
          <div>
            <h2 id="direct-title" className="text-title text-ivory">
              Book with the people who look after the lodge
            </h2>
            <p className="mt-5 max-w-xl text-lg leading-relaxed">
              When direct booking opens you&rsquo;ll see live availability, the
              full price including every fee, and the payment schedule before
              you pay anything. Until then, we&rsquo;re happy to answer
              questions.
            </p>
          </div>
          <div className="flex flex-wrap gap-3 lg:justify-end">
            <ButtonLink href="/contact" variant="light">
              Contact the owner
            </ButtonLink>
          </div>
        </Container>
      </section>
    </>
  );
}

function Stat({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="bg-ivory p-5 sm:p-6">
      <dt className="text-sm font-semibold tracking-[0.12em] text-sage-600 uppercase">
        {label}
      </dt>
      <dd className="mt-2 font-display text-2xl text-pine-900">{children}</dd>
    </div>
  );
}
