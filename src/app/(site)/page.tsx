import Link from "next/link";
import { BookingSearch } from "@/components/booking-search";
import { GalleryButton, GalleryProvider } from "@/components/gallery";
import { HeroCarousel } from "@/components/hero-carousel";
import { PhotoFrame } from "@/components/photo";
import { ButtonLink, Container, Eyebrow, FactText } from "@/components/ui";
import { galleryOrder, photo, photos, photosIn } from "@/content/photos";
import { property, searchLimits } from "@/content/property";
import { pageMetadata } from "@/lib/metadata";

export const metadata = pageMetadata(
  "/",
  `${property.name} — lakeside lodge in South Lakeland`,
  "A three-bedroom lodge with a deck over the water at South Lakeland Leisure Village, near the Lake District. Book direct with the owner.",
);

const TIME_ZONE = "Europe/London";

const heroSlides = [
  photo("lodge-across-water"),
  photo("deck-evening"),
  photo("main-bedroom-art"),
  photo("detail-roses"),
];

const allPhotos = galleryOrder.flatMap((space) => photosIn(space));

export default function HomePage() {
  return (
    <GalleryProvider photos={allPhotos}>
      <Hero />
      <Glance />
      <Inside />
      <Bedrooms />
      <Evenings />
      <Setting />
      <Direct />
    </GalleryProvider>
  );
}

function Hero() {
  return (
    <section aria-labelledby="hero-title" className="relative overflow-hidden">
      {/* Decorative ripple lines echoing the water. */}
      <svg
        aria-hidden="true"
        className="pointer-events-none absolute -top-24 -left-40 h-[40rem] w-[60rem] text-sage-300/50"
        viewBox="0 0 600 400"
        fill="none"
      >
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <ellipse
            key={i}
            cx="300"
            cy="200"
            rx={90 + i * 46}
            ry={40 + i * 22}
            stroke="currentColor"
            strokeWidth="1"
          />
        ))}
      </svg>

      <Container className="relative grid gap-10 pt-8 pb-10 sm:pt-12 lg:grid-cols-[1fr_1.05fr] lg:items-center lg:gap-16 lg:pt-16 lg:pb-16">
        <div className="order-2 lg:order-1">
          <p className="enter text-sm font-semibold tracking-[0.18em] text-wood uppercase">
            {property.location.setting.value}
          </p>
          <h1 id="hero-title" className="enter enter-delay-1 mt-4 text-display">
            Slow mornings, <em className="text-pine-700">lake light</em>, and
            room to breathe.
          </h1>
          <p className="enter enter-delay-2 mt-6 max-w-xl text-lg leading-relaxed text-ink-muted">
            A three-bedroom lodge with its deck right over the water,{" "}
            {property.location.region.value}. Coffee on the deck, evenings under
            the lights, and nowhere you need to be.
          </p>
          <div className="enter enter-delay-3 mt-8 flex flex-wrap gap-3">
            <ButtonLink href="/availability">Check availability</ButtonLink>
            <ButtonLink href="/stay" variant="secondary">
              Explore the lodge
            </ButtonLink>
          </div>
        </div>

        <div className="relative order-1 lg:order-2">
          <div className="relative mx-auto aspect-[4/5] max-h-[78vh] w-full max-w-[34rem] shadow-[0_40px_80px_-40px_rgba(20,39,31,0.6)] sm:aspect-[5/6]">
            <HeroCarousel slides={heroSlides} />
          </div>
          {/* Floating secondary photo (desktop), drifting gently on scroll. */}
          <div className="parallax absolute top-10 -left-20 hidden w-56 lg:block xl:w-64">
            <GalleryButton photo={photo("deck-view-fountain")}>
              <PhotoFrame
                photo={photo("deck-view-fountain")}
                sizes="16rem"
                aspect="aspect-[4/3]"
                zoomOnHover
                className="rounded-2xl border-4 border-ivory shadow-[0_24px_50px_-24px_rgba(20,39,31,0.6)]"
              />
            </GalleryButton>
          </div>
        </div>
      </Container>

      <Container className="relative pb-14 lg:pb-20">
        <h2 className="sr-only">Search dates</h2>
        <BookingSearch
          maxGuests={searchLimits.maxGuests}
          minNights={searchLimits.minNights}
          timeZone={TIME_ZONE}
        />
        <p className="mt-3 text-sm text-ink-muted">
          Online booking opens soon. Searching now shows what to expect; nothing
          is reserved.
        </p>
      </Container>
    </section>
  );
}

