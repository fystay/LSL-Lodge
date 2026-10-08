import { GalleryButton, GalleryProvider } from "@/components/gallery";
import { PhotoFrame } from "@/components/photo";
import {
  ButtonLink,
  Container,
  DraftNotice,
  Eyebrow,
  FactText,
} from "@/components/ui";
import { galleryOrder, photo, photosIn, type Photo } from "@/content/photos";
import { property } from "@/content/property";
import { pageMetadata } from "@/lib/metadata";

export const metadata = pageMetadata(
  "/stay",
  "The lodge",
  "Inside Lodge on the Lake: open-plan living, three bedrooms, bathroom and a deck over the water.",
);

const allPhotos = galleryOrder.flatMap((space) => photosIn(space));

const sections = [
  { id: "living", label: "Living" },
  { id: "kitchen", label: "Kitchen" },
  { id: "bedrooms", label: "Bedrooms" },
  { id: "bathroom", label: "Bathroom" },
  { id: "outside", label: "Outside" },
  { id: "details", label: "Details" },
] as const;

export default function StayPage() {
  return (
    <GalleryProvider photos={allPhotos}>
      <header className="border-b border-sage-300/60 bg-limestone/60">
        <Container className="grid gap-10 py-12 sm:py-16 lg:grid-cols-[1fr_1.3fr] lg:items-center">
          <div>
            <p className="enter text-sm font-semibold tracking-[0.18em] text-wood uppercase">
              The lodge
            </p>
            <h1 className="enter enter-delay-1 mt-3 text-title">
              A lodge to settle into
            </h1>
            <p className="enter enter-delay-2 mt-5 max-w-xl text-lg leading-relaxed text-ink-muted">
              Open-plan living with a long electric fire, a kitchen built for
              sharing, three bedrooms and a deck that sits right over the water.
            </p>
            <div className="enter enter-delay-3 mt-7">
              <GalleryButton
                photo={allPhotos[0]}
                label={`View all ${allPhotos.length} photos`}
                bare
                className="inline-flex min-h-12 items-center rounded-soft bg-pine-800 px-6 font-semibold text-ivory hover:bg-pine-700"
              >
                View all {allPhotos.length} photos
              </GalleryButton>
            </div>
          </div>
          <div className="grid grid-cols-3 grid-rows-2 gap-3">
            <Tile
              p={photo("living-room-media-wall")}
              className="col-span-2 row-span-2"
              aspect="aspect-[4/3] h-full"
              sizes="(min-width: 1024px) 28rem, 66vw"
              priority
            />
            <Tile
              p={photo("lodge-across-water")}
              aspect="aspect-square h-full"
              sizes="(min-width: 1024px) 14rem, 33vw"
            />
            <Tile
              p={photo("main-bedroom")}
              aspect="aspect-square h-full"
              sizes="(min-width: 1024px) 14rem, 33vw"
            />
          </div>
        </Container>
      </header>

      <nav
        aria-label="On this page"
        className="sticky top-18 z-30 border-b border-sage-300/60 bg-ivory/95 backdrop-blur"
      >
        <Container>
          <ul className="flex gap-1 overflow-x-auto py-2">
            {sections.map((s) => (
              <li key={s.id}>
                <a
                  href={`#${s.id}`}
                  className="inline-flex min-h-11 items-center rounded-full px-4 text-sm font-semibold whitespace-nowrap text-pine-900 hover:bg-sage-100"
                >
                  {s.label}
                </a>
              </li>
            ))}
          </ul>
        </Container>
      </nav>

      <Space
        id="living"
        eyebrow="Living and dining"
        title="Room to gather"
        text="A bright, open-plan space with deep sofas, a dining table by the patio doors and a media wall with a wide electric fire for cosier evenings."
        photos={[
          photo("living-room-media-wall"),
          photo("media-wall-fire"),
          photo("living-room-kitchen"),
        ]}
      />
      <Space
        id="kitchen"
        eyebrow="Kitchen"
        title="Cook, chat, linger"
        text="A fitted kitchen with a central island and bar stools, plus a separate utility room with a second sink."
        photos={photosIn("kitchen")}
        tinted
      />

      <section
        id="bedrooms"
        aria-labelledby="bedrooms-title"
        className="scroll-mt-32 py-16 sm:py-20"
      >
        <Container>
          <div className="reveal max-w-2xl">
            <Eyebrow>Sleeping</Eyebrow>
            <h2 id="bedrooms-title" className="mt-3 text-title">
              Three bedrooms
            </h2>
            <p className="mt-4 text-lg leading-relaxed text-ink-muted">
              Sleeps up to six: two double rooms and a twin, each dressed with
              crisp white linen.
            </p>
          </div>
          <div className="mt-10 space-y-14">
            {property.bedroomList.map((room) => {
              const roomPhotos = photosIn(room.space);
              return (
                <article
                  key={room.space}
                  className="reveal grid gap-6 lg:grid-cols-[1fr_1.6fr] lg:items-center"
                >
                  <div>
                    <h3 className="text-2xl">{room.name}</h3>
                    <p className="mt-2 text-ink-muted">
                      <FactText fact={room.beds} />
                    </p>
                  </div>
                  <ul
                    className={`grid gap-3 ${roomPhotos.length > 1 ? "grid-cols-2" : "grid-cols-1"}`}
                  >
                    {roomPhotos.map((p) => (
                      <li key={p.id}>
                        <Tile
                          p={p}
                          aspect="aspect-[4/3]"
                          sizes="(min-width: 1024px) 22rem, 50vw"
                        />
                      </li>
                    ))}
                  </ul>
                </article>
              );
            })}
          </div>
        </Container>
      </section>

      <Space
        id="bathroom"
        eyebrow="Bathroom"
        title="Fresh and simple"
        text="A modern shower room with a wood-effect vanity, generous mirror and shelving."
        photos={photosIn("bathroom")}
        tinted
        note="The listing describes two bathrooms; photos of the second are to follow."
      />
      <Space
        id="outside"
        eyebrow="Outside"
        title="A deck over the water"
        text="Dining and lounge seating on a deck at the water's edge, with a covered seating area and lights for after dark."
        photos={photosIn("outside")}
      />

      <section
        id="details"
        aria-labelledby="details-title"
        className="scroll-mt-32 border-t border-sage-300/60 bg-limestone/60"
      >
        <Container className="grid gap-12 py-14 sm:py-16 lg:grid-cols-[1fr_1.4fr]">
          <h2 id="details-title" className="text-title">
            At a glance
          </h2>
          <div className="space-y-10">
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
                  render={(beds) => beds.join(" · ")}
                />
              </Row>
              <Row term="Bathrooms">
                <FactText fact={property.bathrooms} />
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
            <div>
              <h3 className="text-2xl">Pictured in the lodge</h3>
              <ul className="mt-4 grid gap-x-6 gap-y-2 sm:grid-cols-2">
                {property.pictured.map((item) => (
                  <li key={item.value} className="flex gap-2">
                    <span
                      aria-hidden="true"
                      className="mt-2.5 size-1.5 shrink-0 rounded-full bg-wood"
                    />
                    <span>
                      <FactText fact={item} />
                    </span>
                  </li>
                ))}
              </ul>
            </div>
            <DraftNotice title="Full amenities list awaiting the owner">
              Only facilities the owner has confirmed will be listed as
              included. If something matters to your stay, please ask.
            </DraftNotice>
            <ButtonLink href="/contact" variant="secondary">
              Ask a question
            </ButtonLink>
          </div>
        </Container>
      </section>
    </GalleryProvider>
  );
}

