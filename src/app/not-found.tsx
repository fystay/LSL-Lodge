import { NotFoundContent } from "@/components/not-found-content";
import { SiteChrome } from "@/components/site-chrome";

/** Unmatched URLs: no layout wraps this, so it brings the site chrome itself. */
export default function NotFound() {
  return (
    <SiteChrome>
      <NotFoundContent />
    </SiteChrome>
  );
}
