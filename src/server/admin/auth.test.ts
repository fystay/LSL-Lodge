import { describe, expect, it } from "vitest";
import { canDo, isFresh } from "./auth";
import { SESSION } from "./accounts";

describe("admin permissions", () => {
  it("lets owners manage and viewers only view", () => {
    expect(canDo("OWNER", "view")).toBe(true);
    expect(canDo("OWNER", "manage")).toBe(true);
    expect(canDo("VIEWER", "view")).toBe(true);
    expect(canDo("VIEWER", "manage")).toBe(false);
  });

  it("treats step-up as fresh only within the window", () => {
    const now = new Date("2026-10-09T12:00:00Z");
    const ago = (m: number) => new Date(now.getTime() - m * 60_000);
    expect(isFresh(ago(1), now)).toBe(true);
    expect(isFresh(ago(SESSION.freshMinutes), now)).toBe(true);
    expect(isFresh(ago(SESSION.freshMinutes + 1), now)).toBe(false);
    expect(isFresh(null, now)).toBe(false);
  });
});
