/**
 * The Facebook worker: consumes "facebook-processing" only.
 *
 * Unlike the Instagram dispatcher, an unknown job name is reported and
 * dropped, never run as a comment: a job this version does not know (from a
 * newer web container during a rolling update, say) must not send anything.
 */
import { Worker, type Job } from "bullmq";
import { getRedisConnection } from "@/lib/queue/client";
import { processCommentJob } from "./comments";
import { getFacebookWorkerConcurrency } from "./env";
import { processBotReplyJob } from "./bot-reply";
import { recordFacebookWorkerAlert } from "./health";
import { processMessageJob } from "./messages";
import {
  FACEBOOK_QUEUE,
  FB_BOT_REPLY_JOB,
  FB_COMMENT_JOB,
  FB_MESSAGE_JOB,
  type FacebookBotReplyJob,
  type FacebookCommentJob,
  type FacebookJob,
  type FacebookMessageJob,
} from "./queue";

export async function dispatchFacebookJob(job: Job<FacebookJob>): Promise<string> {
  switch (job.name) {
    case FB_COMMENT_JOB:
      return processCommentJob(job as Job<FacebookCommentJob>);
    case FB_MESSAGE_JOB:
      return processMessageJob(job as Job<FacebookMessageJob>);
    case FB_BOT_REPLY_JOB:
      return processBotReplyJob(job as Job<FacebookBotReplyJob>);
    default:
      console.warn(`[Facebook worker] Unknown job "${job.name}" (${job.id}) skipped`);
      return "unknown_job";
  }
}

export function createFacebookWorker(): Worker<FacebookJob> {
  const worker = new Worker<FacebookJob>(FACEBOOK_QUEUE, dispatchFacebookJob, {
    connection: getRedisConnection(),
    concurrency: getFacebookWorkerConcurrency(),
  });

  worker.on("completed", (job, result) => {
    console.log(`[Facebook worker] ${job.name} ${job.id}: ${String(result)}`);
  });

  worker.on("failed", (job, error) => {
    console.error(`[Facebook worker] ${job?.name} ${job?.id} failed (attempt ${job?.attemptsMade}):`, error.message);
    void recordFacebookWorkerAlert({
      message: error.message,
      jobId: job?.id,
      jobName: job?.name,
    }).catch(() => {});
  });

  worker.on("error", (error) => {
    console.error("[Facebook worker] Worker error:", error.message);
  });

  return worker;
}
