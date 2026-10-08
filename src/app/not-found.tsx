import { SiteChrome } from "@/components/site-chrome";
import { ButtonLink, Container } from "@/components/ui";

export default function NotFound() {
  return (
    <SiteChrome>
      <Container className="py-24 text-center">
        <p className="text-sm font-semibold tracking-[0.14em] text-wood uppercase">
          Page not found
        </p>
        <h1 className="mt-3 text-title">We couldn&rsquo;t find that page</h1>
        <p className="mx-auto mt-4 max-w-md text-ink-muted">
          It may have moved. The links below will take you somewhere useful.
        </p>
        <div className="mt-8 flex flex-wrap justify-center gap-3">
          <ButtonLink href="/">Home</ButtonLink>
          <ButtonLink href="/contact" variant="secondary">
            Contact
          </ButtonLink>
        </div>
      </Container>
    </SiteChrome>
  );
}
