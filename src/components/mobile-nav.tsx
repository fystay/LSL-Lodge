"use client";

import Link from "next/link";
import type { Route } from "next";
import { usePathname } from "next/navigation";
import { useEffect, useId, useRef, useState } from "react";

export function MobileNav({
  items,
}: {
  items: readonly { href: Route; label: string }[];
}) {
  const [open, setOpen] = useState(false);
  const [openedAt, setOpenedAt] = useState<string | null>(null);
  const pathname = usePathname();
  const panelId = useId();
  const buttonRef = useRef<HTMLButtonElement>(null);

  // Close after navigating: the menu only counts as open on the page it was opened on.
  const isOpen = open && openedAt === pathname;

  useEffect(() => {
    if (!isOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        buttonRef.current?.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [isOpen]);

  return (
    <div className="md:hidden">
      <button
        ref={buttonRef}
        type="button"
        aria-expanded={isOpen}
        aria-controls={panelId}
        onClick={() => {
          setOpen(!isOpen);
          setOpenedAt(pathname);
        }}
        className="inline-flex min-h-11 min-w-11 items-center justify-center gap-2 rounded-soft border border-sage-300 px-3 text-sm font-semibold text-pine-900"
      >
        <svg
          aria-hidden="true"
          width="20"
          height="20"
          viewBox="0 0 20 20"
          fill="none"
        >
          {isOpen ? (
            <path
              d="M5 5l10 10M15 5L5 15"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
            />
          ) : (
            <path
              d="M3 6h14M3 10h14M3 14h14"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
            />
          )}
        </svg>
        Menu
      </button>

      <nav
        id={panelId}
        aria-label="Main"
        hidden={!isOpen}
        className="absolute inset-x-0 top-full border-b border-sage-300 bg-ivory shadow-[0_12px_24px_-16px_rgba(20,39,31,0.35)]"
      >
        <ul className="mx-auto flex max-w-6xl flex-col px-4 py-3 sm:px-6">
          {items.map((item) => (
            <li key={item.href}>
              <Link
                href={item.href}
                aria-current={pathname === item.href ? "page" : undefined}
                className="flex min-h-12 items-center border-b border-sage-300/50 text-lg text-pine-900"
              >
                {item.label}
              </Link>
            </li>
          ))}
          <li className="py-4">
            <Link
              href="/availability"
              className="flex min-h-12 items-center justify-center rounded-soft bg-pine-800 px-6 font-semibold text-ivory"
            >
              Check availability
            </Link>
          </li>
        </ul>
      </nav>
    </div>
  );
}
