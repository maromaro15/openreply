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
import { recordFacebookWorkerAlert } from "./health";
import { FACEBOOK_QUEUE, FB_COMMENT_JOB, type FacebookCommentJob, type FacebookJob } from "./queue";

export async function dispatchFacebookJob(job: Job<FacebookJob>): Promise<string> {
  switch (job.name) {
    case FB_COMMENT_JOB:
      return processCommentJob(job as Job<FacebookCommentJob>);
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
