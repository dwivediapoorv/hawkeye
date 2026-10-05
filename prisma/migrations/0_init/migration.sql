-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "isOnline" BOOLEAN NOT NULL DEFAULT false,
    "scope" TEXT,
    "expires" TIMESTAMP(3),
    "accessToken" TEXT NOT NULL,
    "userId" BIGINT,
    "firstName" TEXT,
    "lastName" TEXT,
    "email" TEXT,
    "accountOwner" BOOLEAN NOT NULL DEFAULT false,
    "locale" TEXT,
    "collaborator" BOOLEAN DEFAULT false,
    "emailVerified" BOOLEAN DEFAULT false,
    "refreshToken" TEXT,
    "refreshTokenExpires" TIMESTAMP(3),

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Scan" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "error" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "productCount" INTEGER NOT NULL DEFAULT 0,
    "collectionCount" INTEGER NOT NULL DEFAULT 0,
    "longTitleCount" INTEGER NOT NULL DEFAULT 0,
    "longDescriptionCount" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "Scan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ScanItem" (
    "id" TEXT NOT NULL,
    "scanId" TEXT NOT NULL,
    "resourceType" TEXT NOT NULL,
    "resourceId" TEXT NOT NULL,
    "handle" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "metaTitle" TEXT NOT NULL,
    "metaDescription" TEXT NOT NULL,
    "titleLength" INTEGER NOT NULL,
    "descriptionLength" INTEGER NOT NULL,
    "titleTooLong" BOOLEAN NOT NULL,
    "descriptionTooLong" BOOLEAN NOT NULL,
    "titleIsDefault" BOOLEAN NOT NULL,
    "descriptionIsDefault" BOOLEAN NOT NULL,

    CONSTRAINT "ScanItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Scan_shop_startedAt_idx" ON "Scan"("shop", "startedAt");

-- CreateIndex
CREATE INDEX "ScanItem_scanId_resourceType_idx" ON "ScanItem"("scanId", "resourceType");

-- CreateIndex
CREATE INDEX "ScanItem_scanId_titleTooLong_idx" ON "ScanItem"("scanId", "titleTooLong");

-- CreateIndex
CREATE INDEX "ScanItem_scanId_descriptionTooLong_idx" ON "ScanItem"("scanId", "descriptionTooLong");

-- AddForeignKey
ALTER TABLE "ScanItem" ADD CONSTRAINT "ScanItem_scanId_fkey" FOREIGN KEY ("scanId") REFERENCES "Scan"("id") ON DELETE CASCADE ON UPDATE CASCADE;

