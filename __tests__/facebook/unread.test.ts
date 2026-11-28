import { describe, expect, it } from "vitest";
import { isClientApiPath } from "../../lib/agency/client-paths";
import { titleWithUnread } from "../../lib/facebook/unread";

/** The unread count in the browser tab, and who may read it. */
describe("unread conversations", () => {
  it("puts the count in front of the tab title, once, and removes it at zero", () => {
    expect(titleWithUnread("Amitec Reply", 3)).toBe("(3) Amitec Reply");
    expect(titleWithUnread("(3) Amitec Reply", 5)).toBe("(5) Amitec Reply");
    expect(titleWithUnread("(5) Amitec Reply", 0)).toBe("Amitec Reply");
    expect(titleWithUnread("Amitec Reply", 0)).toBe("Amitec Reply");
  });

  it("is open to a brand owner, like the inbox itself", () => {
    expect(isClientApiPath("/api/facebook/conversations/unread")).toBe(true);
  });
});
