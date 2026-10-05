-- AlterTable
ALTER TABLE "Shop" ADD COLUMN     "contactEmail" TEXT,
ADD COLUMN     "country" TEXT,
ADD COLUMN     "email" TEXT,
ADD COLUMN     "isDevStore" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "ownerName" TEXT,
ADD COLUMN     "phone" TEXT,
ADD COLUMN     "profileSyncedAt" TIMESTAMP(3),
ADD COLUMN     "shopName" TEXT,
ADD COLUMN     "shopifyPlan" TEXT;

