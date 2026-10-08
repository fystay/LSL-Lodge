import Image from "next/image";
import type { Photo } from "@/content/photos";

/**
 * Renders an approved photograph, or a clearly labelled placeholder that
 * describes the shot still needed. Placeholders are deliberately abstract so
 * they can never be mistaken for the real lodge.
 */
export function PhotoFrame({
  photo,
  sizes,
  priority = false,
  className = "",
  aspect = "aspect-[4/3]",
}: {
  photo: Photo;
  sizes: string;
  priority?: boolean;
  className?: string;
  aspect?: string;
}) {
  if (photo.status === "approved" && photo.src && photo.width && photo.height) {
    return (
      <div
        className={`relative overflow-hidden rounded-soft bg-mist ${aspect} ${className}`}
      >
        <Image
          src={photo.src}
          alt={photo.alt}
          fill
          sizes={sizes}
          priority={priority}
          className="object-cover"
          style={{ objectPosition: photo.focus ?? "center" }}
        />
      </div>
    );
  }

  return (
    <div
      role="img"
      aria-label={`Photograph to come: ${photo.brief}`}
      className={`relative flex overflow-hidden rounded-soft bg-sage-100 ${aspect} ${className}`}
    >
      <svg
        aria-hidden="true"
        className="absolute inset-0 h-full w-full"
        viewBox="0 0 400 300"
        preserveAspectRatio="xMidYMid slice"
      >
        <rect width="400" height="300" fill="var(--color-mist)" />
        <path
          d="M0 150 C 80 110, 150 120, 220 135 S 340 120, 400 128 L400 300 L0 300 Z"
          fill="var(--color-sage-300)"
          opacity="0.7"
        />
        <path
          d="M0 185 C 90 165, 170 178, 260 172 S 360 168, 400 176 L400 300 L0 300 Z"
          fill="var(--color-sage-600)"
          opacity="0.35"
        />
        <rect
          y="200"
          width="400"
          height="100"
          fill="var(--color-pine-800)"
          opacity="0.12"
        />
        <path
          d="M30 228 H150 M190 244 H330 M80 262 H240"
          stroke="var(--color-ivory)"
          strokeWidth="1.5"
          opacity="0.6"
        />
      </svg>
      <span className="relative m-3 mt-auto rounded-soft bg-ivory/90 px-3 py-2 text-sm text-ink">
        <span className="font-semibold">Photograph to come</span>
        <span className="block text-ink-muted">{photo.brief}</span>
      </span>
    </div>
  );
}
