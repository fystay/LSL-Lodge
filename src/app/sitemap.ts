import type { MetadataRoute } from "next";
import { siteUrl } from "@/lib/site";

const publicPaths = [
  "/",
  "/stay",
  "/location",
  "/information",
  "/contact",
  "/cancellation-policy",
  "/terms",
  "/privacy",
];

export default function sitemap(): MetadataRoute.Sitemap {
  return publicPaths.map((path) => ({
    url: `${siteUrl}${path === "/" ? "" : path}`,
  }));
}
