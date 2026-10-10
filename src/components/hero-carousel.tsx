"use client";

import Image from "next/image";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { Photo } from "@/content/photos";

const INTERVAL_MS = 6500;

const reducedMotionQuery = "(prefers-reduced-motion: reduce)";
function subscribeReducedMotion(callback: () => void) {
  const media = window.matchMedia(reducedMotionQuery);
  media.addEventListener("change", callback);
  return () => media.removeEventListener("change", callback);
}

/**
 * Crossfading hero photographs with a slow zoom on the active slide.
 *
 * Accessibility: a visible pause/play control (WCAG 2.2.2); autoplay stops
 * while the pointer or keyboard focus is inside; never autoplays under
 * prefers-reduced-motion; each slide has a labelled button; only the active
 * image is exposed to assistive technology.
 */
export function HeroCarousel({
  slides,
}: {
  /** label: a short room or area name shown in the corner pill. */
  slides: (Photo & { label: string })[];
}) {
  const [active, setActive] = useState(0);
  const [paused, setPaused] = useState(false);
  const [hovering, setHovering] = useState(false);
  const touchStart = useRef<{ x: number; y: number } | null>(null);
  const reducedMotion = useSyncExternalStore(
    subscribeReducedMotion,
    () => window.matchMedia(reducedMotionQuery).matches,
    () => true, // server: assume no autoplay until the browser says otherwise
  );
  const playing = !paused && !hovering && !reducedMotion && slides.length > 1;

  useEffect(() => {
    if (!playing) return;
    const timer = window.setTimeout(
      () => setActive((i) => (i + 1) % slides.length),
      INTERVAL_MS,
    );
    return () => window.clearTimeout(timer);
  }, [playing, active, slides.length]);

  return (
    <div
      role="group"
      aria-roledescription="carousel"
      aria-label="Photographs of the lodge"
      className="relative h-full w-full"
      onMouseEnter={() => setHovering(true)}
      // Horizontal swipe on touch screens moves between slides.
      onTouchStart={(event) => {
        const t = event.touches[0];
        touchStart.current = { x: t.clientX, y: t.clientY };
      }}
      onTouchEnd={(event) => {
        const start = touchStart.current;
        touchStart.current = null;
        if (!start) return;
        const t = event.changedTouches[0];
        const dx = t.clientX - start.x;
        const dy = t.clientY - start.y;
        if (Math.abs(dx) < 40 || Math.abs(dx) < Math.abs(dy)) return;
        setActive(
          (i) => (i + (dx < 0 ? 1 : -1) + slides.length) % slides.length,
        );
      }}
      onMouseLeave={() => setHovering(false)}
      onFocus={() => setHovering(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget))
          setHovering(false);
      }}
    >
      <div className="absolute inset-0 overflow-hidden">
        {slides.map((slide, i) => (
          <div
            key={slide.id}
            aria-hidden={i !== active}
            className={`absolute inset-0 transition-opacity duration-[1400ms] ease-calm ${
              i === active ? "opacity-100" : "opacity-0"
            }`}
          >
            <Image
              src={slide.image}
              alt={i === active ? slide.alt : ""}
              fill
              priority={i === 0}
              sizes="(min-width: 1024px) 50vw, 100vw"
              placeholder="blur"
              className={`object-cover ${i === active ? "slide-zoom" : ""}`}
              style={{ objectPosition: slide.focus ?? "center" }}
            />
          </div>
        ))}
      </div>

      {/* Room label pill. On desktop the photo's left edge fades into the
          page, so the pill starts where the image is fully opaque. */}
      <p
        className="absolute top-5 left-5 flex items-center gap-1.5 rounded-full border border-ivory/25 bg-[rgba(38,68,59,0.65)] px-2.5 py-1.5 text-[0.625rem] leading-none font-medium tracking-[0.2em] text-ivory uppercase backdrop-blur-sm sm:top-6 sm:left-6 sm:gap-2.5 sm:px-3.5 sm:py-2 sm:text-[0.6875rem] sm:tracking-[0.24em] lg:left-[calc(38%+1.5rem)]"
        aria-live="polite"
      >
        <span aria-hidden="true" className="h-px w-2 bg-ivory/60 sm:w-3.5" />
        <span key={active} className="label-in">
          <span className="sr-only">{slides[active]?.caption}</span>
          <span aria-hidden="true">{slides[active]?.label}</span>
        </span>
        <span aria-hidden="true" className="h-px w-2 bg-ivory/60 sm:w-3.5" />
      </p>
      <div className="absolute top-3 right-3 flex items-center justify-end gap-3 sm:top-5 sm:right-4">
        <div className="flex shrink-0 items-center gap-1 rounded-full bg-pine-950/55 p-1 backdrop-blur">
          {slides.map((slide, i) => (
            <button
              key={slide.id}
              type="button"
              onClick={() => setActive(i)}
              aria-label={`Show photo ${i + 1} of ${slides.length}: ${slide.caption}`}
              aria-current={i === active ? "true" : undefined}
              className="flex size-8 items-center justify-center rounded-full max-[400px]:w-7"
            >
              <span
                className={`block h-1.5 rounded-full bg-ivory transition-all duration-500 ${
                  i === active ? "w-5 opacity-100" : "w-1.5 opacity-60"
                }`}
              />
            </button>
          ))}
          {!reducedMotion && slides.length > 1 && (
            <button
              type="button"
              onClick={() => setPaused((p) => !p)}
              aria-label={paused ? "Play slideshow" : "Pause slideshow"}
              className="flex size-8 items-center justify-center rounded-full text-ivory max-[400px]:w-7"
            >
              <svg
                aria-hidden="true"
                width="14"
                height="14"
                viewBox="0 0 14 14"
                fill="currentColor"
              >
                {paused ? (
                  <path d="M3 1.5v11l9-5.5z" />
                ) : (
                  <path d="M3 1.5h3v11H3zM8 1.5h3v11H8z" />
                )}
              </svg>
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
