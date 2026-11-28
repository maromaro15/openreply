-- AlterEnum
ALTER TYPE "FacebookModeReason" ADD VALUE 'AUTO_RESUME';

-- AlterTable
ALTER TABLE "BotSettings" ADD COLUMN     "busyMessage" TEXT NOT NULL DEFAULT 'الفريق مشغول ضرك، نتصلو بيك من بعد',
ADD COLUMN     "resumeAfterMessages" INTEGER NOT NULL DEFAULT 3,
ADD COLUMN     "resumeAfterMinutes" INTEGER NOT NULL DEFAULT 20;

