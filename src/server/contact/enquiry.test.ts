import { describe, expect, it } from "vitest";
import { readEnquiry } from "./enquiry";

const form = (fields: Record<string, string>) => {
  const data = new FormData();
  for (const [k, v] of Object.entries(fields)) data.set(k, v);
  return data;
};

describe("readEnquiry", () => {
  it("accepts a complete enquiry", () => {
    const { result } = readEnquiry(
      form({
        name: "Sam",
        email: "sam@example.test",
        message: "Is the lodge free at Easter?",
      }),
    );
    expect(result.success).toBe(true);
  });

  it("reports each invalid field", () => {
    const { result } = readEnquiry(
      form({ name: "", email: "nope", message: "hi" }),
    );
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((i) => i.path[0]).sort()).toEqual([
      "email",
      "message",
      "name",
    ]);
  });

  it("rejects submissions that fill the honeypot", () => {
    const { result } = readEnquiry(
      form({
        name: "Bot",
        email: "bot@example.test",
        message: "Buy things now please",
        website: "x",
      }),
    );
    expect(result.success).toBe(false);
  });

  it("bounds the length of echoed values", () => {
    const { values } = readEnquiry(
      form({ name: "a".repeat(10_000), email: "", message: "" }),
    );
    expect(values.name.length).toBe(200);
  });
});
