import type { StaticImageData } from "next/image";
import bathroom from "@/assets/photos/bathroom.jpg";
import deckEvening from "@/assets/photos/deck-evening.jpg";
import deckGazeboEvening from "@/assets/photos/deck-gazebo-evening.jpg";
import deckViewFountain from "@/assets/photos/deck-view-fountain.jpg";
import detailHydrangea from "@/assets/photos/detail-hydrangea.jpg";
import detailRoses from "@/assets/photos/detail-roses.jpg";
import kitchenIsland from "@/assets/photos/kitchen-island.jpg";
import kitchen from "@/assets/photos/kitchen.jpg";
import livingRoomKitchen from "@/assets/photos/living-room-kitchen.jpg";
import livingRoomMediaWall from "@/assets/photos/living-room-media-wall.jpg";
import livingRoomOpenPlan from "@/assets/photos/living-room-open-plan.jpg";
import lodgeAcrossWater from "@/assets/photos/lodge-across-water.jpg";
import lodgeAndNeighbours from "@/assets/photos/lodge-and-neighbours.jpg";
import mainBedroomArt from "@/assets/photos/main-bedroom-art.jpg";
import mainBedroom from "@/assets/photos/main-bedroom.jpg";
import mediaWallFire from "@/assets/photos/media-wall-fire.jpg";
import secondBedroomDetail from "@/assets/photos/second-bedroom-detail.jpg";
import secondBedroom from "@/assets/photos/second-bedroom.jpg";
import twinBedroom from "@/assets/photos/twin-bedroom.jpg";
import utilityRoom from "@/assets/photos/utility-room.jpg";
import walkInWardrobe from "@/assets/photos/walk-in-wardrobe.jpg";

/**
 * Photography manifest.
 *
 * Source: the owner's Airbnb listing photos, supplied to us with the owner's
 * permission to use them on this site (October 2026). Files were re-saved
 * without metadata. They are small (most 720px on the long edge), so layouts
 * show them at or near natural size; replace with the owner's originals when
 * available for sharper large crops. See docs/CONTENT.md.
 *
 * Room grouping is inferred from the photos (three bedrooms: a double with
 * floral artwork, a double with a tall upholstered headboard, and a twin) and
 * needs the owner's confirmation, as does which living-room layout is current
 * (`confirm` notes below).
 */

export type Space =
  | "outside"
  | "living"
  | "kitchen"
  | "main-bedroom"
  | "second-bedroom"
  | "twin-bedroom"
  | "bathroom"
  | "details";

export interface Photo {
  id: string;
  image: StaticImageData;
  /** Describes what is actually in the picture. */
  alt: string;
  caption: string;
  space: Space;
  /** CSS object-position for cropping. */
  focus?: string;
  /** Something the owner should confirm before launch. */
  confirm?: string;
}

