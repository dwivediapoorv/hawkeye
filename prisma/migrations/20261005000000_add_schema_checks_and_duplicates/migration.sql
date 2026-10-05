-- AlterTable
ALTER TABLE "Scan" ADD COLUMN     "duplicateTitleCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "missingDescriptionCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "schemaIssueCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "storefrontBlocked" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "ScanItem" ADD COLUMN     "descriptionMissing" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "titleDuplicate" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "SchemaCheck" (
    "id" TEXT NOT NULL,
    "scanId" TEXT NOT NULL,
    "pageType" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "schemaTypes" JSONB NOT NULL,
    "findings" JSONB NOT NULL,

    CONSTRAINT "SchemaCheck_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SchemaCheck_scanId_idx" ON "SchemaCheck"("scanId");

-- AddForeignKey
ALTER TABLE "SchemaCheck" ADD CONSTRAINT "SchemaCheck_scanId_fkey" FOREIGN KEY ("scanId") REFERENCES "Scan"("id") ON DELETE CASCADE ON UPDATE CASCADE;