function Glance() {
  return (
    <section
      aria-label="At a glance"
      className="border-y border-sage-300/60 bg-limestone/60"
    >
      <Container>
        <dl className="grid grid-cols-2 divide-sage-300/70 py-2 sm:grid-cols-4 sm:divide-x">
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
            <FactText
              fact={property.features[1]}
              render={() => "Deck on the water"}
            />
          </Stat>
        </dl>
      </Container>
    </section>
  );
}

function Inside() {
  const tiles = [
    {
      p: photo("living-room-media-wall"),
      cls: "col-span-2 row-span-2",
      aspect: "aspect-[4/3] h-full",
    },
    { p: photo("kitchen"), cls: "", aspect: "aspect-[4/3]" },
    { p: photo("media-wall-fire"), cls: "", aspect: "aspect-[4/3]" },
    { p: photo("kitchen-island"), cls: "", aspect: "aspect-[4/3]" },
    { p: photo("detail-roses"), cls: "", aspect: "aspect-[4/3]" },
  ];
  return (
    <section aria-labelledby="inside-title" className="py-16 sm:py-24">
      <Container>
        <div className="reveal flex flex-wrap items-end justify-between gap-6">
          <div className="max-w-2xl">
            <Eyebrow>Inside the lodge</Eyebrow>
            <h2 id="inside-title" className="mt-3 text-title">
              Light, warm and made for gathering
            </h2>
            <p className="mt-4 text-lg leading-relaxed text-ink-muted">
              An open-plan living space with a long electric fire, a kitchen
              island for morning coffee, and patio doors that fill the room with
              light.
            </p>
          </div>
          <AllPhotosButton />
        </div>
        <ul className="mt-10 grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4 lg:grid-rows-2">
          {tiles.map(({ p, cls, aspect }) => (
            <li key={p.id} className={`reveal ${cls}`}>
              <GalleryButton photo={p} className="h-full">
                <PhotoFrame
                  photo={p}
                  aspect={aspect}
                  zoomOnHover
                  sizes={
                    cls
                      ? "(min-width: 1024px) 36rem, 100vw"
                      : "(min-width: 1024px) 18rem, 50vw"
                  }
                />
              </GalleryButton>
            </li>
          ))}
        </ul>
      </Container>
    </section>
  );
}

function Bedrooms() {
  return (
    <section
      aria-labelledby="bedrooms-title"
      className="bg-limestone/60 py-16 sm:py-24"
    >
      <Container>
        <div className="reveal max-w-2xl">
          <Eyebrow>Sleeping</Eyebrow>
          <h2 id="bedrooms-title" className="mt-3 text-title">
            Three bedrooms, each with its own character
          </h2>
        </div>
        <ul className="mt-10 grid gap-6 md:grid-cols-3">
          {property.bedroomList.map((room) => {
            const [first] = photosIn(room.space);
            return (
              <li key={room.space} className="reveal">
                <GalleryButton photo={first} label={`View ${room.name} photos`}>
                  <PhotoFrame
                    photo={first}
                    aspect="aspect-[4/3]"
                    zoomOnHover
                    sizes="(min-width: 768px) 24rem, 100vw"
                  />
                </GalleryButton>
                <h3 className="mt-4 text-2xl">{room.name}</h3>
                <p className="mt-1 text-ink-muted">
                  <FactText fact={room.beds} />
                </p>
              </li>
            );
          })}
        </ul>
      </Container>
    </section>
  );
}

