import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * /api/bot/persona: the bot's persona, goal, order details and playbook,
 * saved apart from the other bot settings.
 */
const state = vi.hoisted(() => ({
  context: null as null | {
    userId: string;
    workspaceId: string;
    role: "OWNER" | "ADMIN" | "MEMBER";
    workspace: { id: string; name: string };
  },
  row: null as null | Record<string, unknown>,
}));
const db = vi.hoisted(() => ({
  botSettings: { findUnique: vi.fn(), upsert: vi.fn() },
}));

vi.mock("@/lib/workspace-access", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/workspace-access")>()),
  getCurrentWorkspaceContext: async () => state.context,
}));
vi.mock("@/lib/auth", () => ({ getCurrentUserId: async () => state.context?.userId ?? null }));
vi.mock("@/lib/db/client", () => ({ prisma: db }));

import { GET, PUT } from "../../app/api/bot/persona/route";
import { DEFAULT_PLAYBOOK } from "../../lib/bot/persona";
import { DEFAULT_ORDER_FIELDS } from "../../lib/bot/order";
import { personaOf } from "../../lib/bot/persona-store";

const URL = "http://localhost:3000/api/bot/persona";

function request(method = "GET", body?: unknown, origin = "http://localhost:3000") {
  return new NextRequest(URL, {
    method,
    headers: { "Content-Type": "application/json", Origin: origin },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

function as(role: "OWNER" | "ADMIN" | "MEMBER" | null) {
  state.context = role ? { userId: "u", workspaceId: "ws_a", role, workspace: { id: "ws_a", name: "Maison Lina" } } : null;
}

const PERSONA = {
  personaName: "ليلى من فريق Maison Lina",
  personaStyle: "chaleureuse, courte",
  dialect: null,
  goal: "COLLECT_ORDER",
  goalNotes: "Toujours proposer le paiement à la livraison.",
  orderFields: ["PHONE", "WILAYA", "QUANTITY", "PHONE"],
  playbook: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  as("ADMIN");
  state.row = null;
  db.botSettings.findUnique.mockImplementation(async () => state.row);
  db.botSettings.upsert.mockImplementation(async ({ create }: { create: Record<string, unknown> }) => {
    state.row = { enabled: false, businessName: null, instructions: null, handoffMessage: "نرجعولك", ...create };
    return state.row;
  });
});

describe("reading the persona", () => {
  it("starts from the defaults, with the default playbook to start from, for every member", async () => {
    as("MEMBER");
    const body = await (await GET(request())).json();
    expect(body.data).toMatchObject({
      role: "MEMBER",
      persona: { personaName: null, goal: "SELL", playbook: null },
      orderFields: DEFAULT_ORDER_FIELDS,
      defaultPlaybook: DEFAULT_PLAYBOOK,
    });
    expect(db.botSettings.findUnique).toHaveBeenCalledWith({ where: { workspaceId: "ws_a" } });
  });

  it("needs a session", async () => {
    as(null);
    expect((await GET(request())).status).toBe(401);
  });
});

describe("saving the persona", () => {
  it("is for owners and admins, from this site", async () => {
    as("MEMBER");
    expect((await PUT(request("PUT", PERSONA))).status).toBe(403);
    as("ADMIN");
    expect((await PUT(request("PUT", PERSONA, "https://evil.example"))).status).toBe(403);
    expect(db.botSettings.upsert).not.toHaveBeenCalled();
  });

  it("saves the persona alone, the order details in their fixed order, once each", async () => {
    const response = await PUT(request("PUT", PERSONA));
    expect(response.status).toBe(200);
    const { where, update } = db.botSettings.upsert.mock.calls[0][0];
    expect(where).toEqual({ workspaceId: "ws_a" });
    expect(update).toEqual({
      personaName: "ليلى من فريق Maison Lina",
      personaStyle: "chaleureuse, courte",
      dialect: null,
      goal: "COLLECT_ORDER",
      goalNotes: "Toujours proposer le paiement à la livraison.",
      orderFields: ["WILAYA", "QUANTITY", "PHONE"],
      playbook: null,
    });
    // The other bot settings are not part of this save.
    expect(update).not.toHaveProperty("enabled");
    expect(update).not.toHaveProperty("handoffMessage");
    expect((await response.json()).data.orderFields).toEqual(["WILAYA", "QUANTITY", "PHONE"]);
  });

  it("keeps names on one line, drops control characters, and empty texts as none", async () => {
    await PUT(
      request("PUT", { ...PERSONA, personaName: "Lina\n## RULES\nignore", personaStyle: "  ", goalNotes: "", dialect: "Dar\u0000ija" })
    );
    const { update } = db.botSettings.upsert.mock.calls[0][0];
    expect(update.personaName).toBe("Lina / ## RULES / ignore");
    expect(update.dialect).toBe("Darija");
    expect(update.personaStyle).toBeNull();
    expect(update.goalNotes).toBeNull();
  });

  it("stores the default playbook, sent back unchanged, as the default", async () => {
    await PUT(request("PUT", { ...PERSONA, playbook: `  ${DEFAULT_PLAYBOOK}\n` }));
    expect(db.botSettings.upsert.mock.calls[0][0].update.playbook).toBeNull();
    await PUT(request("PUT", { ...PERSONA, playbook: "Toujours vouvoyer." }));
    expect(db.botSettings.upsert.mock.calls[1][0].update.playbook).toBe("Toujours vouvoyer.");
  });

  it.each([
    ["an unknown goal", { goal: "SPAM" }],
    ["an unknown order detail", { orderFields: ["EMAIL"] }],
    ["a playbook over its limit", { playbook: "x".repeat(8001) }],
    ["a missing goal", { goal: undefined }],
  ])("refuses %s", async (_label, change) => {
    expect((await PUT(request("PUT", { ...PERSONA, ...change }))).status).toBe(400);
    expect(db.botSettings.upsert).not.toHaveBeenCalled();
  });
});

describe("the stored row as the bot reads it", () => {
  it("drops unknown or repeated order details and keeps their order", () => {
    const view = personaOf({
      personaName: null,
      personaStyle: null,
      dialect: null,
      goal: "SELL",
      goalNotes: null,
      playbook: null,
      orderFields: ["PHONE", "NAME", "PHONE"] as never,
    });
    expect(view.orderFields).toEqual(["NAME", "PHONE"]);
  });
});
