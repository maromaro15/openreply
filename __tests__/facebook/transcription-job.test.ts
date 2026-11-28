import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Job } from "bullmq";

const db = vi.hoisted(() => ({
  facebookMessage: { findUnique: vi.fn(), updateMany: vi.fn() },
  facebookConversation: { updateMany: vi.fn() },
}));
const transcribe = vi.hoisted(() => ({ transcribeAudioUrl: vi.fn() }));

vi.mock("@/lib/db/client", () => ({ prisma: db }));
vi.mock("@/lib/ai/transcribe", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/ai/transcribe")>()),
  ...transcribe,
}));

import { processTranscribeJob } from "../../lib/facebook/transcription";
import { TranscriptionError } from "../../lib/ai/transcribe";
import { dispatchFacebookJob } from "../../lib/facebook/worker";
import type { FacebookTranscribeJob } from "../../lib/facebook/queue";

const SENT_AT = new Date("2026-11-25T11:59:00Z");

function job() {
  return { id: "fbt_msg_v", name: "fb-transcribe", data: { messageId: "msg_v" } } as unknown as Job<FacebookTranscribeJob>;
}

beforeEach(() => {
  vi.clearAllMocks();
  db.facebookMessage.findUnique.mockResolvedValue({
    id: "msg_v",
    conversationId: "conv_1",
    attachmentType: "audio",
    attachmentUrl: "https://cdn.fbsbx.com/v/voice.mp4?sig=1",
    transcriptStatus: "PENDING",
    sentAt: SENT_AT,
  });
  db.facebookMessage.updateMany.mockResolvedValue({ count: 1 });
  db.facebookConversation.updateMany.mockResolvedValue({ count: 1 });
  transcribe.transcribeAudioUrl.mockResolvedValue({ transcript: "شحال الروبة الحمرا؟", mimeType: "audio/mp4", converted: true });
});

describe("transcribing a voice message", () => {
  it("keeps the transcript on the message and shows it in the list", async () => {
    await expect(processTranscribeJob(job())).resolves.toBe("transcribed");
    expect(transcribe.transcribeAudioUrl).toHaveBeenCalledWith("https://cdn.fbsbx.com/v/voice.mp4?sig=1");
    expect(db.facebookMessage.updateMany).toHaveBeenCalledWith({
      where: { id: "msg_v", transcriptStatus: "PENDING" },
      data: { transcript: "شحال الروبة الحمرا؟", transcriptStatus: "DONE", error: null },
    });
    // Only while it is still the conversation's last message.
    expect(db.facebookConversation.updateMany).toHaveBeenCalledWith({
      where: { id: "conv_1", lastMessageAt: SENT_AT },
      data: { lastMessageText: "🎤 شحال الروبة الحمرا؟" },
    });
  });

  it("marks it FAILED, with the reason, when it cannot be transcribed", async () => {
    transcribe.transcribeAudioUrl.mockRejectedValue(
      new TranscriptionError("Gemini could not transcribe the audio (missing_key): GOOGLE_API_KEY is not set", "ai_failed")
    );
    await expect(processTranscribeJob(job())).resolves.toBe("failed");
    expect(db.facebookMessage.updateMany).toHaveBeenCalledWith({
      where: { id: "msg_v", transcriptStatus: "PENDING" },
      data: {
        transcriptStatus: "FAILED",
        error: "Gemini could not transcribe the audio (missing_key): GOOGLE_API_KEY is not set",
      },
    });
    expect(db.facebookConversation.updateMany).not.toHaveBeenCalled();
  });

  it("fails cleanly without an audio link", async () => {
    db.facebookMessage.findUnique.mockResolvedValue({
      id: "msg_v",
      conversationId: "conv_1",
      attachmentType: "audio",
      attachmentUrl: null,
      transcriptStatus: "PENDING",
      sentAt: SENT_AT,
    });
    await expect(processTranscribeJob(job())).resolves.toBe("failed");
    expect(transcribe.transcribeAudioUrl).not.toHaveBeenCalled();
  });

  it.each([
    ["already transcribed", { transcriptStatus: "DONE" }],
    ["already failed", { transcriptStatus: "FAILED" }],
    ["not a voice message", { attachmentType: "image" }],
  ])("does nothing when %s", async (_case, overrides) => {
    db.facebookMessage.findUnique.mockResolvedValue({
      id: "msg_v",
      conversationId: "conv_1",
      attachmentType: "audio",
      attachmentUrl: "https://cdn/x",
      transcriptStatus: "PENDING",
      sentAt: SENT_AT,
      ...overrides,
    });
    await expect(processTranscribeJob(job())).resolves.toBe("skipped");
    expect(transcribe.transcribeAudioUrl).not.toHaveBeenCalled();
  });

  it("lets an unexpected error go, so BullMQ tries again", async () => {
    transcribe.transcribeAudioUrl.mockRejectedValue(new Error("connection terminated"));
    await expect(processTranscribeJob(job())).rejects.toThrow("connection terminated");
    expect(db.facebookMessage.updateMany).not.toHaveBeenCalled();
  });

  it("runs in the Facebook worker", async () => {
    db.facebookMessage.findUnique.mockResolvedValue(null);
    await expect(dispatchFacebookJob(job() as never)).resolves.toBe("skipped");
  });
});
