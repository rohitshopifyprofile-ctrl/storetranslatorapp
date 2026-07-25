// Helpers for Shopify's translation & locale GraphQL Admin API.
//
// Docs:
//   https://shopify.dev/docs/apps/build/markets/manage-translated-content
//   https://shopify.dev/docs/api/admin-graphql/latest/mutations/translationsRegister
//
// Required access scopes (add to shopify.app.toml):
//   read_products, read_locales, write_locales, read_translations, write_translations

const TRANSLATABLE_CONTENT_QUERY = `#graphql
  query TranslatableContent($resourceType: TranslatableResourceType!, $first: Int!, $after: String, $locale: String!) {
    translatableResources(resourceType: $resourceType, first: $first, after: $after) {
      pageInfo { hasNextPage endCursor }
      nodes {
        resourceId
        translatableContent {
          key
          value
          digest
          locale
        }
        translations(locale: $locale) {
          key
          value
          outdated
        }
      }
    }
  }
`;

// Translatable keys we deliberately never translate. `handle` is the URL slug
// and must be unique per resource — registering a translated handle collides
// ("… is already taken as a handle for this resource"), so we keep the original.
const SKIP_KEYS = new Set(["handle"]);

const TRANSLATABLE_RESOURCE_QUERY = `#graphql
  query TranslatableResource($resourceId: ID!, $locale: String!) {
    translatableResource(resourceId: $resourceId) {
      resourceId
      translatableContent { key value digest locale }
      translations(locale: $locale) { key value outdated }
    }
  }
`;

// Pending translatable fields for a SINGLE resource (used by webhooks to
// translate one product/collection/etc.). Returns { resourceId, pending } or
// null if the resource has no translatable content.
export async function getResourcePending(admin, resourceId, locale) {
  const response = await admin.graphql(TRANSLATABLE_RESOURCE_QUERY, {
    variables: { resourceId, locale },
  });
  const { data } = await response.json();
  const node = data.translatableResource;
  if (!node) return null;

  const existing = new Map(node.translations.map((t) => [t.key, t]));
  const pending = node.translatableContent.filter((content) => {
    if (SKIP_KEYS.has(content.key)) return false;
    if (!content.value || content.value.trim().length === 0) return false;
    const current = existing.get(content.key);
    return !current || current.outdated;
  });
  return { resourceId: node.resourceId, pending };
}

// Returns only the resources/fields that still need a translation (or whose
// translation is outdated because the source content changed since).
export async function getUntranslatedContent(admin, { resourceType, locale, first = 20, after = null }) {
  const response = await admin.graphql(TRANSLATABLE_CONTENT_QUERY, {
    variables: { resourceType, locale, first, after },
  });
  const { data } = await response.json();
  const connection = data.translatableResources;

  const resources = connection.nodes
    .map((node) => {
      const existing = new Map(node.translations.map((t) => [t.key, t]));
      const pending = node.translatableContent.filter((content) => {
        if (SKIP_KEYS.has(content.key)) return false;
        // Skip fields with no source text (Shopify returns empty SEO/handle
        // entries) — they have nothing to translate and would otherwise be
        // counted as "items" with 0 words.
        if (!content.value || content.value.trim().length === 0) return false;
        const current = existing.get(content.key);
        return !current || current.outdated;
      });
      return { resourceId: node.resourceId, pending };
    })
    .filter((r) => r.pending.length > 0);

  return {
    resources,
    hasNextPage: connection.pageInfo.hasNextPage,
    endCursor: connection.pageInfo.endCursor,
  };
}

// For the review/preview screen: returns every resource with each translatable
// text field shown as { key, source, translated, outdated }. Unlike
// getUntranslatedContent, this does NOT filter to pending — it shows the current
// state so a merchant can eyeball translation accuracy.
export async function getTranslationsForReview(admin, { resourceType, locale, first = 25, after = null }) {
  const response = await admin.graphql(TRANSLATABLE_CONTENT_QUERY, {
    variables: { resourceType, locale, first, after },
  });
  const { data } = await response.json();
  const connection = data.translatableResources;

  const resources = connection.nodes
    .map((node) => {
      const existing = new Map(node.translations.map((t) => [t.key, t]));
      const fields = node.translatableContent
        .filter((c) => !SKIP_KEYS.has(c.key) && c.value && c.value.trim().length > 0)
        .map((c) => {
          const current = existing.get(c.key);
          return {
            key: c.key,
            source: c.value,
            translated: current?.value ?? null,
            outdated: current?.outdated ?? false,
          };
        });
      return { resourceId: node.resourceId, fields };
    })
    .filter((r) => r.fields.length > 0);

  return {
    resources,
    hasNextPage: connection.pageInfo.hasNextPage,
    endCursor: connection.pageInfo.endCursor,
  };
}

