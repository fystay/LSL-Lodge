/**
 * Photography manifest.
 *
 * No owner-approved photography exists yet, so every entry is a placeholder
 * describing the shot needed. Images must not be copied from Airbnb or any
 * other site, and AI-generated images must not stand in for the real property.
 *
 * To add a real photo: place the file in /public/photos (at least 2400px on
 * the long edge, sRGB, JPEG or WebP), set `src`, `width`, `height`, write
 * accurate alt text, and set `status: "approved"` once the owner signs off.
 * See docs/CONTENT.md for the full shot list.
 */

export interface Photo {
  id: string;
  /** What the photograph should show (used for the placeholder and the brief). */
  brief: string;
  /** Alt text describing the actual image. Required for approved photos. */
  alt: string;
  caption?: string;
  status: "placeholder" | "approved";
  src?: string;
  width?: number;
  height?: number;
  /** Suggested focal point for cropping, as CSS object-position. */
  focus?: string;
}

const needed = (id: string, brief: string, caption?: string): Photo => ({
  id,
  brief,
  alt: "",
  caption,
  status: "placeholder",
});

export const photos: Photo[] = [
  needed(
    "hero",
    "The lodge and its setting at golden hour, lake in view",
    "The lodge and the lake",
  ),
  needed(
    "deck-view",
    "View from the decking across the water",
    "From the deck",
  ),
  needed("living", "Living area in natural light", "Living area"),
  needed("kitchen", "Kitchen and dining space", "Kitchen and dining"),
  needed("bedroom-1", "Main bedroom", "Main bedroom"),
  needed("bedroom-2", "Second bedroom", "Second bedroom"),
  needed("bedroom-3", "Third bedroom", "Third bedroom"),
  needed("bathroom", "Bathroom", "Bathroom"),
  needed("surroundings", "Nearby walks or the wider landscape", "Nearby"),
];

export const photo = (id: string) => {
  const found = photos.find((p) => p.id === id);
  if (!found) throw new Error(`Unknown photo id: ${id}`);
  return found;
};