function Space({
  id,
  eyebrow,
  title,
  text,
  photos,
  tinted = false,
  note,
}: {
  id: string;
  eyebrow: string;
  title: string;
  text: string;
  photos: Photo[];
  tinted?: boolean;
  note?: string;
}) {
  const [lead, ...rest] = photos;
  return (
    <section
      id={id}
      aria-labelledby={`${id}-title`}
      className={`scroll-mt-32 py-16 sm:py-20 ${tinted ? "bg-limestone/60" : ""}`}
    >
      <Container className="grid gap-10 lg:grid-cols-[1fr_1.6fr] lg:items-start">
        <div className="reveal lg:sticky lg:top-40">
          <Eyebrow>{eyebrow}</Eyebrow>
          <h2 id={`${id}-title`} className="mt-3 text-title">
            {title}
          </h2>
          <p className="mt-4 text-lg leading-relaxed text-ink-muted">{text}</p>
          {note && <p className="mt-4 text-sm text-ink-muted">{note}</p>}
        </div>
        <ul className="grid grid-cols-2 gap-3 sm:gap-4">
          <li className="reveal col-span-2">
            <Tile
              p={lead}
              aspect={
                lead.image.height > lead.image.width
                  ? "aspect-[4/5] sm:aspect-[4/3]"
                  : "aspect-[4/3]"
              }
              sizes="(min-width: 1024px) 40rem, 100vw"
            />
          </li>
          {rest.map((p, i) => (
            <li
              key={p.id}
              className={`reveal ${rest.length % 2 === 1 && i === rest.length - 1 ? "col-span-2" : ""}`}
            >
              <Tile
                p={p}
                aspect="aspect-[4/3]"
                sizes="(min-width: 1024px) 20rem, 50vw"
              />
            </li>
          ))}
        </ul>
      </Container>
    </section>
  );
}

function Tile({
  p,
  aspect,
  sizes,
  className = "",
  priority = false,
}: {
  p: Photo;
  aspect: string;
  sizes: string;
  className?: string;
  priority?: boolean;
}) {
  return (
    <div className={className}>
      <GalleryButton photo={p} className="h-full">
        <PhotoFrame
          photo={p}
          aspect={aspect}
          sizes={sizes}
          zoomOnHover
          priority={priority}
        />
      </GalleryButton>
    </div>
  );
}

function Row({ term, children }: { term: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-1 py-4 sm:grid-cols-[10rem_1fr] sm:gap-6">
      <dt className="font-semibold text-pine-900">{term}</dt>
      <dd className="text-ink">{children}</dd>
    </div>
  );
}
