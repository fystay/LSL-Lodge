import Image from "next/image";
import type { Photo } from "@/content/photos";

/**
 * A cropped, responsive photograph. Static imports give intrinsic size and a
 * blurred placeholder, so nothing shifts while images load.
 */
export function PhotoFrame({
  photo,
  sizes,
  priority = false,
  className = "",
  aspect = "aspect-[4/3]",
  zoomOnHover = false,
}: {
  photo: Photo;
  sizes: string;
  priority?: boolean;
  className?: string;
  aspect?: string;
  zoomOnHover?: boolean;
}) {
  return (
    <div
      className={`relative overflow-hidden rounded-soft bg-mist ${aspect} ${className}`}
    >
      <Image
        src={photo.image}
        alt={photo.alt}
        fill
        sizes={sizes}
        priority={priority}
        placeholder="blur"
        className={`object-cover ${
          zoomOnHover
            ? "transition-transform duration-700 ease-calm motion-safe:group-hover:scale-[1.03]"
            : ""
        }`}
        style={{ objectPosition: photo.focus ?? "center" }}
      />
    </div>
  );
}
