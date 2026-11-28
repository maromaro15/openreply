-- Facebook Pages / Messenger channel, bot knowledge base, handoff alerts.
--
-- Additive only: this migration creates new types, tables and indexes, and
-- adds foreign keys on the new tables. It does not alter or drop anything
-- that existed before it (__tests__/facebook/migration-safety.test.ts checks
-- this, and __tests__/facebook/schema.db.test.ts compares every existing
-- table's columns before and after it on a real PostgreSQL).

-- CreateEnum
CREATE TYPE "FacebookPageStatus" AS ENUM ('ACTIVE', 'TOKEN_INVALID', 'DISCONNECTED');

-- CreateEnum
CREATE TYPE "FacebookCommentStatus" AS ENUM ('PENDING', 'SENT', 'FAILED', 'UNCONFIRMED', 'SKIPPED_EXPIRED', 'SKIPPED_ALREADY_REPLIED', 'SKIPPED_NOT_ELIGIBLE', 'SKIPPED_RATE_LIMIT');

-- CreateEnum
CREATE TYPE "HandoffCategory" AS ENUM ('WHOLESALE_ORDER', 'CUSTOM_ORDER', 'COMPLAINT', 'NOT_IN_KB', 'AUDIO_FAILED', 'OTHER');

-- CreateEnum
CREATE TYPE "FacebookConversationMode" AS ENUM ('BOT', 'HUMAN');

-- CreateEnum
CREATE TYPE "FacebookModeReason" AS ENUM ('BOT_HANDOFF', 'INBOX_TAKEOVER', 'META_REPLY', 'INBOX_RELEASE');

-- CreateEnum
CREATE TYPE "FacebookMessageDirection" AS ENUM ('INBOUND', 'OUTBOUND');

-- CreateEnum
CREATE TYPE "FacebookMessageAuthor" AS ENUM ('CUSTOMER', 'BOT', 'HUMAN', 'CAMPAIGN');

-- CreateEnum
CREATE TYPE "FacebookMessageOrigin" AS ENUM ('OPENREPLY', 'EXTERNAL');

-- CreateEnum
CREATE TYPE "FacebookTranscriptStatus" AS ENUM ('PENDING', 'DONE', 'FAILED');

-- CreateEnum
CREATE TYPE "FacebookSendStatus" AS ENUM ('PENDING', 'SENT', 'FAILED', 'UNCONFIRMED');

-- CreateEnum
CREATE TYPE "FacebookConversationEventType" AS ENUM ('HANDOFF', 'HUMAN_TAKEOVER', 'RETURNED_TO_BOT');

-- CreateEnum
CREATE TYPE "FacebookWebhookStatus" AS ENUM ('RECEIVED', 'PROCESSED', 'FAILED');

-- CreateEnum
CREATE TYPE "KnowledgeEntryKind" AS ENUM ('PRODUCT', 'DELIVERY', 'FAQ', 'RULE', 'INFO');

-- CreateEnum
CREATE TYPE "AlertChannel" AS ENUM ('TELEGRAM', 'EMAIL');

-- CreateEnum
CREATE TYPE "AlertDeliveryStatus" AS ENUM ('PENDING', 'SENT', 'FAILED');

-- CreateTable
CREATE TABLE "FacebookPage" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "pageId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "pictureUrl" TEXT,
    "accessToken" TEXT NOT NULL,
    "tokenLast4" TEXT,
    "tokenExpiresAt" TIMESTAMP(3),
    "dataAccessExpiresAt" TIMESTAMP(3),
    "grantedScopes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "subscribedFields" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "webhookSubscribed" BOOLEAN NOT NULL DEFAULT false,
    "botEnabled" BOOLEAN NOT NULL DEFAULT true,
    "status" "FacebookPageStatus" NOT NULL DEFAULT 'ACTIVE',
    "lastError" TEXT,
    "lastWebhookAt" TIMESTAMP(3),
    "tokenCheckedAt" TIMESTAMP(3),
    "connectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FacebookPage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FacebookCampaign" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "facebookPageId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "postId" TEXT,
    "postPermalink" TEXT,
    "postPreview" TEXT,
    "matchAnyPost" BOOLEAN NOT NULL DEFAULT false,
    "keywords" TEXT[],
    "matchAnyWord" BOOLEAN NOT NULL DEFAULT false,
    "wholeWordMatch" BOOLEAN NOT NULL DEFAULT true,
    "privateReplyMessage" TEXT NOT NULL,
    "buttonLabel" TEXT NOT NULL,
    "landingUrl" TEXT NOT NULL,
    "addUtm" BOOLEAN NOT NULL DEFAULT true,
    "publicReplyEnabled" BOOLEAN NOT NULL DEFAULT false,
    "publicReplyMessages" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "botContext" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FacebookCampaign_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FacebookCommentLog" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "facebookPageId" TEXT NOT NULL,
    "campaignId" TEXT,
    "commentId" TEXT NOT NULL,
    "postId" TEXT NOT NULL,
    "parentId" TEXT,
    "commenterId" TEXT,
    "commenterName" TEXT,
    "commentText" TEXT NOT NULL,
    "commentCreatedAt" TIMESTAMP(3) NOT NULL,
    "matchedKeyword" TEXT,
    "status" "FacebookCommentStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "deliveryUnconfirmed" BOOLEAN NOT NULL DEFAULT false,
    "privateReplySentAt" TIMESTAMP(3),
    "recipientPsid" TEXT,
    "privateReplyMessageId" TEXT,
    "errorMessage" TEXT,
    "publicReplyDeliveryUnconfirmed" BOOLEAN NOT NULL DEFAULT false,
    "publicReplySentAt" TIMESTAMP(3),
    "publicReplyCommentId" TEXT,
    "publicReplyError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FacebookCommentLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FacebookConversation" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "facebookPageId" TEXT NOT NULL,
    "psid" TEXT NOT NULL,
    "userName" TEXT,
    "mode" "FacebookConversationMode" NOT NULL DEFAULT 'BOT',
    "modeReason" "FacebookModeReason",
    "modeChangedAt" TIMESTAMP(3),
    "needsHuman" BOOLEAN NOT NULL DEFAULT false,
    "handoffCategory" "HandoffCategory",
    "handoffReason" TEXT,
    "handoffAt" TIMESTAMP(3),
    "sourceCampaignId" TEXT,
    "sourceCommentId" TEXT,
    "lastInboundAt" TIMESTAMP(3),
    "lastOutboundAt" TIMESTAMP(3),
    "lastMessageText" TEXT,
    "lastMessageAt" TIMESTAMP(3),
    "unreadCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FacebookConversation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FacebookMessage" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "direction" "FacebookMessageDirection" NOT NULL,
    "author" "FacebookMessageAuthor" NOT NULL,
    "origin" "FacebookMessageOrigin",
    "echoAppId" TEXT,
    "mid" TEXT,
    "replyToMid" TEXT,
    "text" TEXT,
    "attachmentType" TEXT,
    "attachmentUrl" TEXT,
    "transcript" TEXT,
    "transcriptStatus" "FacebookTranscriptStatus",
    "sendStatus" "FacebookSendStatus",
    "error" TEXT,
    "sentByUserId" TEXT,
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FacebookMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FacebookConversationEvent" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "type" "FacebookConversationEventType" NOT NULL,
    "category" "HandoffCategory",
    "reason" TEXT,
    "actorUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FacebookConversationEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FacebookWebhookEvent" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT,
    "pageId" TEXT,
    "payload" JSONB NOT NULL,
    "status" "FacebookWebhookStatus" NOT NULL DEFAULT 'RECEIVED',
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),

    CONSTRAINT "FacebookWebhookEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BotSettings" (
    "workspaceId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "businessName" TEXT,
    "instructions" TEXT,
    "handoffMessage" TEXT NOT NULL DEFAULT 'نرجعولك',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BotSettings_pkey" PRIMARY KEY ("workspaceId")
);

