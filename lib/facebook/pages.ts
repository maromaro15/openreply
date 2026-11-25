/**
 * Connecting Facebook Pages with a long-lived access token.
 *
 * A Page token is checked with debug_token before anything is stored: it
 * must be valid, issued by this app (webhooks only reach the app that issued
 * it), carry the five permissions, and not expire within a week. A user
 * token is accepted too, as a convenience: it is swapped for a long-lived
 * one and the user picks among their Pages, whose tokens then never expire.
 *
 * Tokens are stored encrypted and never leave the server.
 */
import { Prisma } from "@/app/generated/prisma/client";
import { prisma } from "@/lib/db/client";
import { decryptToken, encryptToken } from "@/lib/meta/oauth";
import { getBaseUrl } from "@/lib/env";
import {
  PAGE_WEBHOOK_FIELDS,
  REQUIRED_PAGE_PERMISSIONS,
  getFacebookAppId,
  getFacebookAppSecret,
  getFacebookWebhookVerifyToken,
} from "./env";
import {
  FacebookApiError,
  debugToken,
  exchangeForLongLivedUserToken,
  getPage,
  getPageSubscribedApps,
  getUserPages,
  subscribePageWebhooks,
  unsubscribePageWebhooks,
  type DebugTokenData,
} from "./graph";

/** Tokens expiring sooner than this are refused: they would stop within days. */
export const MIN_TOKEN_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;

const TOKEN_FORMAT = /^[A-Za-z0-9_.|-]{20,2048}$/;

export type ConnectErrorCode =
  | "env_missing"
  | "invalid_token_format"
  | "invalid_token"
  | "wrong_app"
  | "unsupported_token_type"
  | "missing_permissions"
  | "short_lived_token"
  | "page_in_other_workspace"
  | "no_pages"
  | "page_not_found_for_user"
  | "graph_error";

export interface ConnectError {
  code: ConnectErrorCode;
  message: string;
  missing?: string[];
  expiresAt?: string;
  pageId?: string;
}

export interface ConnectedPage {
  id: string;
  pageId: string;
  name: string;
  webhookSubscribed: boolean;
  subscribedFields: string[];
  tokenExpiresAt: string | null;
  subscriptionError: string | null;
}

export type ConnectOutcome =
  | { kind: "connected"; pages: ConnectedPage[]; failures: ConnectError[] }
  | { kind: "choose_pages"; pages: { id: string; name: string; pictureUrl: string | null }[] }
  | { kind: "error"; error: ConnectError };

function fail(code: ConnectErrorCode, message: string, extra: Partial<ConnectError> = {}): ConnectOutcome {
  return { kind: "error", error: { code, message, ...extra } };
}

function graphFailure(error: unknown): ConnectOutcome {
  if (error instanceof FacebookApiError && error.kind === "token_invalid") {
    return fail("invalid_token", "The token is not valid. Generate a new one and try again.");
  }
  const message = error instanceof Error ? error.message : "Facebook could not be reached.";
  return fail("graph_error", message);
}

function tokenExpiry(info: DebugTokenData): Date | null {
  return info.expires_at ? new Date(info.expires_at * 1000) : null;
}

/** Variables needed before a token can be checked and stored. */
export function missingConnectEnv(): string[] {
  const missing: string[] = [];
  if (!getFacebookAppId()) missing.push("FACEBOOK_APP_ID");
  if (!getFacebookAppSecret()) missing.push("FACEBOOK_APP_SECRET");
  if (!/^[a-f0-9]{64}$/i.test(process.env.ENCRYPTION_KEY ?? "")) missing.push("ENCRYPTION_KEY");
  return missing;
}

export interface SubscriptionState {
  ok: boolean;
  fields: string[];
  error: string | null;
}

/**
 * Subscribe the app to the Page's webhook fields, then read the subscription
 * back: Meta answers success even when a field the app's own webhook setup
 * lacks was silently left out.
 */
export async function ensurePageSubscription(pageId: string, token: string): Promise<SubscriptionState> {
  try {
    await subscribePageWebhooks(pageId, token, PAGE_WEBHOOK_FIELDS);
    const apps = await getPageSubscribedApps(pageId, token);
    const ours = apps.find((app) => String(app.id) === getFacebookAppId());
    const fields = ours?.subscribed_fields ?? [];
    const missing = PAGE_WEBHOOK_FIELDS.filter((field) => !fields.includes(field));
    return {
      ok: missing.length === 0,
      fields,
      error: missing.length
        ? `The app is not subscribed to: ${missing.join(", ")}. Add these fields to the Page webhook in the Meta app, then subscribe again.`
        : null,
    };
  } catch (error) {
    return {
      ok: false,
      fields: [],
      error: error instanceof Error ? error.message : "Subscription failed",
    };
  }
}