export const photos: Photo[] = [
  {
    id: "lodge-across-water",
    image: lodgeAcrossWater,
    alt: "The lodge seen across the water on a sunny day, its grey decking and wicker furniture reflected in the pond",
    caption: "The lodge from across the water",
    space: "outside",
    focus: "50% 45%",
  },
  {
    id: "deck-view-fountain",
    image: deckViewFountain,
    alt: "Wicker chairs and a glass-topped table on the deck, looking over a glass balustrade to the pond, its fountain and neighbouring lodges",
    caption: "From the deck",
    space: "outside",
    focus: "60% 50%",
  },
  {
    id: "lodge-and-neighbours",
    image: lodgeAndNeighbours,
    alt: "Wide view of the lodge between its neighbours, set back behind a lawn at the water's edge under a clear blue sky",
    caption: "Lakeside, among the trees",
    space: "outside",
    focus: "50% 50%",
  },
  {
    id: "deck-evening",
    image: deckEvening,
    alt: "The deck at dusk, lit by post lights, with pots of pink dahlias, wicker seating and the lit windows of lodges across the water",
    caption: "Evenings on the deck",
    space: "outside",
    focus: "50% 60%",
  },
  {
    id: "deck-gazebo-evening",
    image: deckGazeboEvening,
    alt: "A wicker sofa and fire table under a gazebo draped with greenery, lit by small deck lights after dark",
    caption: "The covered seating area after dark",
    space: "outside",
    focus: "50% 55%",
    confirm:
      "Fire table: confirm it is available to guests before describing it.",
  },
  {
    id: "living-room-media-wall",
    image: livingRoomMediaWall,
    alt: "Living room with a grey sofa facing a wall-mounted television above a long electric fire, a dining table by the patio doors and a slatted feature wall",
    caption: "Living and dining",
    space: "living",
    focus: "45% 50%",
    confirm:
      "Two living-room layouts appear in the listing; confirm which is current.",
  },
  {
    id: "media-wall-fire",
    image: mediaWallFire,
    alt: "Media wall with a television above a wide electric fire, framed by lit shelves with slatted wood panels and vases",
    caption: "The media wall",
    space: "living",
  },
  {
    id: "living-room-kitchen",
    image: livingRoomKitchen,
    alt: "Bright open-plan living area with grey sofas, a blue armchair and footstool, a stove, and the kitchen island beyond",
    caption: "Open-plan living",
    space: "living",
    confirm: "Older layout? Confirm before launch.",
  },
  {
    id: "living-room-open-plan",
    image: livingRoomOpenPlan,
    alt: "Open-plan room with bar stools at the kitchen island, armchairs by the patio doors and a television above a fireplace",
    caption: "Kitchen to living room",
    space: "living",
    confirm: "Older layout? Confirm before launch.",
  },
  {
    id: "kitchen",
    image: kitchen,
    alt: "Kitchen with white cabinets, oven and microwave, an island with two grey bar stools, and patio doors with blue floral curtains",
    caption: "The kitchen",
    space: "kitchen",
  },
  {
    id: "kitchen-island",
    image: kitchenIsland,
    alt: "Kitchen island with open shelving and grey bar stools, white cabinets, a built-in oven and a herringbone floor",
    caption: "Kitchen island",
    space: "kitchen",
  },
  {
    id: "utility-room",
    image: utilityRoom,
    alt: "Utility room with a second sink, white cupboards and a herringbone floor, with a heart-shaped wreath on the door",
    caption: "Utility room",
    space: "kitchen",
  },
  {
    id: "main-bedroom",
    image: mainBedroom,
    alt: "Double bedroom with white bedding, a grey throw, blush cushions and three framed peony prints above the bed",
    caption: "Main bedroom",
    space: "main-bedroom",
  },
  {
    id: "main-bedroom-art",
    image: mainBedroomArt,
    alt: "The main bed dressed with pink velvet cushions beneath three large peony prints, with bedside lamps either side",
    caption: "Main bedroom",
    space: "main-bedroom",
    focus: "50% 60%",
  },
  {
    id: "walk-in-wardrobe",
    image: walkInWardrobe,
    alt: "Walk-in wardrobe with hanging rail and wooden hangers, shelving, drawers, a mirror and a hairdryer",
    caption: "Walk-in wardrobe",
    space: "main-bedroom",
    confirm: "Confirm which bedroom the walk-in wardrobe belongs to.",
  },
  {
    id: "second-bedroom",
    image: secondBedroom,
    alt: "Double bedroom with a tall grey upholstered headboard, blue and grey cushions and matching bedside lamps",
    caption: "Second bedroom",
    space: "second-bedroom",
  },
  {
    id: "second-bedroom-detail",
    image: secondBedroomDetail,
    alt: "The second double bed with peacock-print cushions and a tray with sparkling wine and two glasses",
    caption: "Second bedroom",
    space: "second-bedroom",
  },
  {
    id: "twin-bedroom",
    image: twinBedroom,
    alt: "Twin bedroom with two single beds, grey bed runners and leaf-print cushions either side of a bedside table",
    caption: "Twin bedroom",
    space: "twin-bedroom",
  },
  {
    id: "bathroom",
    image: bathroom,
    alt: "Bathroom with a basin set in a wood-effect vanity, a large mirror with shelving and plants, and a shower visible in the mirror",
    caption: "Bathroom",
    space: "bathroom",
    confirm: "The listing mentions two bathrooms; only one is pictured.",
  },
  {
    id: "detail-roses",
    image: detailRoses,
    alt: "Cream roses in a glass vase beside a heart-patterned jug on the kitchen counter",
    caption: "Thoughtful touches",
    space: "details",
  },
  {
    id: "detail-hydrangea",
    image: detailHydrangea,
    alt: "A soft pink hydrangea resting on a wooden shelf",
    caption: "Thoughtful touches",
    space: "details",
  },
];

export const photo = (id: string) => {
  const found = photos.find((p) => p.id === id);
  if (!found) throw new Error(`Unknown photo id: ${id}`);
  return found;
};

export const photosIn = (...spaces: Space[]) =>
  photos.filter((p) => spaces.includes(p.space));

/** The order used for the full gallery on /stay. */
export const galleryOrder: Space[] = [
  "outside",
  "living",
  "kitchen",
  "main-bedroom",
  "second-bedroom",
  "twin-bedroom",
  "bathroom",
  "details",
];
