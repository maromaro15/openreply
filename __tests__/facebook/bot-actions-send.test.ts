import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** Sending the bot's pictures and comparisons (PLAN.md 6.14). */
const db = vi.hoisted(() => ({
  product: { findMany: vi.fn() },
  productAttribute: { findMany: vi.fn() },
  facebookMessage: { create: vi.fn(), updateMany: vi.fn() },
}));
const send = vi.hoisted(() => ({ sendTemplateMessage: vi.fn(), sendMessage: vi.fn() }));
vi.mock("@/lib/db/client", () => ({ prisma: db }));
vi.mock("@/lib/facebook/graph", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/facebook/graph")>()),
  sendMessage: send.sendMessage,
}));
vi.mock("@/lib/facebook/pages", () => ({ pageToken: () => "PAGE_TOKEN" }));
vi.mock("@/lib/facebook/templates-send", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/facebook/templates-send")>()),
  sendTemplateMessage: send.sendTemplateMessage,
}));

import { FacebookApiError } from "../../lib/facebook/graph";
import { decodePostbackPayload } from "../../lib/facebook/postbacks";
import { sendBotActions } from "../../lib/facebook/bot-actions-send";

const conversation = {
  id: "conv_1", workspaceId: "ws_a", psid: "psid_1",
  page: { id: "fp_1", pageId: "1001", accessToken: "enc" },
} as never;
const PRODUCT = {
  id: "prod_wp", name: "Papier peint 3D", code: "WP-12", price: "1200 DA", available: true, landingUrl: "https://shop.example/wp",
  attributes: { thickness: 3 }, mainImage: { publicId: "M".repeat(32) },
  variants: [
    { code: "12-04", name: "Gris", available: true, image: { publicId: "G".repeat(32) } },
    { code: "12-01", name: "Blanc", available: true, image: { publicId: "B".repeat(32) } },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("NEXTAUTH_URL", "https://app.lina.dz/");
  db.productAttribute.findMany.mockResolvedValue([{ key: "thickness", label: "السمك", type: "NUMBER", options: [], unit: "mm" }]);
  db.product.findMany.mockResolvedValue([PRODUCT]);
  db.facebookMessage.create.mockImplementation(async () => ({ id: `row_${db.facebookMessage.create.mock.calls.length}` }));
  db.facebookMessage.updateMany.mockResolvedValue({ count: 1 });
  send.sendTemplateMessage.mockResolvedValue({ messageId: "m_t1" });
  send.sendMessage.mockResolvedValue({ recipient_id: "psid_1", message_id: "m_txt" });
});
afterEach(() => vi.unstubAllEnvs());

describe("the bot's pictures", () => {
  it("sends the colours as cards with «نحب هذا», tracked for the inbox and the echo", async () => {
    const result = await sendBotActions(conversation, [{ type: "send_colours", product: "wp 12", colours: ["12-04", "12 01"] }]);
    expect(result).toEqual({ sent: 1, dropped: 0 });
    const [pageId, token, options] = send.sendTemplateMessage.mock.calls[0];
    expect([pageId, token, options.psid, options.metadata]).toEqual(["1001", "PAGE_TOKEN", "psid_1", "openreply:row_1"]);
    const elements = options.message.attachment.payload.elements;
    expect(elements.map((element: { title: string }) => element.title)).toEqual(["12-04 Gris", "12-01 Blanc"]);
    expect(elements[0].image_url).toBe(`https://app.lina.dz/api/public/media/${"G".repeat(32)}`);
    expect(decodePostbackPayload(elements[0].buttons[0].payload)).toEqual({ kind: "like", productId: "prod_wp", variantCode: "12-04" });
    expect(elements[0].buttons[0].title).toBe("نحب هذا");
    // Stored for the inbox and the echo, answering no message: the reply alone counts towards the hourly cap.
    const row = db.facebookMessage.create.mock.calls[0][0].data;
    expect(row).toMatchObject({ author: "BOT", text: "12-04 Gris · 12-01 Blanc", attachmentType: "template", sendStatus: "PENDING" });
    expect(row.replyToMid).toBeUndefined();
    expect(db.facebookMessage.updateMany).toHaveBeenCalledWith({ where: { id: "row_1", mid: null }, data: { mid: "m_t1" } });
    expect(db.product.findMany.mock.calls[0][0].where).toEqual({ workspaceId: "ws_a", status: "ACTIVE" });
  });

  it("sends nothing from an address Messenger cannot reach", async () => {
    vi.stubEnv("NEXTAUTH_URL", "http://localhost:3000");
    expect(await sendBotActions(conversation, [{ type: "send_colours", product: "WP-12", colours: [] }])).toEqual({ sent: 0, dropped: 1 });
    expect(send.sendTemplateMessage).not.toHaveBeenCalled();
  });

  it("falls back to single pictures, each after its number, when Meta refuses the template; stops on other errors", async () => {
    send.sendTemplateMessage
      .mockRejectedValueOnce(new FacebookApiError("bad template", "invalid_request"))
      .mockResolvedValue({ messageId: "m_x" });
    const result = await sendBotActions(conversation, [{ type: "send_colours", product: "WP-12", colours: ["12-04", "12-01"] }]);
    expect(result.sent).toBe(2);
    const grey = `https://app.lina.dz/api/public/media/${"G".repeat(32)}`;
    expect(send.sendMessage.mock.calls.map((call) => call[2].text)).toEqual(["12-04 Gris", "12-01 Blanc"]);
    expect(send.sendTemplateMessage.mock.calls[1][2].message).toEqual({ attachment: { type: "image", payload: { url: grey, is_reusable: true } } });
    expect(send.sendMessage.mock.invocationCallOrder[0]).toBeLessThan(send.sendTemplateMessage.mock.invocationCallOrder[1]);
    const rows = db.facebookMessage.create.mock.calls.map((call) => call[0].data);
    expect(rows.map((row) => [row.text, row.attachmentType, row.attachmentUrl])).toEqual([
      ["12-04 Gris · 12-01 Blanc", "template", null],
      ["12-04 Gris", null, null],
      [null, "image", grey],
      ["12-01 Blanc", null, null],
      [null, "image", `https://app.lina.dz/api/public/media/${"B".repeat(32)}`],
    ]);

    vi.clearAllMocks();
    db.facebookMessage.create.mockResolvedValue({ id: "row_z" });
    send.sendTemplateMessage.mockRejectedValue(new FacebookApiError("token", "token_invalid"));
    expect((await sendBotActions(conversation, [{ type: "send_colours", product: "WP-12", colours: [] }])).sent).toBe(0);
    expect(send.sendTemplateMessage).toHaveBeenCalledTimes(1);
    expect(db.facebookMessage.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "row_z", sendStatus: "PENDING" }, data: expect.objectContaining({ sendStatus: "FAILED" }) })
    );
  });

  it("never throws, even when the catalog cannot be read: the reply is already out", async () => {
    db.product.findMany.mockRejectedValue(new Error("connection lost"));
    await expect(sendBotActions(conversation, [{ type: "send_colours", product: "WP-12", colours: [] }])).resolves.toEqual({ sent: 0, dropped: 1 });
    expect(send.sendTemplateMessage).not.toHaveBeenCalled();
  });

  it("does nothing for no actions, and drops what the catalog does not have", async () => {
    expect(await sendBotActions(conversation, [])).toEqual({ sent: 0, dropped: 0 });
    expect(await sendBotActions(conversation, [{ type: "send_colours", product: "Table basse", colours: [] }])).toEqual({ sent: 0, dropped: 1 });
    expect(send.sendTemplateMessage).not.toHaveBeenCalled();
  });
});