async function connectPage({
  workspaceId,
  pageId,
  token,
  info,
}: {
  workspaceId: string;
  pageId: string;
  token: string;
  info: DebugTokenData;
}): Promise<ConnectedPage | ConnectError> {
  const expiresAt = tokenExpiry(info);
  if (expiresAt && expiresAt.getTime() - Date.now() < MIN_TOKEN_LIFETIME_MS) {
    return {
      code: "short_lived_token",
      message: "This token expires within a week. Use a long-lived Page token.",
      expiresAt: expiresAt.toISOString(),
      pageId,
    };
  }

  const existing = await prisma.facebookPage.findUnique({
    where: { pageId },
    select: { id: true, workspaceId: true },
  });
  if (existing && existing.workspaceId !== workspaceId) {
    return {
      code: "page_in_other_workspace",
      message: "This Page is already connected to another brand.",
      pageId,
    };
  }

  let profile: { id: string; name: string; pictureUrl?: string };
  try {
    profile = await getPage(pageId, token);
  } catch (error) {
    return {
      code: "graph_error",
      message: error instanceof Error ? error.message : "Could not read the Page.",
      pageId,
    };
  }

  const data = {
    name: profile.name,
    pictureUrl: profile.pictureUrl ?? null,
    accessToken: encryptToken(token),
    tokenLast4: token.slice(-4),
    tokenExpiresAt: expiresAt,
    dataAccessExpiresAt: info.data_access_expires_at
      ? new Date(info.data_access_expires_at * 1000)
      : null,
    grantedScopes: info.scopes ?? [],
    status: "ACTIVE" as const,
    lastError: null,
    tokenCheckedAt: new Date(),
  };

  let saved: { id: string };
  if (existing) {
    saved = await prisma.facebookPage.update({ where: { id: existing.id }, data, select: { id: true } });
  } else {
    try {
      saved = await prisma.facebookPage.create({
        data: { workspaceId, pageId, ...data },
        select: { id: true },
      });
    } catch (error) {
      // Another brand connected it between the check and the insert.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        return {
          code: "page_in_other_workspace",
          message: "This Page is already connected to another brand.",
          pageId,
        };
      }
      throw error;
    }
  }

  const subscription = await ensurePageSubscription(pageId, token);
  await prisma.facebookPage.update({
    where: { id: saved.id },
    data: {
      webhookSubscribed: subscription.ok,
      subscribedFields: subscription.fields,
      lastError: subscription.error,
    },
  });

  return {
    id: saved.id,
    pageId,
    name: profile.name,
    webhookSubscribed: subscription.ok,
    subscribedFields: subscription.fields,
    tokenExpiresAt: expiresAt?.toISOString() ?? null,
    subscriptionError: subscription.error,
  };
}

function isConnectError(value: ConnectedPage | ConnectError): value is ConnectError {
  return "code" in value;
}

/**
 * Connect the Page a Page token belongs to, or, for a user token, list the
 * user's Pages (without their tokens) until `pageIds` says which to connect.
 */
export async function connectWithToken({
  workspaceId,
  token,
  pageIds,
}: {
  workspaceId: string;
  token: string;
  pageIds?: string[];
}): Promise<ConnectOutcome> {
  const missingEnv = missingConnectEnv();
  if (missingEnv.length) {
    return fail("env_missing", `Set ${missingEnv.join(", ")} first.`, { missing: missingEnv });
  }

  const cleaned = token.trim();
  if (!TOKEN_FORMAT.test(cleaned)) {
    return fail("invalid_token_format", "That does not look like a Facebook access token.");
  }

  let info: DebugTokenData;
  try {
    info = await debugToken(cleaned);
  } catch (error) {
    return graphFailure(error);
  }

  if (!info.is_valid) {
    return fail("invalid_token", info.error?.message ?? "The token is not valid.");
  }
  if (String(info.app_id ?? "") !== getFacebookAppId()) {
    return fail(
      "wrong_app",
      "This token was issued for another Meta app. Generate it with this app, or webhooks will never arrive."
    );
  }
  const scopes = info.scopes ?? [];
  const missing = REQUIRED_PAGE_PERMISSIONS.filter((scope) => !scopes.includes(scope));
  if (missing.length) {
    return fail("missing_permissions", `Missing permissions: ${missing.join(", ")}`, { missing });
  }

  if (info.type === "PAGE") {
    if (!info.profile_id) return fail("graph_error", "The token does not name its Page.");
    const result = await connectPage({ workspaceId, pageId: info.profile_id, token: cleaned, info });
    return isConnectError(result)
      ? { kind: "error", error: result }
      : { kind: "connected", pages: [result], failures: [] };
  }

  if (info.type !== "USER") {
    return fail("unsupported_token_type", "Use a Page access token, or a user token of a Page admin.");
  }

  let pages;
  try {
    const longLived = await exchangeForLongLivedUserToken(cleaned);
    pages = (await getUserPages(longLived.accessToken)).filter((page) => page.access_token);
  } catch (error) {
    return graphFailure(error);
  }
  if (pages.length === 0) {
    return fail("no_pages", "This account manages no Page this app can use.");
  }

  if (!pageIds || pageIds.length === 0) {
    return {
      kind: "choose_pages",
      pages: pages.map((page) => ({
        id: page.id,
        name: page.name,
        pictureUrl: page.picture?.data?.url ?? null,
      })),
    };
  }

  const wanted = new Set(pageIds);
  const chosen = pages.filter((page) => wanted.has(page.id));
  if (chosen.length !== wanted.size) {
    return fail("page_not_found_for_user", "One of the chosen Pages is not managed by this account.");
  }

  const connected: ConnectedPage[] = [];
  const failures: ConnectError[] = [];
  for (const page of chosen) {
    // Page tokens from a long-lived user token inherit its permissions and
    // do not expire; debug_token confirms it for each one.
    const pageInfo = await debugToken(page.access_token!).catch(() => ({ ...info, expires_at: 0 }));
    const result = await connectPage({
      workspaceId,
      pageId: page.id,
      token: page.access_token!,
      info: pageInfo,
    });
    if (isConnectError(result)) failures.push(result);
    else connected.push(result);
  }
  if (connected.length === 0 && failures.length > 0) return { kind: "error", error: failures[0] };
  return { kind: "connected", pages: connected, failures };
}

