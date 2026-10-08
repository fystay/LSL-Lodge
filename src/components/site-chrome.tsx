import type { ReactNode } from "react";
import { SiteFooter } from "./site-footer";
import { SiteHeader } from "./site-header";

/** Public-site frame: skip link, preview banner, header, main landmark, footer. */
export function SiteChrome({ children }: { children: ReactNode }) {
  return (
    <>
      <a
        href="#main"
        className="sr-only z-50 rounded-soft bg-pine-900 px-4 py-3 font-semibold text-ivory focus:not-sr-only focus:fixed focus:top-3 focus:left-3"
      >
        Skip to content
      </a>
      <div
        id="site-notice"
        role="note"
        className="bg-notice px-4 py-2 text-center text-sm text-notice-ink"
      >
        Preview site: online booking is not open yet, and details marked
        &ldquo;To be confirmed&rdquo; are awaiting the owner.
      </div>
      <SiteHeader />
      {/* Runs before first paint: exposes the banner + header height as
          --chrome-h so the homepage hero can fill exactly the first screen. */}
      <script
        dangerouslySetInnerHTML={{
          __html: `(function(){var n=document.getElementById("site-notice"),h=document.getElementById("site-header");if(!n||!h)return;function s(){document.documentElement.style.setProperty("--chrome-h",n.offsetHeight+h.offsetHeight+"px")}s();addEventListener("resize",s)})()`,
        }}
      />
      <main id="main" className="flex-1">
        {children}
      </main>
      <SiteFooter />
    </>
  );
}
