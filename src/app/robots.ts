import type { MetadataRoute } from "next";
import { siteIndexable, siteUrl } from "@/lib/site";

export default function robots(): MetadataRoute.Robots {
  if (!siteIndexable) {
    // Pre-launch: keep the whole site out of search indexes.
    return { rules: { userAgent: "*", disallow: "/" } };
  }
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      disallow: ["/admin", "/api", "/book", "/booking", "/availability"],
    },
    sitemap: `${siteUrl}/sitemap.xml`,
  };
}
