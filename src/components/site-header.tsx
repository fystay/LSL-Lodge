import Link from "next/link";
import { primaryNav } from "@/lib/site";
import { MobileNav } from "./mobile-nav";
import { Container, buttonClasses } from "./ui";

export function SiteHeader() {
  return (
    <header
      id="site-header"
      className="sticky top-0 z-40 border-b border-sage-300/70 bg-ivory"
    >
      <Container className="flex h-18 items-center justify-between gap-6">
        <Link
          href="/"
          className="group flex flex-col leading-none"
          aria-label="Lodge on the Lake, home"
        >
          <span className="font-display text-[1.6rem] tracking-tight text-pine-900">
            Lodge on the Lake
          </span>
          <span className="mt-1 text-[0.7rem] font-semibold tracking-[0.2em] text-sage-600 uppercase">
            South Lakeland
          </span>
        </Link>

        <nav aria-label="Main" className="hidden md:block">
          <ul className="flex items-center gap-7">
            {primaryNav.map((item) => (
              <li key={item.href}>
                <Link
                  href={item.href}
                  className="py-2 text-[0.95rem] font-medium text-ink transition-colors hover:text-pine-700"
                >
                  {item.label}
                </Link>
              </li>
            ))}
            <li>
              <Link
                href="/availability"
                className={`${buttonClasses("primary")} min-h-11 px-5 text-sm`}
              >
                Check availability
              </Link>
            </li>
          </ul>
        </nav>

        <MobileNav items={primaryNav} />
      </Container>
    </header>
  );
}