-- CreateTable
CREATE TABLE "KnowledgeEntry" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "kind" "KnowledgeEntryKind" NOT NULL,
    "title" TEXT NOT NULL,
    "content" TEXT NOT NULL DEFAULT '',
    "price" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "KnowledgeEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AlertSettings" (
    "workspaceId" TEXT NOT NULL,
    "telegramBotToken" TEXT,
    "telegramBotUsername" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AlertSettings_pkey" PRIMARY KEY ("workspaceId")
);

-- CreateTable
CREATE TABLE "AlertRecipient" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "channel" "AlertChannel" NOT NULL,
    "label" TEXT NOT NULL,
    "telegramChatId" TEXT,
    "email" TEXT,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AlertRecipient_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AlertRoute" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "category" "HandoffCategory" NOT NULL,
    "recipientId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AlertRoute_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AlertDelivery" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "conversationId" TEXT,
    "eventId" TEXT,
    "recipientId" TEXT,
    "channel" "AlertChannel" NOT NULL,
    "category" "HandoffCategory",
    "dedupeKey" TEXT NOT NULL,
    "isTest" BOOLEAN NOT NULL DEFAULT false,
    "status" "AlertDeliveryStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sentAt" TIMESTAMP(3),

    CONSTRAINT "AlertDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "FacebookPage_pageId_key" ON "FacebookPage"("pageId");

-- CreateIndex
CREATE INDEX "FacebookPage_workspaceId_idx" ON "FacebookPage"("workspaceId");

-- CreateIndex
CREATE INDEX "FacebookCampaign_workspaceId_idx" ON "FacebookCampaign"("workspaceId");

-- CreateIndex
CREATE INDEX "FacebookCampaign_facebookPageId_isActive_idx" ON "FacebookCampaign"("facebookPageId", "isActive");

