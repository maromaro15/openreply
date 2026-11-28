-- Phase 14: the Page posts already read into drafts (PLAN.md 6.15).
-- Additive only: one new table.
-- CreateTable
CREATE TABLE "PostRead" (
    "workspaceId" TEXT NOT NULL,
    "postId" TEXT NOT NULL,
    "drafts" INTEGER NOT NULL DEFAULT 0,
    "readAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PostRead_pkey" PRIMARY KEY ("workspaceId","postId")
);