function Evenings() {
  return (
    <section
      aria-labelledby="evenings-title"
      className="relative overflow-hidden bg-pine-950 text-sage-100"
    >
      <Container className="grid items-center gap-12 py-16 sm:py-24 lg:grid-cols-[1fr_1.2fr]">
        <div className="reveal">
          <p className="text-sm font-semibold tracking-[0.18em] text-wood-200 uppercase">
            After dark
          </p>
          <h2 id="evenings-title" className="mt-3 text-title text-ivory">
            Evenings on the deck
          </h2>
          <p className="mt-5 max-w-md text-lg leading-relaxed">
            As the light fades, the deck lights come on and the lodges across
            the water glow. Pull up a chair, take a blanket outside and stay out
            a little longer.
          </p>
        </div>
        <div className="grid grid-cols-2 gap-4">
          <div className="reveal translate-y-8">
            <GalleryButton photo={photo("deck-evening")}>
              <PhotoFrame
                photo={photo("deck-evening")}
                aspect="aspect-[3/4]"
                zoomOnHover
                sizes="(min-width: 1024px) 20rem, 50vw"
              />
            </GalleryButton>
          </div>
          <div className="reveal">
            <GalleryButton photo={photo("deck-gazebo-evening")}>
              <PhotoFrame
                photo={photo("deck-gazebo-evening")}
                aspect="aspect-[3/4]"
                zoomOnHover
                sizes="(min-width: 1024px) 20rem, 50vw"
              />
            </GalleryButton>
          </div>
        </div>
      </Container>
    </section>
  );
}

function Setting() {
  return (
    <section aria-labelledby="setting-title" className="py-16 sm:py-24">
      <Container className="grid gap-12 lg:grid-cols-[1.2fr_1fr] lg:items-center">
        <div className="reveal relative">
          <GalleryButton photo={photo("deck-view-fountain")}>
            <PhotoFrame
              photo={photo("deck-view-fountain")}
              aspect="aspect-[4/3]"
              zoomOnHover
              sizes="(min-width: 1024px) 40rem, 100vw"
            />
          </GalleryButton>
        </div>
        <div className="reveal">
          <Eyebrow>The setting</Eyebrow>
          <h2 id="setting-title" className="mt-3 text-title">
            On the water, on the edge of the Lake District
          </h2>
          <p className="mt-5 max-w-lg text-lg leading-relaxed text-ink-muted">
            The lodge sits at the water&rsquo;s edge within{" "}
            {property.location.setting.value}, {property.location.region.value}.
            The owner&rsquo;s own recommendations for walks, places to eat and
            rainy-day ideas are on their way.
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
  );
}

function Direct() {
  return (
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
            full price including every fee, and the payment schedule before you
            pay anything. Until then, we&rsquo;re happy to answer questions.
          </p>
        </div>
        <div className="flex flex-wrap gap-3 lg:justify-end">
          <ButtonLink href="/contact" variant="light">
            Contact the owner
          </ButtonLink>
        </div>
      </Container>
    </section>
  );
}

function AllPhotosButton() {
  const first = photos[0];
  return (
    <GalleryButton
      photo={first}
      label={`View all ${photos.length} photos`}
      bare
      className="inline-flex min-h-12 items-center gap-2 rounded-soft border border-pine-800 px-5 font-semibold text-pine-900 hover:bg-sage-100"
    >
      <svg
        aria-hidden="true"
        width="18"
        height="18"
        viewBox="0 0 18 18"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
      >
        <rect x="1.5" y="1.5" width="6" height="6" rx="1" />
        <rect x="10.5" y="1.5" width="6" height="6" rx="1" />
        <rect x="1.5" y="10.5" width="6" height="6" rx="1" />
        <rect x="10.5" y="10.5" width="6" height="6" rx="1" />
      </svg>
      View all {photos.length} photos
    </GalleryButton>
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
    <div className="px-2 py-5 sm:px-6 sm:text-center">
      <dt className="text-xs font-semibold tracking-[0.14em] text-sage-600 uppercase">
        {label}
      </dt>
      <dd className="mt-1.5 font-display text-2xl text-pine-900">{children}</dd>
    </div>
  );
}
