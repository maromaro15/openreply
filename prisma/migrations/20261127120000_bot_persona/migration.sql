-- Phase 11: the bot's persona, goal and sales playbook, the customer's state
-- on each answer, and the order details it collects (PLAN.md 6.16).
-- Additive only: new types, a new value on this branch's HandoffCategory,
-- and new columns on this branch's own tables (BotSettings,
-- FacebookConversation, FacebookMessage). No existing table, column or type
-- of the original application is touched.

-- CreateEnum
CREATE TYPE "CustomerState" AS ENUM ('NEUTRAL', 'PRICE_ONLY', 'HESITANT', 'READY_TO_BUY', 'ANGRY', 'WHOLESALE', 'CUSTOM_ORDER');

-- CreateEnum
CREATE TYPE "BotGoal" AS ENUM ('SELL', 'COLLECT_ORDER', 'COLLECT_INFO', 'ANSWER_ONLY');

-- CreateEnum
CREATE TYPE "OrderField" AS ENUM ('WILAYA', 'COLOUR', 'QUANTITY', 'NAME', 'PHONE', 'ADDRESS');

-- AlterEnum
ALTER TYPE "HandoffCategory" ADD VALUE 'ORDER_READY';

-- AlterTable
ALTER TABLE "FacebookConversation" ADD COLUMN     "customerState" "CustomerState",
ADD COLUMN     "orderDraft" JSONB;

-- AlterTable
ALTER TABLE "FacebookMessage" ADD COLUMN     "customerState" "CustomerState";

-- AlterTable
ALTER TABLE "BotSettings" ADD COLUMN     "dialect" TEXT,
ADD COLUMN     "goal" "BotGoal" NOT NULL DEFAULT 'SELL',
ADD COLUMN     "goalNotes" TEXT,
ADD COLUMN     "orderFields" "OrderField"[] DEFAULT ARRAY['WILAYA', 'COLOUR', 'QUANTITY', 'NAME', 'PHONE']::"OrderField"[],
ADD COLUMN     "personaName" TEXT,
ADD COLUMN     "personaStyle" TEXT,
ADD COLUMN     "playbook" TEXT;

