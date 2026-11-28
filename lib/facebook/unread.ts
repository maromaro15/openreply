"use client";

/**
 * The live count of unread conversations, for the menu badge and the tab
 * title. Polled, like the inbox: every 10 s while the tab is visible, every
 * minute behind another tab, so the title still shows new messages there.
 */
import { useEffect, useState } from "react";

const POLL_MS = 10_000;
const HIDDEN_POLL_MS = 60_000;
const CHANGED_EVENT = "openreply:unread-changed";

/** Tells the badge to count again now, e.g. once a conversation is marked read. */
export function notifyUnreadChanged(): void {
  window.dispatchEvent(new Event(CHANGED_EVENT));
}

export function useUnreadCount(): number {
  const [count, setCount] = useState(0);
  useEffect(() => {
    let cancelled = false;
    let last = 0;
    const load = (force = false) => {
      if (!force && document.hidden && Date.now() - last < HIDDEN_POLL_MS) return;
      last = Date.now();
      fetch("/api/facebook/conversations/unread", { cache: "no-store" })
        .then((response) => response.json())
        .then((payload) => {
          if (!cancelled && payload?.success) setCount(payload.data.count);
        })
        .catch(() => {});
    };
    const now = () => load(true);
    const onVisible = () => {
      if (!document.hidden) now();
    };
    now();
    const timer = window.setInterval(load, POLL_MS);
    window.addEventListener(CHANGED_EVENT, now);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      window.removeEventListener(CHANGED_EVENT, now);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);
  return count;
}

const COUNT_PREFIX = /^\(\d+\) /;

/** "(3) Amitec Reply": the title with the count in front, or without it at 0. */
export function titleWithUnread(title: string, count: number): string {
  const base = title.replace(COUNT_PREFIX, "");
  return count > 0 ? `(${count}) ${base}` : base;
}

/** Keeps the count in the tab title, also after Next.js sets a page's title. */
export function useUnreadTitle(count: number): void {
  useEffect(() => {
    const apply = () => {
      const next = titleWithUnread(document.title, count);
      if (document.title !== next) document.title = next;
    };
    apply();
    const observer = new MutationObserver(apply);
    observer.observe(document.head, { childList: true, subtree: true, characterData: true });
    return () => observer.disconnect();
  }, [count]);
}
