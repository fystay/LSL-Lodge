import Link from "next/link";
import { signOutAction } from "../actions";

const nav = [
  { href: "/admin", label: "Overview" },
  { href: "/admin/bookings", label: "Bookings" },
  { href: "/admin/calendar", label: "Calendar" },
  { href: "/admin/blocks", label: "Blocked dates" },
  { href: "/admin/calendars", label: "Calendar sync" },
  { href: "/admin/pricing", label: "Pricing" },
  { href: "/admin/settings", label: "Settings" },
] as const;

export default function ConsoleLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <>
      <a
        href="#main"
        className="sr-only z-50 rounded-soft bg-pine-900 px-4 py-3 font-semibold text-ivory focus:not-sr-only focus:fixed focus:top-3 focus:left-3"
      >
        Skip to content
      </a>
      <header className="bg-pine-900 text-sage-100">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-6">
          <p className="font-display text-xl text-ivory">
            Lodge on the Lake · Admin
          </p>
          <form action={signOutAction}>
            <button
              type="submit"
              className="min-h-11 rounded-soft px-3 text-sm font-semibold underline underline-offset-4"
            >
              Sign out
            </button>
          </form>
        </div>
        <nav
          aria-label="Admin"
          className="mx-auto max-w-6xl overflow-x-auto px-4 sm:px-6"
        >
          <ul className="flex gap-1 pb-2">
            {nav.map((item) => (
              <li key={item.href}>
                <Link
                  href={item.href}
                  className="inline-flex min-h-11 items-center rounded-soft px-3 text-sm font-semibold whitespace-nowrap hover:bg-pine-800"
                >
                  {item.label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
      </header>
      <main
        id="main"
        className="mx-auto w-full max-w-6xl flex-1 px-4 py-8 sm:px-6"
      >
        {children}
      </main>
    </>
  );
}
