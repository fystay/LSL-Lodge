import { describe, expect, it } from "vitest";
import { parseIsoDate } from "./dates";
import { validateStaySearch } from "./stay-search";

const limits = { maxGuests: 6, minNights: 2, maxNights: 28, horizonDays: 540 };
const today = parseIsoDate("2026-10-08");
const run = (params: Record<string, string | string[] | undefined>) =>
  validateStaySearch(params, limits, today);

const fields = (result: ReturnType<typeof run>) =>
  result.status === "invalid" ? result.errors.map((e) => e.field) : [];

describe("validateStaySearch", () => {
  it("treats an empty query as no search", () => {
    expect(run({})).toEqual({ status: "empty" });
  });

  it("accepts a valid search and counts nights", () => {
    expect(
      run({ checkIn: "2026-11-06", checkOut: "2026-11-09", guests: "4" }),
    ).toEqual({
      status: "valid",
      search: {
        checkIn: "2026-11-06",
        checkOut: "2026-11-09",
        guests: 4,
        nights: 3,
      },
    });
  });

  it("allows checking in today", () => {
    expect(
      run({ checkIn: "2026-10-08", checkOut: "2026-10-10", guests: "2" })
        .status,
    ).toBe("valid");
  });

  it("rejects past check-in", () => {
    expect(
      fields(
        run({ checkIn: "2026-10-07", checkOut: "2026-10-10", guests: "2" }),
      ),
    ).toEqual(["checkIn"]);
  });

  it("rejects check-out on or before check-in", () => {
    expect(
      fields(
        run({ checkIn: "2026-11-06", checkOut: "2026-11-06", guests: "2" }),
      ),
    ).toEqual(["checkOut"]);
    expect(
      fields(
        run({ checkIn: "2026-11-06", checkOut: "2026-11-05", guests: "2" }),
      ),
    ).toEqual(["checkOut"]);
  });

  it("enforces minimum and maximum stay", () => {
    expect(
      fields(
        run({ checkIn: "2026-11-06", checkOut: "2026-11-07", guests: "2" }),
      ),
    ).toEqual(["checkOut"]);
    expect(
      fields(
        run({ checkIn: "2026-11-01", checkOut: "2026-12-01", guests: "2" }),
      ),
    ).toEqual(["checkOut"]);
  });

  it("enforces occupancy", () => {
    expect(
      fields(
        run({ checkIn: "2026-11-06", checkOut: "2026-11-09", guests: "7" }),
      ),
    ).toEqual(["guests"]);
    expect(
      fields(
        run({ checkIn: "2026-11-06", checkOut: "2026-11-09", guests: "0" }),
      ),
    ).toEqual(["guests"]);
    expect(
      fields(
        run({ checkIn: "2026-11-06", checkOut: "2026-11-09", guests: "2.5" }),
      ),
    ).toEqual(["guests"]);
  });

  it("enforces the booking horizon", () => {
    expect(
      fields(
        run({ checkIn: "2028-06-01", checkOut: "2028-06-04", guests: "2" }),
      ),
    ).toEqual(["checkIn"]);
  });

  it("rejects impossible or malformed dates", () => {
    expect(
      fields(
        run({ checkIn: "2026-02-30", checkOut: "2026-03-02", guests: "2" }),
      ),
    ).toContain("checkIn");
    expect(
      fields(run({ checkIn: "<script>", checkOut: "x", guests: "2" })),
    ).toEqual(["checkIn", "checkOut"]);
  });

  it("uses the first value of repeated parameters", () => {
    expect(
      run({
        checkIn: ["2026-11-06", "2020-01-01"],
        checkOut: "2026-11-09",
        guests: "2",
      }).status,
    ).toBe("valid");
  });

  it("returns the raw input so the form can be refilled", () => {
    const result = run({ checkIn: "2026-11-06", checkOut: "", guests: "2" });
    expect(result.status === "invalid" && result.input).toEqual({
      checkIn: "2026-11-06",
      checkOut: "",
      guests: "2",
    });
  });
});
