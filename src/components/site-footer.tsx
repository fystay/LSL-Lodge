import Link from "next/link";
import { property } from "@/content/property";
import { policyNav, primaryNav } from "@/lib/site";
import { Container } from "./ui";

export function SiteFooter() {
  return (
    <footer className="mt-auto bg-pine-900 text-sage-100">
      <Container className="grid gap-10 py-14 sm:grid-cols-2 lg:grid-cols-[1.4fr_1fr_1fr]">
        <div>
          <p className="font-display text-2xl text-ivory">{property.name}</p>
          <p className="mt-3 max-w-sm leading-relaxed">
            {property.location.setting.value}, {property.location.region.value}.
          </p>
          <p className="mt-6 text-sm">
            Online booking is not open yet. Please{" "}
            <Link
              href="/contact"
              className="text-wood-200 underline underline-offset-4"
            >
              get in touch
            </Link>{" "}
            with any questions.
          </p>
        </div>

        <nav aria-label="Explore">
          <h2 className="font-sans text-sm font-semibold tracking-[0.14em] text-wood-200 uppercase">
            Explore
          </h2>
          <ul className="mt-4 space-y-1">
            {primaryNav.map((item) => (
              <li key={item.href}>
                <Link
                  href={item.href}
                  className="inline-flex min-h-10 items-center hover:text-ivory"
                >
                  {item.label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>

        <nav aria-label="Policies">
          <h2 className="font-sans text-sm font-semibold tracking-[0.14em] text-wood-200 uppercase">
            Policies
          </h2>
          <ul className="mt-4 space-y-1">
            {policyNav.map((item) => (
              <li key={item.href}>
                <Link
                  href={item.href}
                  className="inline-flex min-h-10 items-center hover:text-ivory"
                >
                  {item.label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
      </Container>
      <div className="border-t border-sage-100/15">
        <Container className="py-6 text-sm">
          <p>
            &copy; {property.name}. Independent holiday accommodation. Not
            affiliated with Airbnb.
          </p>
        </Container>
      </div>
    </footer>
  );
}
