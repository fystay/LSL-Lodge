import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/** Reads the design tokens straight from globals.css so the test tracks the real palette. */
const css = readFileSync(
  new URL("../app/globals.css", import.meta.url),
  "utf8",
);
const tokens = Object.fromEntries(
  [...css.matchAll(/--color-([a-z0-9-]+):\s*(#[0-9a-f]{6});/gi)].map((m) => [
    m[1],
    m[2],
  ]),
);

function luminance(hex: string) {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

// [foreground, background, minimum ratio]
// 4.5 = normal text (AA); 3 = large text, icons, focus indicators (AA).
const pairings: [string, string, number][] = [
  ["ink", "ivory", 4.5],
  ["ink", "limestone", 4.5],
  ["ink", "mist", 4.5],
  ["ink", "sage-100", 4.5],
  ["ink-muted", "ivory", 4.5],
  ["ink-muted", "limestone", 4.5],
  ["ink-muted", "sage-100", 4.5],
  ["pine-900", "ivory", 4.5],
  ["pine-900", "limestone", 4.5],
  ["pine-800", "ivory", 4.5],
  ["sage-600", "ivory", 4.5],
  ["wood", "ivory", 4.5],
  ["wood", "limestone", 4.5],
  ["ivory", "pine-800", 4.5],
  ["ivory", "pine-700", 4.5],
  ["ivory", "pine-900", 4.5],
  ["sage-100", "pine-900", 4.5],
  ["wood-200", "pine-900", 4.5],
  ["notice-ink", "notice", 4.5],
  ["danger", "ivory", 4.5],
  ["success", "ivory", 4.5],
  ["wood", "ivory", 3], // focus outline
  ["wood-200", "pine-900", 3], // focus outline on dark sections
];

describe("palette contrast (WCAG 2.2 AA)", () => {
  it.each(pairings)("%s on %s ≥ %d:1", (fg, bg, min) => {
    expect(tokens[fg], `token ${fg}`).toBeDefined();
    expect(tokens[bg], `token ${bg}`).toBeDefined();
    expect(contrast(tokens[fg], tokens[bg])).toBeGreaterThanOrEqual(min);
  });
});
