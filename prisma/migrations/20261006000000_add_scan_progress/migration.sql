-- AlterTable
ALTER TABLE "Scan" ADD COLUMN     "collectionTotal" INTEGER,
ADD COLUMN     "pagesChecked" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "pagesTotal" INTEGER,
ADD COLUMN     "productTotal" INTEGER;
