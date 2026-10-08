"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";

/**
 * Sticky in-page navigation with an underline that slides to the section
 * currently on screen (scroll-spy). Clicking a link scrolls smoothly (CSS
 * scroll-behavior, off under reduced motion) and moves the underline at once.
 * The active link carries aria-current="location" so the position is not
 * conveyed by the underline alone.
 */
export function SectionNav({
  sections,
}: {
  sections: readonly { id: string; label: string }[];
}) {
  const [active, setActive] = useState<string | null>(null);
  const [bar, setBar] = useState<{ left: number; width: number } | null>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const linkRefs = useRef(new Map<string, HTMLAnchorElement>());
  // While a click-initiated smooth scroll is running, hold the clicked
  // section so the underline doesn't flicker through the ones in between.
  const lockedUntil = useRef(0);

  useEffect(() => {
    // Sections are "current" once their top passes this line, just below the
    // sticky site header and this bar.
    const READING_LINE = 160;
    let frame = 0;
    let unlockTimer = 0;

    const compute = () => {
      frame = 0;
      if (Date.now() < lockedUntil.current) return;
      if (window.scrollY < 50) {
        setActive(null);
        return;
      }
      let current: string | null = null;
      for (const s of sections) {
        const el = document.getElementById(s.id);
        if (el && el.getBoundingClientRect().top <= READING_LINE)
          current = s.id;
      }
      // The last section may be too short to reach the line: at the very
      // bottom of the page, it is the current one.
      const atBottom =
        window.innerHeight + window.scrollY >=
        document.documentElement.scrollHeight - 2;
      if (atBottom && sections.length > 0) current = sections.at(-1)!.id;
      setActive(current);
    };
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(compute);
    };
    // After a click, re-check once the smooth scroll has had time to settle
    // (scrollend is not available everywhere).
    const onLock = () => {
      window.clearTimeout(unlockTimer);
      unlockTimer = window.setTimeout(
        compute,
        lockedUntil.current - Date.now() + 50,
      );
    };

    compute();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("section-nav-lock", onLock);
    return () => {
      cancelAnimationFrame(frame);
      window.clearTimeout(unlockTimer);
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("section-nav-lock", onLock);
    };
  }, [sections]);

  // Position the underline under the active link, and keep that link in view
  // when the bar scrolls sideways on small screens.
  useLayoutEffect(() => {
    const link = active ? linkRefs.current.get(active) : undefined;
    const list = listRef.current;
    if (!link || !list) {
      setBar(null);
      return;
    }
    setBar({ left: link.offsetLeft + 12, width: link.offsetWidth - 24 });
    const target = link.offsetLeft - (list.clientWidth - link.offsetWidth) / 2;
    list.scrollTo({ left: Math.max(0, target), behavior: "smooth" });
  }, [active]);

  return (
    <nav
      aria-label="On this page"
      className="sticky top-18 z-30 border-b border-sage-300/60 bg-ivory/95 backdrop-blur"
    >
      <div className="mx-auto w-full max-w-6xl px-4 sm:px-6 lg:px-8">
        <ul
          ref={listRef}
          className="relative flex [scrollbar-width:none] gap-1 overflow-x-auto py-2"
        >
          {sections.map((s) => (
            <li key={s.id}>
              <a
                ref={(el) => {
                  if (el) linkRefs.current.set(s.id, el);
                }}
                href={`#${s.id}`}
                aria-current={active === s.id ? "location" : undefined}
                onClick={() => {
                  lockedUntil.current = Date.now() + 1000;
                  setActive(s.id);
                  window.dispatchEvent(new Event("section-nav-lock"));
                }}
                className={`inline-flex min-h-11 items-center rounded-full px-4 text-sm font-semibold whitespace-nowrap transition-colors duration-300 hover:bg-sage-100 ${
                  active === s.id ? "text-pine-900" : "text-ink-muted"
                }`}
              >
                {s.label}
              </a>
            </li>
          ))}
          <li
            aria-hidden="true"
            className="pointer-events-none absolute bottom-1.5 h-0.5 rounded-full bg-pine-800 transition-[left,width,opacity] duration-500 ease-calm"
            style={{
              left: bar?.left ?? 0,
              width: bar?.width ?? 0,
              opacity: bar ? 1 : 0,
            }}
          />
        </ul>
      </div>
    </nav>
  );
}