const TRANSLATIONS_REGISTER_MUTATION = `#graphql
  mutation RegisterTranslations($resourceId: ID!, $translations: [TranslationInput!]!) {
    translationsRegister(resourceId: $resourceId, translations: $translations) {
      userErrors { field message }
      translations { key value locale }
    }
  }
`;

// Shopify allows at most 100 translations per translationsRegister call. Theme
// templates can have more translatable keys than that, so register in batches.
const MAX_TRANSLATIONS_PER_CALL = 100;

// translations: [{ locale, key, value, translatableContentDigest }]
export async function registerTranslations(admin, resourceId, translations) {
  const registered = [];
  for (let i = 0; i < translations.length; i += MAX_TRANSLATIONS_PER_CALL) {
    const batch = translations.slice(i, i + MAX_TRANSLATIONS_PER_CALL);
    const response = await admin.graphql(TRANSLATIONS_REGISTER_MUTATION, {
      variables: { resourceId, translations: batch },
    });
    const { data } = await response.json();
    const result = data.translationsRegister;
    if (result.userErrors.length > 0) {
      throw new Error(
        `translationsRegister failed for ${resourceId}: ${result.userErrors
          .map((e) => e.message)
          .join(", ")}`
      );
    }
    registered.push(...result.translations);
  }
  return registered;
}

const SHOP_LOCALES_QUERY = `#graphql
  query ShopLocales {
    shopLocales {
      locale
      name
      primary
      published
    }
  }
`;

export async function listShopLocales(admin) {
  const response = await admin.graphql(SHOP_LOCALES_QUERY);
  const { data } = await response.json();
  return data.shopLocales;
}

const AVAILABLE_LOCALES_QUERY = `#graphql
  query AvailableLocales {
    availableLocales {
      code: isoCode
      name
    }
  }
`;

// Locales the shop *could* enable next (for the "add a language" dropdown).
export async function listAvailableLocales(admin) {
  const response = await admin.graphql(AVAILABLE_LOCALES_QUERY);
  const { data } = await response.json();
  return data.availableLocales;
}

const ENABLE_LOCALE_MUTATION = `#graphql
  mutation EnableLocale($locale: String!) {
    shopLocaleEnable(locale: $locale) {
      shopLocale { locale name primary published }
      userErrors { field message }
    }
  }
`;

// Newly enabled locales start unpublished — call setLocalePublished after
// you've translated enough content for it to be worth showing to buyers.
export async function enableLocale(admin, locale) {
  const response = await admin.graphql(ENABLE_LOCALE_MUTATION, { variables: { locale } });
  const { data } = await response.json();
  const result = data.shopLocaleEnable;
  if (result.userErrors.length > 0) {
    throw new Error(result.userErrors.map((e) => e.message).join(", "));
  }
  return result.shopLocale;
}

const PUBLISH_LOCALE_MUTATION = `#graphql
  mutation PublishLocale($locale: String!, $published: Boolean!) {
    shopLocaleUpdate(locale: $locale, shopLocale: { published: $published }) {
      shopLocale { locale name primary published }
      userErrors { field message }
    }
  }
`;

export async function setLocalePublished(admin, locale, published) {
  const response = await admin.graphql(PUBLISH_LOCALE_MUTATION, {
    variables: { locale, published },
  });
  const { data } = await response.json();
  const result = data.shopLocaleUpdate;
  if (result.userErrors.length > 0) {
    throw new Error(result.userErrors.map((e) => e.message).join(", "));
  }
  return result.shopLocale;
}

const SHOP_ID_QUERY = `#graphql
  query ShopId {
    shop { id }
  }
`;

// Numeric/GID shop id — fetch once per shop and cache it (ShopSettings.shopGid).
export async function getShopGid(admin) {
  const response = await admin.graphql(SHOP_ID_QUERY);
  const { data } = await response.json();
  return data.shop.id;
}
