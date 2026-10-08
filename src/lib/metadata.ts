import type { Metadata } from "next";

/** Per-page metadata with a canonical URL (resolved against metadataBase). */
export function pageMetadata(
  path: string,
  title: string,
  description: string,
): Metadata {
  return {
    title,
    description,
    alternates: { canonical: path },
    openGraph: { title, description, url: path },
  };
}

/** Private routes: never indexed, regardless of SITE_INDEXABLE. */
export const privateRouteMetadata: Metadata = {
  robots: { index: false, follow: false, nocache: true },
};
