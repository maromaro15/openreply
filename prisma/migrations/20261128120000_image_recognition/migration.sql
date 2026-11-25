-- Phase 12: what the bot read from a customer's photo (PLAN.md 6.13).
-- Additive only: one nullable column on this branch's FacebookMessage.

-- AlterTable
ALTER TABLE "FacebookMessage" ADD COLUMN     "imageAnalysis" JSONB;

