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
  const openerRef = useRef<HTMLElement | null>(null);
  const [index, setIndex] = useState(0);
  const current = photos[index];

  const open = useCallback(
    (id: string, opener: HTMLElement | null) => {
      openerRef.current = opener;
      setIndex(
        Math.max(
          0,
          photos.findIndex((p) => p.id === id),
        ),
      );
      dialogRef.current?.showModal();
    },
    [photos],
  );
  const step = (delta: number) =>
    setIndex((i) => (i + delta + photos.length) % photos.length);
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
          if (event.key === "ArrowRight") step(1);
          if (event.key === "ArrowLeft") step(-1);
        }}
        className="m-auto max-h-none w-[min(100vw-1rem,64rem)] max-w-none rounded-soft bg-pine-950 p-0 text-ivory backdrop:bg-pine-950/90 backdrop:backdrop-blur-sm"
      >
        {current && (
          <figure className="p-2 sm:p-4">
            <div className="relative flex h-[min(72vh,60rem)] items-center justify-center">
              <Image
                key={current.id}
                src={current.image}
                alt={current.alt}
                sizes="(min-width: 64rem) 64rem, 100vw"
                placeholder="blur"
                className="h-auto max-h-full w-auto max-w-full rounded-sm object-contain motion-safe:animate-[fade-in_300ms_ease-out]"
              />
            </div>
            <figcaption className="mt-3 flex flex-wrap items-center justify-between gap-3 px-1">
              <span aria-live="polite">
                {current.caption}{" "}
                <span className="text-sage-300">
                  ({index + 1} of {photos.length})
                </span>
              </span>
              <span className="flex gap-2">
                <ViewerButton onClick={() => step(-1)}>Previous</ViewerButton>
                <ViewerButton onClick={() => step(1)}>Next</ViewerButton>
                <ViewerButton onClick={() => dialogRef.current?.close()}>
                  Close
                </ViewerButton>
              </span>
            </figcaption>
          </figure>
        )}
      </dialog>
    </GalleryContext.Provider>
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

function ViewerButton({
  onClick,
  children,
}: {
  onClick: () => void;
  children: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="min-h-11 rounded-soft border border-sage-100/40 px-4 text-sm font-semibold hover:bg-pine-800"
    >
      {children}
    </button>
  );
}
