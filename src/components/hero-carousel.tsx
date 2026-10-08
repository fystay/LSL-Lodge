"use client";

import Image from "next/image";
import {
  type ReactNode,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
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
 * The visible chrome is just a room label; visitors swipe to move on.
 *
 * Accessibility: previous / pause / next buttons appear on keyboard focus
 * (WCAG 2.2.2 pause mechanism); autoplay stops while the pointer or focus is
 * inside; never autoplays under prefers-reduced-motion; the label is
 * announced only when not autoplaying; only the active image is exposed to
 * assistive technology.
 */
export function HeroCarousel({ slides }: { slides: Photo[] }) {
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

      {/* Soft top scrim so the room label reads over bright skies and walls. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 top-0 h-2/5 bg-gradient-to-b from-pine-950/50 to-transparent"
      />

      {/* Room label in place of dots: number, hairline, and the room in serif. */}
      <div
        aria-live={playing ? "off" : "polite"}
        className="pointer-events-none absolute top-5 left-5 text-ivory [text-shadow:0_1px_12px_rgba(20,39,31,0.45)] sm:top-7 sm:left-7 lg:right-8 lg:left-auto lg:text-right"
      >
        <p key={active} className="caption-in">
          <span className="flex items-center gap-3 text-[0.7rem] font-semibold tracking-[0.28em] text-ivory/85 lg:justify-end">
            <span>{String(active + 1).padStart(2, "0")}</span>
            <span aria-hidden="true" className="h-px w-8 bg-ivory/70" />
            <span>{String(slides.length).padStart(2, "0")}</span>
          </span>
          <span className="sr-only">
            Photo {active + 1} of {slides.length}:{" "}
          </span>
          <span className="mt-2 block font-display text-2xl leading-tight italic sm:text-3xl">
            {slides[active]?.caption}
          </span>
        </p>
      </div>

      {/* Controls stay out of sight for touch and mouse (swipe, and autoplay
          pauses on hover) but appear for keyboard users, keeping a pause
          mechanism for WCAG 2.2.2. */}
      {slides.length > 1 && (
        <div className="absolute top-3 right-3 flex gap-1 rounded-full bg-pine-950/70 p-1 opacity-0 backdrop-blur transition-opacity has-focus-visible:opacity-100 lg:top-auto lg:right-6 lg:bottom-6">
          <ControlButton
            label="Previous photo"
            onClick={() =>
              setActive((i) => (i - 1 + slides.length) % slides.length)
            }
          >
            <path
              d="M9 2 4 7l5 5"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
            />
          </ControlButton>
          {!reducedMotion && (
            <ControlButton
              label={paused ? "Play slideshow" : "Pause slideshow"}
              onClick={() => setPaused((p) => !p)}
            >
              {paused ? (
                <path d="M3 1.5v11l9-5.5z" />
              ) : (
                <path d="M3 1.5h3v11H3zM8 1.5h3v11H8z" />
              )}
            </ControlButton>
          )}
          <ControlButton
            label="Next photo"
            onClick={() => setActive((i) => (i + 1) % slides.length)}
          >
            <path
              d="m5 2 5 5-5 5"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
            />
          </ControlButton>
        </div>
      )}
    </div>
  );
}

function ControlButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      className="flex size-11 items-center justify-center rounded-full text-ivory"
    >
      <svg
        aria-hidden="true"
        width="14"
        height="14"
        viewBox="0 0 14 14"
        fill="currentColor"
      >
        {children}
      </svg>
    </button>
  );
}
