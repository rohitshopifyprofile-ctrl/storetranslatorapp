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
const ALL_RESOURCE_TYPES = [
  "PRODUCT",
  "PRODUCT_OPTION",
  "PRODUCT_OPTION_VALUE",
  "COLLECTION",
  "PAGE",
  "ARTICLE",
  "BLOG",
  "MENU",
  "SHOP",
  "SHOP_POLICY",
  "ONLINE_STORE_THEME",
  "ONLINE_STORE_THEME_JSON_TEMPLATE",
  "ONLINE_STORE_THEME_LOCALE_CONTENT",
  "ONLINE_STORE_THEME_SETTINGS_CATEGORY",
  "ONLINE_STORE_THEME_SETTINGS_DATA_SECTIONS",
  "ONLINE_STORE_THEME_SECTION_GROUP",
  "ONLINE_STORE_THEME_APP_EMBED",
  "EMAIL_TEMPLATE",
  "PACKING_SLIP_TEMPLATE",
  "PAYMENT_GATEWAY",
  "DELIVERY_METHOD_DEFINITION",
  "METAFIELD",
  "METAOBJECT",
];

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

  const inputs = translated.map((t) => {
    const original = textFields.find((c) => c.key === t.key);
    return {
      locale: targetLocale,
      key: t.key,
      value: t.value,
      translatableContentDigest: original.digest,
    };
  });

  await registerTranslations(admin, resourceId, inputs);
  return countWords(textFields);
}

// Translate a single resource (by gid) into every published language.
// Used by the products webhook. Best-effort: logs and continues on per-locale errors.
export async function autoTranslateResource(admin, shop, resourceId) {
  const sourceLocale = await shopSourceLocale(shop);
  const targets = await publishedTargetLocales(admin);
  let words = 0;

  for (const locale of targets) {
    try {
      const res = await getResourcePending(admin, resourceId, locale);
      if (res && res.pending.length > 0) {
        words += await translateAndRegister(admin, shop, resourceId, res.pending, sourceLocale, locale);
      }
    } catch (error) {
      console.error(`[auto-translate] ${resourceId} -> ${locale} failed:`, error?.message || error);
    }
  }
  return words;
}

// Sweep the ENTIRE store: every content type × every published language.
// Long-running; call as a background job. Records progress on a TranslationJob.
export async function translateWholeStore(admin, shop, jobId = null) {
  const sourceLocale = await shopSourceLocale(shop);
  const targets = await publishedTargetLocales(admin);

  let totalWords = 0;
  let totalResources = 0;

  for (const resourceType of ALL_RESOURCE_TYPES) {
    for (const locale of targets) {
      let after = null;
      let hasNext = true;
      while (hasNext) {
        try {
          const { resources, hasNextPage, endCursor } = await getUntranslatedContent(admin, {
            resourceType,
            locale,
            first: 10,
            after,
          });
          for (const r of resources) {
            totalWords += await translateAndRegister(admin, shop, r.resourceId, r.pending, sourceLocale, locale);
            totalResources += 1;
          }
          hasNext = hasNextPage;
          after = endCursor;
        } catch (error) {
          // Some resource types may not be present/queryable on a given store —
          // skip and keep going rather than aborting the whole sweep.
          console.error(`[whole-store] ${resourceType} -> ${locale} failed:`, error?.message || error);
          hasNext = false;
        }
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
          completedAt: new Date(),
        },
      })
      .catch(() => {});
  }

  return { totalWords, totalResources };
}
