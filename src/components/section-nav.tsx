"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";

/**
 * Sticky in-page navigation with an underline that slides to the section
 * currently on screen (scroll-spy). Clicking a link scrolls smoothly (CSS
 * scroll-behavior, off under reduced motion) and moves the underline at once.
 * The active link carries aria-current="location" so the position is not
 * conveyed by the underline alone.
 *
 * The bar pins directly under the sticky site header (4.5rem + 1px border)
 * on a solid background: no backdrop-filter, which iOS Safari can fail to
 * repaint on sticky elements during momentum scrolling.
 *
 * Target sections set scroll-margin-top to header + bar (8.3rem + 1px), plus
 * 1.5rem of air, minus their own top padding, so a tapped section lands with
 * its eyebrow just below the bar.
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
  const navRef = useRef<HTMLElement>(null);
  // True while a finger is on the bar, so auto-centring never fights a swipe.
  const touching = useRef(false);

  useEffect(() => {
    let frame = 0;
    let unlockTimer = 0;

    const compute = () => {
      frame = 0;
      if (Date.now() < lockedUntil.current) return;
      const nav = navRef.current;
      if (!nav) return;
      // Nothing is current until the bar has pinned under the header: while
      // the introduction is on screen, no section is being read yet.
      const rect = nav.getBoundingClientRect();
      const pinnedAt = parseFloat(getComputedStyle(nav).top);
      if (rect.top > pinnedAt + 1) {
        setActive(null);
        return;
      }
      // Sections are "current" once their top comes within 1.5rem of this
      // bar's bottom edge, when their label is already in view (measured, so
      // it holds at any header height or text size).
      const line = rect.bottom + 24;
      let current: string | null = null;
      for (const s of sections) {
        const el = document.getElementById(s.id);
        if (el && el.getBoundingClientRect().top <= line) current = s.id;
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
    // After a click, re-check once the smooth scroll settles: on scrollend
    // where supported, with a timer as the fallback.
    const onLock = () => {
      window.clearTimeout(unlockTimer);
      unlockTimer = window.setTimeout(
        compute,
        lockedUntil.current - Date.now() + 50,
      );
    };
    const onScrollEnd = () => {
      if (Date.now() < lockedUntil.current) {
        lockedUntil.current = 0;
        compute();
      }
    };

    compute();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("section-nav-lock", onLock);
    window.addEventListener("scrollend", onScrollEnd);
    return () => {
      cancelAnimationFrame(frame);
      window.clearTimeout(unlockTimer);
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("section-nav-lock", onLock);
      window.removeEventListener("scrollend", onScrollEnd);
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
    if (touching.current) return;
    const target = link.offsetLeft - (list.clientWidth - link.offsetWidth) / 2;
    list.scrollTo({ left: Math.max(0, target), behavior: "smooth" });
  }, [active]);

  return (
    <nav
      ref={navRef}
      aria-label="On this page"
      className="sticky top-[calc(4.5rem+1px)] z-30 border-b border-sage-300/70 bg-ivory"
    >
      <div className="mx-auto w-full max-w-6xl sm:px-6 lg:px-8">
        {/* Phones: the list runs edge to edge with its own side padding, so
            labels scroll right off the screen edge instead of being clipped
            inside the page margin. */}
        <ul
          ref={listRef}
          onTouchStart={() => {
            touching.current = true;
          }}
          onTouchEnd={() => {
            touching.current = false;
          }}
          onTouchCancel={() => {
            touching.current = false;
          }}
          className="relative flex [scrollbar-width:none] gap-1 overflow-x-auto overscroll-x-contain px-2 py-2 sm:px-0 [&::-webkit-scrollbar]:hidden"
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
                className={`inline-flex min-h-11 shrink-0 items-center rounded-full px-4 text-sm font-semibold whitespace-nowrap transition-colors duration-300 hover:bg-sage-100 ${
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
