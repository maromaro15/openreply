/**
 * Messenger voice messages to text, in their own job.
 *
 * Queued as soon as the message is stored: Messenger's audio links are
 * temporary. The transcript is kept on the message itself, so the inbox,
 * the bot and the alerts all read it like typed text. A failure marks the
 * message FAILED; the bot then hands the conversation to a person
 * (AUDIO_FAILED). The audio itself is never stored.
 */
import type { Job } from "bullmq";
import { prisma } from "@/lib/db/client";
import { TranscriptionError, transcribeAudioUrl } from "@/lib/ai/transcribe";
import { preview } from "./conversations";
import { FB_TRANSCRIBE_JOB, getFacebookQueue, transcribeJobId, type FacebookTranscribeJob } from "./queue";

export type TranscribeOutcome = "transcribed" | "failed" | "skipped";

/** Safe to call twice: the job ID is the message's. */
export async function queueTranscription(messageId: string): Promise<void> {
  await getFacebookQueue().add(
    FB_TRANSCRIBE_JOB,
    { messageId },
    { jobId: transcribeJobId(messageId), attempts: 3, backoff: { type: "exponential", delay: 15_000 } }
  );
}

export async function processTranscribeJob(job: Job<FacebookTranscribeJob>): Promise<TranscribeOutcome> {
  const message = await prisma.facebookMessage.findUnique({
    where: { id: job.data.messageId },
    select: {
      id: true,
      conversationId: true,
      attachmentType: true,
      attachmentUrl: true,
      transcriptStatus: true,
      sentAt: true,
    },
  });
  if (!message || message.attachmentType !== "audio" || message.transcriptStatus !== "PENDING") return "skipped";

  const fail = async (reason: string): Promise<TranscribeOutcome> => {
    await prisma.facebookMessage.updateMany({
      where: { id: message.id, transcriptStatus: "PENDING" },
      data: { transcriptStatus: "FAILED", error: reason },
    });
    return "failed";
  };
  if (!message.attachmentUrl) return fail("The voice message came without a link to its audio.");

  let transcript: string;
  try {
    ({ transcript } = await transcribeAudioUrl(message.attachmentUrl));
  } catch (error) {
    // Expected failures are final; anything else (the database, a bug) is
    // thrown so BullMQ tries again.
    if (error instanceof TranscriptionError) return fail(error.message);
    throw error;
  }

  await prisma.facebookMessage.updateMany({
    where: { id: message.id, transcriptStatus: "PENDING" },
    data: { transcript, transcriptStatus: "DONE", error: null },
  });
  // The list shows what was said, while this is still the last message.
  await prisma.facebookConversation.updateMany({
    where: { id: message.conversationId, lastMessageAt: message.sentAt },
    data: { lastMessageText: preview(`🎤 ${transcript}`) },
  });
  return "transcribed";
}
