import type { Metadata, Viewport } from "next";
import { Newsreader, Public_Sans } from "next/font/google";
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
      data-scroll-behavior="smooth"
      // An inline script in SiteChrome sets --chrome-h on <html> before hydration.
      suppressHydrationWarning
      className={`${display.variable} ${sans.variable} h-full antialiased`}
    >
      <body className="flex min-h-full flex-col bg-ivory text-ink">
        {children}
      </body>
    </html>
  );
}
