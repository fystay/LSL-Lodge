"use client";

import { useRef, useState } from "react";
import type { Photo } from "@/content/photos";
import { PhotoFrame } from "./photo";

/**
 * Grid of photographs with an accessible full-screen viewer. Uses the native
 * <dialog> element for focus containment, Escape-to-close and an inert
 * background. Each thumbnail is a real button, so the gallery is fully
 * keyboard operable; arrow keys move between photos inside the viewer.
 */
export function Gallery({ photos }: { photos: Photo[] }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const triggerRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const openerRef = useRef(0);
  const [index, setIndex] = useState(0);
  const current = photos[index];

  const open = (i: number) => {
    openerRef.current = i;
    setIndex(i);
    dialogRef.current?.showModal();
  };
  const step = (delta: number) =>
    setIndex((i) => (i + delta + photos.length) % photos.length);

  return (
    <>
      <ul className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-3">
        {photos.map((photo, i) => (
          <li key={photo.id} className={i === 0 ? "col-span-2 row-span-2" : ""}>
            <button
              ref={(el) => {
                triggerRefs.current[i] = el;
              }}
              type="button"
              onClick={() => open(i)}
              className="group block w-full rounded-soft text-left"
              aria-label={`View ${photo.caption ?? photo.brief} larger`}
            >
              <PhotoFrame
                photo={photo}
                sizes={
                  i === 0
                    ? "(min-width: 1024px) 66vw, 100vw"
                    : "(min-width: 1024px) 33vw, 50vw"
                }
                aspect={i === 0 ? "aspect-[4/3]" : "aspect-square"}
                className="transition-opacity duration-300 ease-calm motion-safe:group-hover:opacity-90"
              />
            </button>
          </li>
        ))}
      </ul>

      <dialog
        ref={dialogRef}
        aria-label="Photo viewer"
        // Return focus to the thumbnail that opened the viewer.
        onClose={() => triggerRefs.current[openerRef.current]?.focus()}
        onKeyDown={(event) => {
          if (event.key === "ArrowRight") step(1);
          if (event.key === "ArrowLeft") step(-1);
        }}
        className="m-auto w-[min(100vw-2rem,72rem)] max-w-none rounded-soft bg-pine-950 p-0 text-ivory backdrop:bg-pine-950/80"
      >
        {current && (
          <figure className="p-3 sm:p-5">
            <PhotoFrame photo={current} sizes="100vw" aspect="aspect-[3/2]" />
            <figcaption className="mt-3 flex flex-wrap items-center justify-between gap-3">
              <span aria-live="polite">
                {current.caption ?? current.brief}{" "}
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
    </>
  );
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
