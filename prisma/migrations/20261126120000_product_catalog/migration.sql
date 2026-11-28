-- Product catalog (PLAN.md, phase 10). Additive only, like the migration
-- before it: new types and tables, two new columns on tables that migration
-- created (FacebookCampaign.productId, nullable; FacebookConversation.
-- focusProductIds, defaulting to an empty list), indexes on the new tables,
-- and foreign keys between this branch's tables. No table or type that
-- existed before this branch is touched.
-- CreateEnum
CREATE TYPE "ProductAttributeType" AS ENUM ('TEXT', 'NUMBER', 'CHOICE', 'BOOLEAN');

-- CreateEnum
CREATE TYPE "ProductStatus" AS ENUM ('DRAFT', 'ACTIVE', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "ProductSource" AS ENUM ('MANUAL', 'IMPORT', 'POST', 'CONVERSATION', 'INTERVIEW');

-- AlterTable
ALTER TABLE "FacebookCampaign" ADD COLUMN     "productId" TEXT;

-- AlterTable
ALTER TABLE "FacebookConversation" ADD COLUMN     "focusProductIds" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- CreateTable
CREATE TABLE "ProductAttribute" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "type" "ProductAttributeType" NOT NULL DEFAULT 'TEXT',
    "unit" TEXT,
    "options" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProductAttribute_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Product" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "status" "ProductStatus" NOT NULL DEFAULT 'ACTIVE',
    "source" "ProductSource" NOT NULL DEFAULT 'MANUAL',
    "sourceRef" TEXT,
    "name" TEXT NOT NULL,
    "code" TEXT,
    "codeKey" TEXT,
    "price" TEXT,
    "available" BOOLEAN NOT NULL DEFAULT true,
    "landingUrl" TEXT,
    "description" TEXT,
    "howToUse" TEXT,
    "attributes" JSONB NOT NULL DEFAULT '{}',
    "strengths" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "comparisons" TEXT,
    "suitableFor" TEXT,
    "objections" JSONB NOT NULL DEFAULT '[]',
    "mainImageId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Product_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductVariant" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "codeKey" TEXT NOT NULL,
    "name" TEXT,
    "available" BOOLEAN NOT NULL DEFAULT true,
    "price" TEXT,
    "imageId" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProductVariant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductImage" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "productId" TEXT,
    "publicId" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "data" BYTEA NOT NULL,
    "fileName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProductImage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductRelation" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "relatedId" TEXT NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProductRelation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ProductAttribute_workspaceId_key_key" ON "ProductAttribute"("workspaceId", "key");

-- CreateIndex
CREATE INDEX "Product_workspaceId_status_idx" ON "Product"("workspaceId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Product_workspaceId_codeKey_key" ON "Product"("workspaceId", "codeKey");

-- CreateIndex
CREATE INDEX "ProductVariant_workspaceId_codeKey_idx" ON "ProductVariant"("workspaceId", "codeKey");

-- CreateIndex
CREATE UNIQUE INDEX "ProductVariant_productId_codeKey_key" ON "ProductVariant"("productId", "codeKey");

-- CreateIndex
CREATE UNIQUE INDEX "ProductImage_publicId_key" ON "ProductImage"("publicId");

-- CreateIndex
CREATE INDEX "ProductImage_workspaceId_productId_idx" ON "ProductImage"("workspaceId", "productId");

-- CreateIndex
CREATE UNIQUE INDEX "ProductRelation_productId_relatedId_key" ON "ProductRelation"("productId", "relatedId");

-- AddForeignKey
ALTER TABLE "FacebookCampaign" ADD CONSTRAINT "FacebookCampaign_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Product" ADD CONSTRAINT "Product_mainImageId_fkey" FOREIGN KEY ("mainImageId") REFERENCES "ProductImage"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductVariant" ADD CONSTRAINT "ProductVariant_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductVariant" ADD CONSTRAINT "ProductVariant_imageId_fkey" FOREIGN KEY ("imageId") REFERENCES "ProductImage"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductImage" ADD CONSTRAINT "ProductImage_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductRelation" ADD CONSTRAINT "ProductRelation_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductRelation" ADD CONSTRAINT "ProductRelation_relatedId_fkey" FOREIGN KEY ("relatedId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

