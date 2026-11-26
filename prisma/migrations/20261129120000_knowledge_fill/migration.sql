-- Phase 14: filling the catalog and the knowledge base (PLAN.md 6.15).
-- Additive only: new enums and tables, and one nullable column on this branch's Product.
-- CreateEnum
CREATE TYPE "SuggestionSource" AS ENUM ('POST', 'CONVERSATION', 'INTERVIEW', 'HANDOFF_REPLY');

-- CreateEnum
CREATE TYPE "SuggestionStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "sourceNote" TEXT;

-- CreateTable
CREATE TABLE "KnowledgeSuggestion" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "source" "SuggestionSource" NOT NULL,
    "sourceRef" TEXT,
    "productId" TEXT,
    "target" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "evidence" TEXT,
    "dedupeKey" TEXT,
    "status" "SuggestionStatus" NOT NULL DEFAULT 'PENDING',
    "decidedByUserId" TEXT,
    "decidedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "KnowledgeSuggestion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KnowledgeInterview" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "chatId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "productIds" TEXT[],
    "position" INTEGER NOT NULL DEFAULT 0,
    "question" INTEGER NOT NULL DEFAULT 0,
    "lastAskedAt" TIMESTAMP(3),
    "startedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "KnowledgeInterview_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TelegramCursor" (
    "workspaceId" TEXT NOT NULL,
    "botId" TEXT,
    "offset" BIGINT NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TelegramCursor_pkey" PRIMARY KEY ("workspaceId")
);

-- CreateTable
CREATE TABLE "TelegramChatSeen" (
    "workspaceId" TEXT NOT NULL,
    "chatId" TEXT NOT NULL,
    "title" TEXT,
    "type" TEXT NOT NULL,
    "lastSeenAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TelegramChatSeen_pkey" PRIMARY KEY ("workspaceId","chatId")
);

-- CreateIndex
CREATE INDEX "KnowledgeSuggestion_workspaceId_status_createdAt_idx" ON "KnowledgeSuggestion"("workspaceId", "status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "KnowledgeSuggestion_workspaceId_dedupeKey_key" ON "KnowledgeSuggestion"("workspaceId", "dedupeKey");

-- CreateIndex
CREATE INDEX "KnowledgeInterview_workspaceId_status_idx" ON "KnowledgeInterview"("workspaceId", "status");

-- AddForeignKey
ALTER TABLE "KnowledgeSuggestion" ADD CONSTRAINT "KnowledgeSuggestion_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

