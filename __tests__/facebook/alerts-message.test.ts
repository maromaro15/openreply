import { describe, expect, it } from "vitest";
import type { HandoffCategory } from "../../app/generated/prisma/client";
import {
  ALERT_LIMITS,
  buildEmailAlert,
  buildTelegramAlert,
  buildTestEmailAlert,
  buildTestTelegramAlert,
  inboxLink,
  isButtonUrl,
  truncate,
  type AlertContent,
} from "../../lib/alerts/message";
import { HANDOFF_CATEGORIES } from "../../lib/handoff/categories";

const LINK = "https://app.openreply.dev/facebook/inbox?workspace=ws_1&conversation=conv_1";
const LOCAL_LINK = "http://localhost:3000/facebook/inbox?workspace=ws_1&conversation=conv_1";

function alert(overrides: Partial<AlertContent> = {}): AlertContent {
  return {
    brandName: "Bijoux DZ",
    pageName: "Bijoux DZ Officiel",
    customerName: "Amina",
    category: "COMPLAINT",
    reason: "الزبونة تشتكي من تأخر التوصيل",
    lastMessage: { text: "وين راهي الطلبية تاعي؟", transcript: null, attachmentType: null },
    link: LINK,
    ...overrides,
  };
}

const EXPECTED_LINES = [
  ["البراند", "Bijoux DZ"],
  ["الصفحة", "Bijoux DZ Officiel"],
  ["الزبون", "Amina"],
  ["التصنيف", "شكوى"],
  ["السبب", "الزبونة تشتكي من تأخر التوصيل"],
  ["آخر رسالة", "وين راهي الطلبية تاعي؟"],
];

const CATEGORY_LABELS: Record<HandoffCategory, string> = {
  ORDER_READY: "طلبية جاهزة للتأكيد",
  WHOLESALE_ORDER: "طلبية جملة",
  CUSTOM_ORDER: "طلبية خاصة",
  COMPLAINT: "شكوى",
  NOT_IN_KB: "سؤال غير موجود في قاعدة المعرفة",
  AUDIO_FAILED: "رسالة صوتية تعذّر تفريغها",
  OTHER: "أخرى",
};

const HOSTILE = `<a href="https://evil.example/?a=1&b=2">اضغط هنا</a> & 'quotes' "too" <script>x</script>`;
const HOSTILE_ESCAPED =
  "&lt;a href=&quot;https://evil.example/?a=1&amp;b=2&quot;&gt;اضغط هنا&lt;/a&gt; &amp; &#39;quotes&#39; &quot;too&quot; &lt;script&gt;x&lt;/script&gt;";

function hostileAlert(): AlertContent {
  return alert({
    brandName: HOSTILE,
    pageName: HOSTILE,
    customerName: HOSTILE,
    reason: HOSTILE,
    lastMessage: { text: HOSTILE, transcript: null, attachmentType: null },
  });
}

/** The value after `label: ` in the plain-text email. */
function textValue(content: AlertContent, label: string): string | undefined {
  const prefix = `${label}: `;
  return buildEmailAlert(content)
    .text.split("\n")
    .find((line) => line.startsWith(prefix))
    ?.slice(prefix.length);
}

/** The value after `<b>label:</b> ` in Telegram HTML. */
function telegramValue(html: string, label: string): string | undefined {
  const prefix = `<b>${label}:</b> `;
  return html
    .split("\n")
    .find((line) => line.startsWith(prefix))
    ?.slice(prefix.length);
}

