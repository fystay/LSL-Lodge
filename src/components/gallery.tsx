"use client";

import Image from "next/image";
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { Photo } from "@/content/photos";

/**
 * Shared full-screen photo viewer. Any <GalleryButton> on the page opens it
 * at that photo. Uses the native <dialog> for focus containment,
 * Escape-to-close and an inert background; arrow keys step through photos;
 * focus returns to whichever button opened it. The viewer shows the whole
 * photo (object-contain) at no more than its natural size.
 */

interface GalleryContextValue {
  open: (id: string, opener: HTMLElement | null) => void;
  count: number;
}

const GalleryContext = createContext<GalleryContextValue | null>(null);

export function GalleryProvider({
  photos,
  children,
}: {
  photos: Photo[];
  children: ReactNode;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const [index, setIndex] = useState(0);
  const current = photos[index];

  /** Scrolls the swipe track to a photo (instantly when opening). */
  const scrollToIndex = (i: number, behavior: ScrollBehavior) => {
    const track = trackRef.current;
    if (!track) return;
    const target = (i + photos.length) % photos.length;
    track.scrollTo({ left: target * track.clientWidth, behavior });
  };

  const open = useCallback(
    (id: string, opener: HTMLElement | null) => {
      openerRef.current = opener;
      const i = Math.max(
        0,
        photos.findIndex((p) => p.id === id),
      );
      setIndex(i);
      dialogRef.current?.showModal();
      // Jump straight to the chosen photo once the dialog has laid out.
      requestAnimationFrame(() => {
        const track = trackRef.current;
        if (track)
          track.scrollTo({ left: i * track.clientWidth, behavior: "instant" });
      });
    },
    [photos],
  );

  // Keep the caption and counter in step with swiping.
  const onScroll = () => {
    const track = trackRef.current;
    if (!track || track.clientWidth === 0) return;
    const i = Math.round(track.scrollLeft / track.clientWidth);
    if (i !== index && i >= 0 && i < photos.length) setIndex(i);
  };

  const smooth = (): ScrollBehavior =>
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
      ? "instant"
      : "smooth";

  const value = useMemo(
    () => ({ open, count: photos.length }),
    [open, photos.length],
  );

  return (
    <GalleryContext.Provider value={value}>
      {children}
      <dialog
        ref={dialogRef}
        aria-label="Photo viewer"
        onClose={() => openerRef.current?.focus()}
        onKeyDown={(event) => {
          if (event.key === "ArrowRight") {
            event.preventDefault();
            scrollToIndex(index + 1, smooth());
          }
          if (event.key === "ArrowLeft") {
            event.preventDefault();
            scrollToIndex(index - 1, smooth());
          }
        }}
        className="m-auto max-h-none w-[min(100vw-1rem,64rem)] max-w-none overflow-hidden rounded-soft bg-pine-950 p-0 text-ivory backdrop:bg-pine-950/90 backdrop:backdrop-blur-sm"
      >
        <div className="relative">
          {/* Swipe track: native, momentum scrolling with snap points. */}
          <div
            ref={trackRef}
            onScroll={onScroll}
            className="flex h-[min(76vh,60rem)] snap-x snap-mandatory [scrollbar-width:none] overflow-x-auto overscroll-x-contain [&::-webkit-scrollbar]:hidden"
          >
            {photos.map((p, i) => (
              <div
                key={p.id}
                aria-hidden={i !== index}
                className="flex h-full w-full shrink-0 snap-center snap-always items-center justify-center p-2 sm:p-4"
              >
                <Image
                  src={p.image}
                  alt={i === index ? p.alt : ""}
                  sizes="(min-width: 64rem) 64rem, 100vw"
                  placeholder="blur"
                  loading={Math.abs(i - index) <= 1 ? "eager" : "lazy"}
                  draggable={false}
                  className="h-full w-full object-contain select-none"
                  // Fill the frame, but never beyond the photo's real size.
                  style={{ maxWidth: p.image.width, maxHeight: p.image.height }}
                />
              </div>
            ))}
          </div>

          {/* Mouse users can't swipe: show quiet arrows only for fine pointers. */}
          <ArrowButton
            side="left"
            label="Previous photo"
            onClick={() => scrollToIndex(index - 1, smooth())}
          />
          <ArrowButton
            side="right"
            label="Next photo"
            onClick={() => scrollToIndex(index + 1, smooth())}
          />

          <button
            type="button"
            onClick={() => dialogRef.current?.close()}
            aria-label="Close photo viewer"
            className="absolute top-3 right-3 flex size-11 items-center justify-center rounded-full bg-pine-950/60 text-ivory backdrop-blur hover:bg-pine-800"
          >
            <svg
              aria-hidden="true"
              width="18"
              height="18"
              viewBox="0 0 18 18"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
            >
              <path d="M4 4l10 10M14 4L4 14" />
            </svg>
          </button>
        </div>

        <div className="flex items-center justify-between gap-3 px-4 pt-1 pb-4">
          <p aria-live="polite">
            {current?.caption}{" "}
            <span className="text-sage-300">
              ({index + 1} of {photos.length})
            </span>
          </p>
          <p className="text-sm text-sage-300 pointer-fine:hidden">
            Swipe for more
          </p>
        </div>
        {/* Progress dots double as a sense of place in the set. */}
        <div aria-hidden="true" className="flex justify-center gap-1 pb-4">
          {photos.map((p, i) => (
            <span
              key={p.id}
              className={`h-1 rounded-full bg-ivory transition-all duration-300 ${i === index ? "w-4 opacity-100" : "w-1 opacity-40"}`}
            />
          ))}
        </div>
      </dialog>
    </GalleryContext.Provider>
  );
}

function ArrowButton({
  side,
  label,
  onClick,
}: {
  side: "left" | "right";
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      className={`absolute top-1/2 hidden size-11 -translate-y-1/2 items-center justify-center rounded-full bg-pine-950/50 text-ivory opacity-70 backdrop-blur transition-opacity hover:opacity-100 pointer-fine:flex ${
        side === "left" ? "left-3" : "right-3"
      }`}
    >
      <svg
        aria-hidden="true"
        width="18"
        height="18"
        viewBox="0 0 18 18"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {side === "left" ? (
          <path d="M11 3L5 9l6 6" />
        ) : (
          <path d="M7 3l6 6-6 6" />
        )}
      </svg>
    </button>
  );
}

/** Makes its children a button that opens the viewer at `photo`. */
export function GalleryButton({
  photo,
  label,
  className = "",
  bare = false,
  children,
}: {
  photo: Pick<Photo, "id" | "caption">;
  label?: string;
  className?: string;
  /** Skip the default block/full-width styling (for button-like triggers). */
  bare?: boolean;
  children: ReactNode;
}) {
  const gallery = useContext(GalleryContext);
  return (
    <button
      type="button"
      onClick={(event) => gallery?.open(photo.id, event.currentTarget)}
      aria-label={label ?? `View ${photo.caption} larger`}
      className={`${bare ? "" : "group block w-full cursor-zoom-in text-left"} rounded-soft ${className}`}
    >
      {children}
    </button>
  );
}

export function useGalleryCount() {
  return useContext(GalleryContext)?.count ?? 0;
}
