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

const TRANSLATIONS_REGISTER_MUTATION = `#graphql
  mutation RegisterTranslations($resourceId: ID!, $translations: [TranslationInput!]!) {
    translationsRegister(resourceId: $resourceId, translations: $translations) {
      userErrors { field message }
      translations { key value locale }
    }
  }
`;

// translations: [{ locale, key, value, translatableContentDigest }]
export async function registerTranslations(admin, resourceId, translations) {
  const response = await admin.graphql(TRANSLATIONS_REGISTER_MUTATION, {
    variables: { resourceId, translations },
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
  return result.translations;
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
      code
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
