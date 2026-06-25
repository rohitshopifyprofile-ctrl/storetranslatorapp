-- CreateTable
CREATE TABLE "ShopSettings" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "shopGid" TEXT,
    "sourceLocale" TEXT NOT NULL DEFAULT 'en',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "GlossaryTerm" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "sourceTerm" TEXT NOT NULL,
    "targetLocale" TEXT NOT NULL,
    "targetTerm" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "TranslationJob" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "resourceType" TEXT NOT NULL,
    "targetLocale" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'running',
    "totalResources" INTEGER NOT NULL DEFAULT 0,
    "wordsTranslated" INTEGER NOT NULL DEFAULT 0,
    "errorMessage" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" DATETIME
);

-- CreateIndex
CREATE UNIQUE INDEX "ShopSettings_shop_key" ON "ShopSettings"("shop");

-- CreateIndex
CREATE INDEX "GlossaryTerm_shop_targetLocale_idx" ON "GlossaryTerm"("shop", "targetLocale");

-- CreateIndex
CREATE INDEX "TranslationJob_shop_idx" ON "TranslationJob"("shop");
