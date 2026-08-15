// Automatic translation engine.
//
// Two entry points:
//   • autoTranslateResource() — translate ONE resource (from a webhook) into
//     every published language. Fast path for "add a product → auto-translate".
//   • translateWholeStore()   — sweep every content type into every published
//     language. Powers the "Translate whole store" button (products, theme UI /
//     buttons / checkout, collections, pages, policies, metafields, etc.).

import {
  getUntranslatedContent,
  getResourcePending,
  registerTranslations,
  listShopLocales,
} from "./shopify-translations.server";
import { translateFields, countWords } from "./translation-provider.server";
import { glossaryForLocale } from "./glossary.server";
import db from "../db.server";

// Every translatable content type Shopify exposes. "Whole store" walks them all.
// ONLINE_STORE_THEME + the theme_* types cover product-page templates, buttons,
// checkout labels and other storefront UI strings.
// Ordered high-impact + well-behaved first, and the single giant
// ONLINE_STORE_THEME node LAST — it's one resource with thousands of fields, so
// it's the slow one; keeping it last means everything the shopper actually sees
// (products, product-page templates, theme locale strings, collections, pages,
// metafields) finishes first even if the big theme step runs long.
const ALL_RESOURCE_TYPES = [
  "PRODUCT",
  "COLLECTION",
  "PAGE",
  "ARTICLE",
  "BLOG",
  "MENU",
  "PRODUCT_OPTION",
  "PRODUCT_OPTION_VALUE",
  "ONLINE_STORE_THEME_JSON_TEMPLATE",
  "ONLINE_STORE_THEME_LOCALE_CONTENT",
  "ONLINE_STORE_THEME_SETTINGS_DATA_SECTIONS",
  "ONLINE_STORE_THEME_SETTINGS_CATEGORY",
  "ONLINE_STORE_THEME_SECTION_GROUP",
  "ONLINE_STORE_THEME_APP_EMBED",
  "METAFIELD",
  "METAOBJECT",
  "SHOP",
  "SHOP_POLICY",
  "EMAIL_TEMPLATE",
  "PACKING_SLIP_TEMPLATE",
  "PAYMENT_GATEWAY",
  "DELIVERY_METHOD_DEFINITION",
  "ONLINE_STORE_THEME",
];

// Reject if `promise` doesn't settle within `ms` — prevents a stalled API call
// from hanging the background sweep forever (which froze the progress bar).
function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`timeout after ${ms}ms: ${label}`)), ms)),
  ]);
}

// Published, non-primary locales — the languages we translate INTO.
export async function publishedTargetLocales(admin) {
  const locales = await listShopLocales(admin);
  return locales.filter((l) => l.published && !l.primary).map((l) => l.locale);
}

async function shopSourceLocale(shop) {
  const settings = await db.shopSettings.upsert({
    where: { shop },
    update: {},
    create: { shop },
  });
  return settings.sourceLocale ?? "en";
}

// Translate `pending` fields of one resource into one locale and register them.
// Returns the number of words translated.
async function translateAndRegister(admin, shop, resourceId, pending, sourceLocale, targetLocale) {
  const textFields = pending.filter((c) => c.value && c.value.trim().length > 0);
  if (textFields.length === 0) return 0;

  const glossary = await glossaryForLocale(shop, targetLocale);
  const translated = await translateFields({
    texts: textFields.map((c) => ({ key: c.key, value: c.value })),
    sourceLocale,
    targetLocale,
    glossary,
  });

  const inputs = [];
  const translatedFields = [];
  for (const t of translated) {
    const original = textFields.find((c) => c.key === t.key);
    if (!original) continue;
    if (t.value == null) continue;              // failed → leave pending, don't register
    if (t.value === original.value) continue;    // same as source → don't register (no English-pollution)
    inputs.push({
      locale: targetLocale,
      key: t.key,
      value: t.value,
      translatableContentDigest: original.digest,
    });
    translatedFields.push(original);
  }

  if (inputs.length === 0) return 0;
  await registerTranslations(admin, resourceId, inputs);
  return countWords(translatedFields);
}