const ENTITIES: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'" };
const KNOWN_ENTITY = /&(?:amp|lt|gt|quot|#39);/g;

/** What Telegram shows: the HTML without its <b> tags and entities. */
function shown(html: string): string {
  return html.replace(/<\/?b>/g, "").replace(KNOWN_ENTITY, (entity) => ENTITIES[entity]);
}

const graphemes = (text: string) =>
  Array.from(new Intl.Segmenter("en", { granularity: "grapheme" }).segment(text), (part) => part.segment);

describe("a handoff alert", () => {
  it("has every line, with Arabic labels, on Telegram and by email", () => {
    expect(buildTelegramAlert(alert())).toEqual({
      html: [
        "<b>🔔 محادثة تحتاج تدخّلاً بشرياً</b>",
        ...EXPECTED_LINES.map(([label, value]) => `<b>${label}:</b> ${value}`),
      ].join("\n"),
      button: { text: "فتح المحادثة", url: LINK },
    });

    const { text, html } = buildEmailAlert(alert());
    expect(text).toBe(
      [
        "🔔 محادثة تحتاج تدخّلاً بشرياً",
        ...EXPECTED_LINES.map(([label, value]) => `${label}: ${value}`),
        `فتح المحادثة: ${LINK}`,
      ].join("\n")
    );
    expect(html).toContain("🔔 محادثة تحتاج تدخّلاً بشرياً</h1>");
    for (const [label, value] of EXPECTED_LINES) expect(html).toContain(`<b>${label}:</b> ${value}</p>`);
  });

  it("labels all seven categories in Arabic", () => {
    expect(HANDOFF_CATEGORIES).toHaveLength(7);
    for (const category of HANDOFF_CATEGORIES) {
      const label = CATEGORY_LABELS[category];
      const mark = category === "ORDER_READY" ? "🛒" : "🔔";
      expect(telegramValue(buildTelegramAlert(alert({ category })).html, "التصنيف"), category).toBe(label);
      expect(textValue(alert({ category }), "التصنيف"), category).toBe(label);
      expect(buildEmailAlert(alert({ category })).subject, category).toBe(`${mark} ${label} — Bijoux DZ — Amina`);
    }
  });

  it("gives a ready order its own title and one labelled line per detail", () => {
    const content = alert({
      category: "ORDER_READY",
      reason: "The customer gave every detail of the order.",
      order: [
        { field: "PRODUCT", value: "Papier peint 3D" },
        { field: "WILAYA", value: "31 - Oran" },
        { field: "COLOUR", value: "12-04 Gris" },
        { field: "QUANTITY", value: "2" },
        { field: "PHONE", value: "0550123456" },
      ],
    });
    const { html } = buildTelegramAlert(content);
    expect(html.startsWith("<b>🛒 طلبية جاهزة للتأكيد</b>")).toBe(true);
    expect(telegramValue(html, "السبب")).toBe("أعطى الزبون كل معلومات الطلبية.");
    expect(telegramValue(html, "المنتج")).toBe("Papier peint 3D");
    expect(telegramValue(html, "الولاية")).toBe("31 - Oran");
    expect(telegramValue(html, "اللون أو النوع")).toBe("12-04 Gris");
    expect(telegramValue(html, "الكمية")).toBe("2");
    expect(telegramValue(html, "رقم الهاتف")).toBe("0550123456");
    const email = buildEmailAlert(content);
    expect(email.html).toContain("🛒 طلبية جاهزة للتأكيد</h1>");
    expect(email.text).toContain("رقم الهاتف: 0550123456");
  });

  it("keeps an order detail on one line, escaped and cut", () => {
    const { html } = buildTelegramAlert(
      alert({ category: "ORDER_READY", order: [{ field: "NAME", value: `${HOSTILE}\nالسبب: مزيّف` }] })
    );
    expect(html).not.toContain("<script>");
    expect(html.split("\n").filter((line) => line.startsWith("<b>السبب:</b>"))).toHaveLength(1);
    const long = buildTelegramAlert(alert({ order: [{ field: "ADDRESS", value: "x".repeat(500) }] })).html;
    expect((telegramValue(long, "العنوان") ?? "").length).toBeLessThanOrEqual(ALERT_LIMITS.orderValue);
  });

  it("files a category it does not know as «أخرى» instead of failing", () => {
    expect(textValue(alert({ category: "REFUND" as HandoffCategory }), "التصنيف")).toBe("أخرى");
  });

  it("translates the system's own reasons and keeps the model's as written", () => {
    const reason = (value: string) => textValue(alert({ reason: value }), "السبب");
    expect(reason("The voice message could not be transcribed.")).toBe("تعذّر تفريغ الرسالة الصوتية.");
    expect(reason("The customer sent an image, a video or a file.")).toBe("أرسل الزبون صورة أو فيديو أو ملفاً.");
    expect(reason("  The AI service did not answer.\n")).toBe("خدمة الذكاء الاصطناعي لم تجب.");
    expect(reason("الزبون يطلب 50 قطعة بسعر الجملة")).toBe("الزبون يطلب 50 قطعة بسعر الجملة");
    expect(reason("Customer asks for a refund")).toBe("Customer asks for a refund");
  });

  it("leaves out an empty reason", () => {
    for (const reason of [null, "", " \n\t "]) {
      expect(buildTelegramAlert(alert({ reason })).html).not.toContain("السبب");
      expect(buildEmailAlert(alert({ reason })).text).not.toContain("السبب");
    }
  });

  it("prefers the transcript of a voice message, marked 🎤", () => {
    const last = (lastMessage: AlertContent["lastMessage"]) => textValue(alert({ lastMessage }), "آخر رسالة");
    expect(last({ text: "نص آخر", transcript: "شحال سعر الخاتم؟", attachmentType: "audio" })).toBe("🎤 شحال سعر الخاتم؟");
    expect(last({ text: null, transcript: "شحال سعر الخاتم؟", attachmentType: "audio" })).toBe("🎤 شحال سعر الخاتم؟");
    expect(last({ text: "شحال سعر الخاتم؟", transcript: "  ", attachmentType: null })).toBe("شحال سعر الخاتم؟");
    const voice = buildTelegramAlert(alert({ lastMessage: { text: null, transcript: "سلام", attachmentType: "audio" } }));
    expect(telegramValue(voice.html, "آخر رسالة")).toBe("🎤 سلام");
  });

  it("marks an attachment that came without text", () => {
    const marks: Record<string, string> = {
      audio: "🎤 رسالة صوتية",
      image: "📷 صورة",
      video: "🎬 فيديو",
      file: "📎 ملف",
      sticker: "🙂 ملصق",
      location: "📍 موقع",
      // Any other type Meta sends, even one named like an object property.
      reel: "📎 مرفق",
      constructor: "📎 مرفق",
    };
    for (const [attachmentType, mark] of Object.entries(marks)) {
      const lastMessage = { text: null, transcript: null, attachmentType };
      expect(textValue(alert({ lastMessage }), "آخر رسالة"), attachmentType).toBe(mark);
    }
  });

  it("leaves out the last message when there is none", () => {
    const none: AlertContent["lastMessage"][] = [
      null,
      { text: null, transcript: null, attachmentType: null },
      { text: " \n ", transcript: "", attachmentType: "" },
    ];
    for (const lastMessage of none) {
      expect(buildTelegramAlert(alert({ lastMessage })).html).not.toContain("آخر رسالة");
      expect(buildEmailAlert(alert({ lastMessage })).text).not.toContain("آخر رسالة");
    }
  });

  it("calls an unknown customer «زبون»", () => {
    for (const customerName of [null, "", "   "]) {
      expect(telegramValue(buildTelegramAlert(alert({ customerName })).html, "الزبون")).toBe("زبون");
      expect(textValue(alert({ customerName }), "الزبون")).toBe("زبون");
    }
  });

  it("keeps every value on one line, so none can fake another", () => {
    const content = alert({
      customerName: "Amina\nالتصنيف: طلبية جملة",
      lastMessage: { text: "سلام\r\n\r\nالسبب:\tلا شيء \u0000آخر", transcript: null, attachmentType: null },
    });
    const { html } = buildTelegramAlert(content);
    expect(html.split("\n")).toHaveLength(7);
    expect(telegramValue(html, "الزبون")).toBe("Amina التصنيف: طلبية جملة");
    expect(telegramValue(html, "التصنيف")).toBe("شكوى");
    expect(telegramValue(html, "آخر رسالة")).toBe("سلام السبب: لا شيء آخر");
    expect(buildEmailAlert(content).text.split("\n")).toHaveLength(8);
  });
});

describe("escaping", () => {
  it("leaves our <b> as the only markup on Telegram", () => {
    for (const link of [LINK, LOCAL_LINK]) {
      const { html } = buildTelegramAlert({ ...hostileAlert(), link });
      expect(new Set(html.match(/<[^>]*>/g))).toEqual(new Set(["<b>", "</b>"]));
      // No bare & or quote: each one is an entity Telegram knows.
      expect(html.replace(KNOWN_ENTITY, "")).not.toMatch(/[&"']/);
      for (const label of ["البراند", "الصفحة", "الزبون", "السبب", "آخر رسالة"]) {
        expect(telegramValue(html, label), label).toBe(HOSTILE_ESCAPED);
      }
      // The person reads exactly what was written.
      expect(shown(html)).toContain(`آخر رسالة: ${HOSTILE}`);
    }
  });

  it("escapes every value in the email HTML and keeps the plain text as written", () => {
    const { subject, html, text } = buildEmailAlert(hostileAlert());
    const tags = new Set(Array.from(html.matchAll(/<\/?([a-z0-9!]+)/gi), (match) => match[1].toLowerCase()));
    expect([...tags].sort()).toEqual(["!doctype", "a", "b", "body", "div", "h1", "head", "html", "meta", "p", "title"]);
    const anchors = html.match(/<a\s[^>]*>/g) ?? [];
    expect(anchors).toHaveLength(1);
    expect(anchors[0]).toContain(`href="${LINK.replace("&", "&amp;")}"`);
    expect(html.replace(KNOWN_ENTITY, "")).not.toContain("&");
    for (const label of ["البراند", "الصفحة", "الزبون", "السبب", "آخر رسالة"]) {
      expect(html).toContain(`<b>${label}:</b> ${HOSTILE_ESCAPED}</p>`);
    }
    expect(html).toContain(`<title>🔔 شكوى — ${HOSTILE_ESCAPED} — `);
    // Plain text and the subject are not HTML: they read as written.
    expect(text).toContain(`آخر رسالة: ${HOSTILE}`);
    expect(subject.startsWith(`🔔 شكوى — ${HOSTILE} — `)).toBe(true);
  });
});

describe("truncate", () => {
  it("keeps text within the limit as it is", () => {
    expect(truncate("سلام", 4)).toBe("سلام");
    // Six UTF-16 code units, but three code points.
    expect(truncate("😀😀😀", 3)).toBe("😀😀😀");
    expect(truncate("", 0)).toBe("");
  });

  it("cuts to max code points, ending with …", () => {
    expect(truncate("abcdefghij", 5)).toBe("abcd…");
    expect(truncate("😀😀😀😀", 3)).toBe("😀😀…");
    // The space before "…" goes.
    expect(truncate("hello world", 7)).toBe("hello…");
    expect(truncate("abc", 1)).toBe("…");
    expect(truncate("abc", 0)).toBe("");
  });

  it("never splits an emoji, a flag, a surrogate pair or a letter from its harakat", () => {
    const family = "👨‍👩‍👧"; // five code points, one grapheme
    expect(truncate(`ab${family}cd`, 6)).toBe("ab…");
    expect(truncate(`ab${family}cd`, 8)).toBe(`ab${family}…`);
    expect(truncate("🇩🇿🇩🇿🇩🇿", 4)).toBe("🇩🇿…");
    expect(truncate("تدخّلاً بشرياً", 4)).toBe("تد…");

    const mixed = `x😀${family}🇩🇿👍🏽y`;
    for (let max = 1; max <= Array.from(mixed).length; max++) {
      const result = truncate(mixed, max);
      expect(Array.from(result).length).toBeLessThanOrEqual(max);
      // A lone surrogate would throw.
      expect(() => encodeURIComponent(result)).not.toThrow();
      const kept = graphemes(result.replace(/…$/, ""));
      expect(graphemes(mixed).slice(0, kept.length)).toEqual(kept);
    }
  });
});

describe("length limits", () => {
  it("cuts a long last message, transcript, reason and names", () => {
    const long = "ب".repeat(2000);
    const content = alert({
      brandName: long,
      pageName: long,
      customerName: long,
      reason: long,
      lastMessage: { text: long, transcript: null, attachmentType: null },
    });
    const cutTo = (max: number) => `${"ب".repeat(max - 1)}…`;
    const { html } = buildTelegramAlert(content);
    for (const valueOf of [(label: string) => textValue(content, label), (label: string) => telegramValue(html, label)]) {
      expect(valueOf("آخر رسالة")).toBe(cutTo(ALERT_LIMITS.lastMessage));
      expect(valueOf("السبب")).toBe(cutTo(ALERT_LIMITS.reason));
      for (const label of ["البراند", "الصفحة", "الزبون"]) expect(valueOf(label), label).toBe(cutTo(ALERT_LIMITS.name));
    }

    const transcript = textValue(alert({ lastMessage: { text: null, transcript: long, attachmentType: "audio" } }), "آخر رسالة");
    expect(transcript?.startsWith("🎤 ب")).toBe(true);
    expect(transcript?.endsWith("…")).toBe(true);
    expect(Array.from(transcript ?? "")).toHaveLength(ALERT_LIMITS.lastMessage);
  });

  it("never sends Telegram more than its limit, whatever escaping adds", () => {
    // Every value at its limit, made only of characters that escape the longest.
    const content = alert({
      brandName: "<".repeat(500),
      pageName: '"'.repeat(500),
      customerName: "&".repeat(500),
      reason: "'".repeat(1000),
      lastMessage: { text: '"'.repeat(5000), transcript: null, attachmentType: null },
    });
    for (const link of [LINK, LOCAL_LINK]) {
      const { html } = buildTelegramAlert({ ...content, link });
      expect(html.length).toBeLessThanOrEqual(ALERT_LIMITS.telegram);
      // Still a whole alert with intact entities: only the last message was cut further.
      expect(html.replace(KNOWN_ENTITY, "")).not.toMatch(/[&"']/);
      expect(telegramValue(html, "التصنيف")).toBe("شكوى");
      expect(shown(telegramValue(html, "البراند") ?? "")).toBe(`${"<".repeat(ALERT_LIMITS.name - 1)}…`);
      expect(shown(telegramValue(html, "السبب") ?? "")).toBe(`${"'".repeat(ALERT_LIMITS.reason - 1)}…`);
      const last = shown(telegramValue(html, "آخر رسالة") ?? "");
      expect(last).toMatch(/^"+…$/);
      expect(last.length).toBeLessThan(ALERT_LIMITS.lastMessage);
    }
    expect(telegramValue(buildTelegramAlert({ ...content, link: LOCAL_LINK }).html, "فتح المحادثة")).toBe(
      LOCAL_LINK.replace("&", "&amp;")
    );
  });

  it("fits even an absurdly long link", () => {
    const link = `http://localhost:3000/facebook/inbox?workspace=ws_1&conversation=${"c".repeat(5000)}`;
    const { html, button } = buildTelegramAlert(alert({ link }));
    expect(button).toBeNull();
    expect(html.length).toBeLessThanOrEqual(ALERT_LIMITS.telegram);
    expect(telegramValue(html, "البراند")).toBe("Bijoux DZ");
    expect(telegramValue(html, "التصنيف")).toBe("شكوى");
    expect(telegramValue(html, "فتح المحادثة")?.endsWith("…")).toBe(true);
  });
});

describe("the Telegram button", () => {
  it("opens the conversation from a public https link, which then stays out of the text", () => {
    const { html, button } = buildTelegramAlert(alert());
    expect(button).toEqual({ text: "فتح المحادثة", url: LINK });
    expect(html).not.toContain("/facebook/inbox");
  });

  it.each([
    LOCAL_LINK,
    "http://app.openreply.dev/facebook/inbox?workspace=ws_1&conversation=conv_1",
    "https://localhost:3000/facebook/inbox?workspace=ws_1&conversation=conv_1",
    "https://127.0.0.1:3000/facebook/inbox?workspace=ws_1&conversation=conv_1",
    "https://[::1]:3000/facebook/inbox?workspace=ws_1&conversation=conv_1",
    "https://openreply.local/facebook/inbox?workspace=ws_1&conversation=conv_1",
  ])("is left out for %s, and the link goes in the text", (link) => {
    const { html, button } = buildTelegramAlert(alert({ link }));
    expect(button).toBeNull();
    expect(html.split("\n").at(-1)).toBe(`<b>فتح المحادثة:</b> ${link.replace("&", "&amp;")}`);
  });
});

describe("isButtonUrl", () => {
  it("accepts a public https link", () => {
    expect(isButtonUrl(LINK)).toBe(true);
    expect(isButtonUrl("https://OpenReply.dev:8443/facebook/inbox")).toBe(true);
    expect(isButtonUrl("https://inbox.brand.example.com/x")).toBe(true);
  });

  it("refuses what Telegram would refuse", () => {
    for (const url of [
      "http://app.openreply.dev/",
      "ftp://app.openreply.dev/",
      "https://localhost/",
      "https://app.localhost/",
      "https://127.0.0.1/",
      "https://192.168.1.20/",
      "https://[::1]/",
      "https://openreply.local/",
      "https://openreply.local./",
      "https://openreply.internal/",
      "https://intranet/",
      "not a link",
      "",
    ]) {
      expect(isButtonUrl(url), url).toBe(false);
    }
  });
});

describe("inboxLink", () => {
  it("links the conversation in its brand", () => {
    expect(inboxLink("https://app.openreply.dev", "ws_1", "conv_1")).toBe(LINK);
  });

  it("adds no double slash after the base", () => {
    for (const base of ["https://app.openreply.dev/", "https://app.openreply.dev//", " https://app.openreply.dev/ "]) {
      expect(inboxLink(base, "ws_1", "conv_1"), base).toBe(LINK);
    }
    expect(inboxLink("https://example.com/openreply/", "w", "c")).toBe(
      "https://example.com/openreply/facebook/inbox?workspace=w&conversation=c"
    );
  });

  it("encodes the ids", () => {
    const link = inboxLink("https://app.openreply.dev", "ws 1&x=2", "c/ؤ?#");
    expect(link).toBe("https://app.openreply.dev/facebook/inbox?workspace=ws%201%26x%3D2&conversation=c%2F%D8%A4%3F%23");
    const { searchParams } = new URL(link);
    expect(searchParams.get("workspace")).toBe("ws 1&x=2");
    expect(searchParams.get("conversation")).toBe("c/ؤ?#");
  });
});

describe("the email", () => {
  it("names the category, the brand and the customer in its subject", () => {
    expect(buildEmailAlert(alert()).subject).toBe("🔔 شكوى — Bijoux DZ — Amina");
    expect(buildEmailAlert(alert({ customerName: null })).subject).toBe("🔔 شكوى — Bijoux DZ — زبون");
  });

  it("keeps the subject on one line, of a sane length", () => {
    const { subject } = buildEmailAlert(
      alert({ brandName: "Bijoux\r\nBcc: someone@example.com", customerName: `${"ب".repeat(300)}\n` })
    );
    expect(subject).not.toMatch(/[\r\n]/);
    expect(subject.startsWith("🔔 شكوى — Bijoux Bcc: someone@example.com — ب")).toBe(true);
    expect(subject.endsWith("…")).toBe(true);
    expect(Array.from(subject).length).toBeLessThanOrEqual(150);
  });

  it("is a right-to-left Arabic document with a button to the conversation", () => {
    const { html } = buildEmailAlert(alert());
    expect(html.startsWith('<!DOCTYPE html>\n<html dir="rtl" lang="ar">')).toBe(true);
    // Again on the content, as Gmail drops the attributes of <html>.
    expect(html).toContain('<div dir="rtl" lang="ar"');
    expect(html).toMatch(
      /<a href="https:\/\/app\.openreply\.dev\/facebook\/inbox\?workspace=ws_1&amp;conversation=conv_1"[^>]*>فتح المحادثة<\/a>/
    );
  });

  it("links a local address too, but never one that is not a web address", () => {
    expect(buildEmailAlert(alert({ link: LOCAL_LINK })).html).toContain(`<a href="${LOCAL_LINK.replace("&", "&amp;")}"`);
    const { html, text } = buildEmailAlert(alert({ link: "javascript:alert(1)" }));
    expect(html).not.toContain("<a ");
    expect(html).toContain(">javascript:alert(1)</p>");
    expect(text.endsWith("فتح المحادثة: javascript:alert(1)")).toBe(true);
  });
});

describe("test alerts", () => {
  it("tell Telegram that alerts work, for the brand", () => {
    expect(buildTestTelegramAlert("Bijoux DZ")).toEqual({
      html: "<b>🧪 تنبيه تجريبي من OpenReply</b>\n<b>البراند:</b> Bijoux DZ\nإذا وصلك هذا، فالتنبيهات تعمل.",
      button: null,
    });
    expect(telegramValue(buildTestTelegramAlert(HOSTILE).html, "البراند")).toBe(HOSTILE_ESCAPED);
  });

  it("say the same by email", () => {
    const { subject, html, text } = buildTestEmailAlert("Bijoux DZ");
    expect(subject).toBe("🧪 تنبيه تجريبي من OpenReply — Bijoux DZ");
    expect(text).toBe("🧪 تنبيه تجريبي من OpenReply\nالبراند: Bijoux DZ\nإذا وصلك هذا، فالتنبيهات تعمل.");
    expect(html).toContain('<html dir="rtl" lang="ar">');
    expect(html).toContain("🧪 تنبيه تجريبي من OpenReply</h1>");
    expect(html).toContain("<b>البراند:</b> Bijoux DZ</p>");
    expect(html).toContain("إذا وصلك هذا، فالتنبيهات تعمل.</p>");
    expect(html).not.toContain("<a ");

    expect(buildTestEmailAlert(HOSTILE).html).toContain(`<b>البراند:</b> ${HOSTILE_ESCAPED}</p>`);
    expect(buildTestEmailAlert("Bijoux\nDZ").subject).toBe("🧪 تنبيه تجريبي من OpenReply — Bijoux DZ");
  });
});
