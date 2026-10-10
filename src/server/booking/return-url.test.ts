import { describe, expect, it } from "vitest";
import { checkoutReturnBase } from "./return-url";

const site = "https://lsllodge-git-claude-instant-booking-fystay1.vercel.app";
const env = {
  VERCEL_URL: "lsllodge-ob0zo3qu1-fystay1.vercel.app",
  VERCEL_BRANCH_URL: "lsllodge-git-claude-instant-booking-fystay1.vercel.app",
};

describe("checkoutReturnBase", () => {
  it("returns the guest to the deployment address they booked on", () => {
    expect(
      checkoutReturnBase("lsllodge-ob0zo3qu1-fystay1.vercel.app", env, site),
    ).toBe("https://lsllodge-ob0zo3qu1-fystay1.vercel.app");
  });

  it("keeps SITE_URL when the guest is already on it", () => {
    expect(
      checkoutReturnBase(
        "LSLLODGE-git-claude-instant-booking-fystay1.vercel.app",
        env,
        site,
      ),
    ).toBe(site.toLowerCase());
  });

  it("never returns to a host that isn't this deployment's", () => {
    expect(checkoutReturnBase("evil.example.com", env, site)).toBe(site);
    expect(checkoutReturnBase("lsllodge.vercel.app", env, site)).toBe(site);
    expect(
      checkoutReturnBase("x.vercel.app/@evil.example.com", env, site),
    ).toBe(site);
    expect(checkoutReturnBase(null, env, site)).toBe(site);
    expect(
      checkoutReturnBase("localhost:3000", {}, "http://localhost:3000"),
    ).toBe("http://localhost:3000");
  });
});