// Translate a single resource (by gid) into published languages.
// onlyLocales scopes to specific languages; null = all. Used by the products
// webhook (all) and the "translate one product" action (scoped).
export async function autoTranslateResource(admin, shop, resourceId, onlyLocales = null, overwrite = false) {
  const sourceLocale = await shopSourceLocale(shop);
  let targets = await publishedTargetLocales(admin);
  if (onlyLocales && onlyLocales.length > 0) {
    const want = new Set(onlyLocales);
    targets = targets.filter((l) => want.has(l));
  }
  let words = 0;

  for (const locale of targets) {
    try {
      const res = await getResourcePending(admin, resourceId, locale, overwrite);
      if (res && res.pending.length > 0) {
        words += await translateAndRegister(admin, shop, resourceId, res.pending, sourceLocale, locale);
      }
    } catch (error) {
      console.error(`[auto-translate] ${resourceId} -> ${locale} failed:`, error?.message || error);
    }
  }
  return words;
}

// Sweep the store: every content type × the chosen published languages.
// onlyLocales (array) scopes the run to specific languages; null = all.
// Long-running; call as a background job. Records progress on a TranslationJob.
export async function translateWholeStore(admin, shop, jobId = null, onlyLocales = null, overwrite = false) {
  const sourceLocale = await shopSourceLocale(shop);
  let targets = await publishedTargetLocales(admin);
  if (onlyLocales && onlyLocales.length > 0) {
    const want = new Set(onlyLocales);
    targets = targets.filter((l) => want.has(l));
  }

  let totalWords = 0;
  let totalResources = 0;
  let stepsDone = 0;
  const stepsTotal = ALL_RESOURCE_TYPES.length * targets.length;

  // Seed the progress totals up front so the bar can render immediately.
  if (jobId) {
    await db.translationJob
      .update({ where: { id: jobId }, data: { stepsTotal, stepsDone: 0 } })
      .catch(() => {});
  }

  for (const resourceType of ALL_RESOURCE_TYPES) {
    for (const locale of targets) {
      let after = null;
      let hasNext = true;
      while (hasNext) {
        try {
          // Timeout the query so a huge/slow resource (e.g. the giant theme
          // node) can never hang the whole sweep — skip and move on instead.
          const { resources, hasNextPage, endCursor } = await withTimeout(
            getUntranslatedContent(admin, { resourceType, locale, first: 10, after, overwrite }),
            90000,
            `${resourceType}/${locale} query`,
          );
          for (const r of resources) {
            const w = await translateAndRegister(admin, shop, r.resourceId, r.pending, sourceLocale, locale);
            totalWords += w;
            totalResources += 1;
            // Live word count so the bar visibly moves even within a long step.
            if (jobId && w > 0) {
              await db.translationJob
                .update({ where: { id: jobId }, data: { wordsTranslated: totalWords, currentStep: `${resourceType} → ${locale}` } })
                .catch(() => {});
            }
          }
          hasNext = hasNextPage;
          after = endCursor;
        } catch (error) {
          // Some resource types may not be present/queryable on a given store, or
          // a query may time out — skip and keep going rather than aborting.
          console.error(`[whole-store] ${resourceType} -> ${locale} failed:`, error?.message || error);
          hasNext = false;
        }
      }
      // One (resourceType × locale) step complete — record live progress.
      stepsDone += 1;
      if (jobId) {
        await db.translationJob
          .update({
            where: { id: jobId },
            data: {
              stepsDone,
              currentStep: `${resourceType} → ${locale}`,
              totalResources,
              wordsTranslated: totalWords,
            },
          })
          .catch(() => {});
      }
    }
  }

  if (jobId) {
    await db.translationJob
      .update({
        where: { id: jobId },
        data: {
          status: "completed",
          totalResources,
          wordsTranslated: totalWords,
          stepsDone: stepsTotal,
          currentStep: "Done",
          completedAt: new Date(),
        },
      })
      .catch(() => {});
  }

  return { totalWords, totalResources };
}
