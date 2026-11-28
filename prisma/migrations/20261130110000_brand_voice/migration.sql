-- CreateEnum
CREATE TYPE "VoiceSource" AS ENUM ('SEED', 'MANUAL', 'HUMAN_REPLY', 'INBOX_CORRECTION', 'IMPORT');

-- AlterTable
ALTER TABLE "BotSettings" ADD COLUMN     "voiceAutoSave" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "VoiceExample" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT,
    "customerText" TEXT NOT NULL,
    "replyText" TEXT NOT NULL,
    "source" "VoiceSource" NOT NULL DEFAULT 'MANUAL',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sourceMessageId" TEXT,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VoiceExample_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VoiceCorrection" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT,
    "wrong" TEXT NOT NULL,
    "right" TEXT[],
    "source" "VoiceSource" NOT NULL DEFAULT 'MANUAL',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VoiceCorrection_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "VoiceExample_sourceMessageId_key" ON "VoiceExample"("sourceMessageId");

-- CreateIndex
CREATE INDEX "VoiceExample_workspaceId_isActive_idx" ON "VoiceExample"("workspaceId", "isActive");

-- CreateIndex
CREATE INDEX "VoiceCorrection_workspaceId_isActive_idx" ON "VoiceCorrection"("workspaceId", "isActive");

-- AddForeignKey
ALTER TABLE "VoiceExample" ADD CONSTRAINT "VoiceExample_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VoiceCorrection" ADD CONSTRAINT "VoiceCorrection_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
