import { describe, expect, it } from "vitest";
import { backTarget } from "../lib/navigation";

/** The header's back arrow: none on menu pages, the parent page elsewhere. */
describe("backTarget", () => {
  it("shows no arrow on a menu page", () => {
    expect(backTarget("/facebook/inbox")).toBeNull();
    expect(backTarget("/settings")).toBeNull();
    expect(backTarget("/agency")).toBeNull();
  });

  it("goes one page up", () => {
    expect(backTarget("/facebook/products/cmwx123")).toBe("/facebook/products");
    expect(backTarget("/facebook/products/attributes")).toBe("/facebook/products");
    expect(backTarget("/facebook/knowledge/suggestions")).toBe("/facebook/knowledge");
    expect(backTarget("/campaigns/abc/edit")).toBe("/campaigns/abc");
    expect(backTarget("/facebook/campaigns/new/")).toBe("/facebook/campaigns");
  });

  it("leaves it to the browser history when there is no parent page", () => {
    expect(backTarget("/automations")).toBe("");
  });
});
