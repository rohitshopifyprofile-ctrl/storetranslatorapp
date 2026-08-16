// Translation memory (dictionary). Stores source→translation per shop+locale
// pair so identical strings are reused instead of re-translated. Big token/time
// saver — themes and product boilerplate repeat the same strings constantly.
import crypto from "node:crypto";
import db from "../db.server";

export function hashText(s) {
  return crypto.createHash("sha256").update(String(s)).digest("hex");
}

// Map<sourceHash, translatedText> for the given source texts (cache hits).
export async function getCachedMap(shop, sourceLocale, targetLocale, sourceTexts) {
  if (!shop || sourceTexts.length === 0) return new Map();
  const hashes = [...new Set(sourceTexts.map(hashText))];
  try {
    const rows = await db.translationCache.findMany({
      where: { shop, sourceLocale, targetLocale, sourceHash: { in: hashes } },
      select: { sourceHash: true, translatedText: true },
    });
    return new Map(rows.map((r) => [r.sourceHash, r.translatedText]));
  } catch {
    return new Map(); // cache is best-effort — never block translation
  }
}

// Store new source→translation pairs (write-once; skips existing).
export async function putCached(shop, sourceLocale, targetLocale, pairs) {
  if (!shop || pairs.length === 0) return;
  const data = pairs.map(({ source, translated }) => ({
    shop, sourceLocale, targetLocale, sourceHash: hashText(source), translatedText: translated,
  }));
  try {
    await db.translationCache.createMany({ data, skipDuplicates: true });
  } catch { /* best-effort */ }
}