-- CreateIndex
CREATE INDEX "FacebookCampaign_postId_idx" ON "FacebookCampaign"("postId");

-- CreateIndex
CREATE INDEX "FacebookCommentLog_workspaceId_createdAt_idx" ON "FacebookCommentLog"("workspaceId", "createdAt");

-- CreateIndex
CREATE INDEX "FacebookCommentLog_campaignId_idx" ON "FacebookCommentLog"("campaignId");

-- CreateIndex
CREATE INDEX "FacebookCommentLog_status_idx" ON "FacebookCommentLog"("status");

-- CreateIndex
CREATE UNIQUE INDEX "FacebookCommentLog_facebookPageId_commentId_key" ON "FacebookCommentLog"("facebookPageId", "commentId");

-- CreateIndex
CREATE INDEX "FacebookConversation_workspaceId_needsHuman_lastMessageAt_idx" ON "FacebookConversation"("workspaceId", "needsHuman", "lastMessageAt");

-- CreateIndex
CREATE INDEX "FacebookConversation_workspaceId_handoffCategory_idx" ON "FacebookConversation"("workspaceId", "handoffCategory");

-- CreateIndex
CREATE UNIQUE INDEX "FacebookConversation_facebookPageId_psid_key" ON "FacebookConversation"("facebookPageId", "psid");

-- CreateIndex
CREATE UNIQUE INDEX "FacebookMessage_mid_key" ON "FacebookMessage"("mid");

-- CreateIndex
CREATE INDEX "FacebookMessage_conversationId_sentAt_idx" ON "FacebookMessage"("conversationId", "sentAt");

-- CreateIndex
CREATE UNIQUE INDEX "FacebookMessage_conversationId_replyToMid_key" ON "FacebookMessage"("conversationId", "replyToMid");

-- CreateIndex
CREATE INDEX "FacebookConversationEvent_conversationId_createdAt_idx" ON "FacebookConversationEvent"("conversationId", "createdAt");

-- CreateIndex
CREATE INDEX "FacebookConversationEvent_workspaceId_createdAt_idx" ON "FacebookConversationEvent"("workspaceId", "createdAt");

-- CreateIndex
CREATE INDEX "FacebookWebhookEvent_createdAt_idx" ON "FacebookWebhookEvent"("createdAt");

-- CreateIndex
CREATE INDEX "FacebookWebhookEvent_pageId_idx" ON "FacebookWebhookEvent"("pageId");

-- CreateIndex
CREATE INDEX "KnowledgeEntry_workspaceId_kind_isActive_idx" ON "KnowledgeEntry"("workspaceId", "kind", "isActive");

-- CreateIndex
CREATE INDEX "AlertRecipient_workspaceId_idx" ON "AlertRecipient"("workspaceId");

-- CreateIndex
CREATE INDEX "AlertRoute_workspaceId_category_idx" ON "AlertRoute"("workspaceId", "category");

-- CreateIndex
CREATE UNIQUE INDEX "AlertRoute_category_recipientId_key" ON "AlertRoute"("category", "recipientId");

-- CreateIndex
CREATE UNIQUE INDEX "AlertDelivery_dedupeKey_key" ON "AlertDelivery"("dedupeKey");

-- CreateIndex
CREATE INDEX "AlertDelivery_workspaceId_createdAt_idx" ON "AlertDelivery"("workspaceId", "createdAt");

-- AddForeignKey
ALTER TABLE "FacebookPage" ADD CONSTRAINT "FacebookPage_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FacebookCampaign" ADD CONSTRAINT "FacebookCampaign_facebookPageId_fkey" FOREIGN KEY ("facebookPageId") REFERENCES "FacebookPage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FacebookCommentLog" ADD CONSTRAINT "FacebookCommentLog_facebookPageId_fkey" FOREIGN KEY ("facebookPageId") REFERENCES "FacebookPage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FacebookCommentLog" ADD CONSTRAINT "FacebookCommentLog_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "FacebookCampaign"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FacebookConversation" ADD CONSTRAINT "FacebookConversation_facebookPageId_fkey" FOREIGN KEY ("facebookPageId") REFERENCES "FacebookPage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FacebookMessage" ADD CONSTRAINT "FacebookMessage_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "FacebookConversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FacebookConversationEvent" ADD CONSTRAINT "FacebookConversationEvent_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "FacebookConversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BotSettings" ADD CONSTRAINT "BotSettings_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KnowledgeEntry" ADD CONSTRAINT "KnowledgeEntry_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AlertSettings" ADD CONSTRAINT "AlertSettings_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AlertRecipient" ADD CONSTRAINT "AlertRecipient_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AlertRoute" ADD CONSTRAINT "AlertRoute_recipientId_fkey" FOREIGN KEY ("recipientId") REFERENCES "AlertRecipient"("id") ON DELETE CASCADE ON UPDATE CASCADE;

