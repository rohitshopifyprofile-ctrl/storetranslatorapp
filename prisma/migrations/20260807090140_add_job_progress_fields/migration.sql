-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_TranslationJob" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "resourceType" TEXT NOT NULL,
    "targetLocale" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'running',
    "totalResources" INTEGER NOT NULL DEFAULT 0,
    "wordsTranslated" INTEGER NOT NULL DEFAULT 0,
    "stepsTotal" INTEGER NOT NULL DEFAULT 0,
    "stepsDone" INTEGER NOT NULL DEFAULT 0,
    "currentStep" TEXT,
    "errorMessage" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" DATETIME
);
INSERT INTO "new_TranslationJob" ("completedAt", "createdAt", "errorMessage", "id", "resourceType", "shop", "status", "targetLocale", "totalResources", "wordsTranslated") SELECT "completedAt", "createdAt", "errorMessage", "id", "resourceType", "shop", "status", "targetLocale", "totalResources", "wordsTranslated" FROM "TranslationJob";
DROP TABLE "TranslationJob";
ALTER TABLE "new_TranslationJob" RENAME TO "TranslationJob";
CREATE INDEX "TranslationJob_shop_idx" ON "TranslationJob"("shop");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
