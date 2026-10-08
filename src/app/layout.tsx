import type { Metadata, Viewport } from "next";
import { Newsreader, Public_Sans } from "next/font/google";
import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";
import { property } from "@/content/property";
import { siteIndexable, siteUrl } from "@/lib/site";
import "./globals.css";

const display = Newsreader({
  variable: "--font-newsreader",
  subsets: ["latin"],
  style: ["normal", "italic"],
  display: "swap",
});

const sans = Public_Sans({
  variable: "--font-public-sans",
  subsets: ["latin"],
  display: "swap",
});

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: {
    default: `${property.name} — lakeside lodge in South Lakeland`,
    template: `%s · ${property.name}`,
  },
  description:
    "A quiet lakeside lodge at South Lakeland Leisure Village, near the Lake District, offered directly by its owner.",
  applicationName: property.name,
  openGraph: {
    type: "website",
    siteName: property.name,
    locale: "en_GB",
  },
  robots: siteIndexable ? undefined : { index: false, follow: false },
};

export const viewport: Viewport = {
  themeColor: "#f7f3ea",
  colorScheme: "light",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en-GB"
      className={`${display.variable} ${sans.variable} h-full antialiased`}
    >
      <body className="flex min-h-full flex-col bg-ivory text-ink">
        <a
          href="#main"
          className="sr-only z-50 rounded-soft bg-pine-900 px-4 py-3 font-semibold text-ivory focus:not-sr-only focus:fixed focus:top-3 focus:left-3"
        >
          Skip to content
        </a>
        <div
          role="note"
          className="bg-notice px-4 py-2 text-center text-sm text-notice-ink"
        >
          Preview site: online booking is not open yet, and details marked
          &ldquo;To be confirmed&rdquo; are awaiting the owner.
        </div>
        <SiteHeader />
        <main id="main" className="flex-1">
          {children}
        </main>
        <SiteFooter />
      </body>
    </html>
  );
}