/** The Page's decrypted token, for server-side calls only. */
export function pageToken(page: { accessToken: string }): string {
  return decryptToken(page.accessToken);
}

/** Subscribe a connected Page again, e.g. after fixing the app's webhook setup. */
export async function resubscribePage(workspaceId: string, facebookPageId: string) {
  const page = await prisma.facebookPage.findFirst({
    where: { id: facebookPageId, workspaceId, status: { not: "DISCONNECTED" } },
  });
  if (!page) return null;
  const subscription = await ensurePageSubscription(page.pageId, pageToken(page));
  await prisma.facebookPage.update({
    where: { id: page.id },
    data: {
      webhookSubscribed: subscription.ok,
      subscribedFields: subscription.fields,
      lastError: subscription.error,
    },
  });
  return subscription;
}

/**
 * Stop a Page: unsubscribe the app (best effort) and wipe the token. Its
 * campaigns, comment logs and conversations are kept; connecting it again
 * picks them up.
 */
export async function disconnectPage(workspaceId: string, facebookPageId: string): Promise<boolean> {
  const page = await prisma.facebookPage.findFirst({ where: { id: facebookPageId, workspaceId } });
  if (!page) return false;
  if (page.accessToken) {
    try {
      await unsubscribePageWebhooks(page.pageId, pageToken(page));
    } catch {
      // The token may already be dead; disconnecting must still work.
    }
  }
  await prisma.facebookPage.update({
    where: { id: page.id },
    data: {
      status: "DISCONNECTED",
      accessToken: "",
      tokenLast4: null,
      webhookSubscribed: false,
      subscribedFields: [],
    },
  });
  return true;
}

/**
 * Remove a disconnected Page and everything recorded for it (campaigns,
 * comment logs, conversations), so it can be connected to another brand.
 */
export async function deleteDisconnectedPage(workspaceId: string, facebookPageId: string) {
  const result = await prisma.facebookPage.deleteMany({
    where: { id: facebookPageId, workspaceId, status: "DISCONNECTED" },
  });
  return result.count === 1;
}

export async function setPageBotEnabled(workspaceId: string, facebookPageId: string, enabled: boolean) {
  const result = await prisma.facebookPage.updateMany({
    where: { id: facebookPageId, workspaceId, status: { not: "DISCONNECTED" } },
    data: { botEnabled: enabled },
  });
  return result.count === 1;
}

/** Pages of a workspace for the UI: everything except the token. */
export async function listWorkspacePages(workspaceId: string) {
  return prisma.facebookPage.findMany({
    where: { workspaceId },
    orderBy: [{ status: "asc" }, { connectedAt: "asc" }],
    select: {
      id: true,
      pageId: true,
      name: true,
      pictureUrl: true,
      status: true,
      tokenLast4: true,
      tokenExpiresAt: true,
      dataAccessExpiresAt: true,
      grantedScopes: true,
      subscribedFields: true,
      webhookSubscribed: true,
      botEnabled: true,
      lastError: true,
      lastWebhookAt: true,
      tokenCheckedAt: true,
      connectedAt: true,
    },
  });
}

/** What the Meta app's Page webhook must be set to. */
export function webhookSetup() {
  return {
    callbackUrl: `${getBaseUrl().replace(/\/$/, "")}/api/facebook/webhook`,
    verifyTokenConfigured: Boolean(getFacebookWebhookVerifyToken()),
    fields: [...PAGE_WEBHOOK_FIELDS],
    permissions: [...REQUIRED_PAGE_PERMISSIONS],
    missingEnv: missingConnectEnv(),
  };
}
