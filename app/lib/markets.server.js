// Shopify Markets API helpers — list markets, manage price adjustments,
// and enable .99 price rounding per market.
//
// Required scope: read_markets, write_markets (add to shopify.app.toml)

const MARKETS_QUERY = `#graphql
  query Markets($first: Int!) {
    markets(first: $first) {
      nodes {
        id
        name
        handle
        enabled
        primary
        regions(first: 50) {
          nodes {
            __typename
            ... on MarketRegionCountry {
              code
              name
              currency { currencyCode }
            }
          }
        }
        currencySettings {
          baseCurrency { currencyCode }
          localCurrencies
          roundingEnabled
        }
      }
    }
  }
`;

export async function listMarkets(admin) {
  const response = await admin.graphql(MARKETS_QUERY, {
    variables: { first: 50 },
  });
  const { data } = await response.json();
  return data.markets.nodes;
}

// Shopify's Markets model exposes rounding as a single boolean per market.
// When enabled, Shopify rounds converted multi-currency prices to a "nice"
// value per currency (the .99-style rounding, e.g. €20.00 -> €19.99). We just
// toggle the flag; Shopify owns the actual per-currency rounding rule.
const SET_ROUNDING_MUTATION = `#graphql
  mutation SetMarketRounding($marketId: ID!, $input: MarketCurrencySettingsUpdateInput!) {
    marketCurrencySettingsUpdate(marketId: $marketId, input: $input) {
      userErrors { field message }
    }
  }
`;

// enabled: boolean — turn .99 rounding on/off for the market's foreign currencies.
export async function setMarketRounding(admin, marketId, enabled) {
  const response = await admin.graphql(SET_ROUNDING_MUTATION, {
    variables: { marketId, input: { roundingEnabled: enabled } },
  });
  const { data } = await response.json();
  const result = data.marketCurrencySettingsUpdate;
  if (result.userErrors.length > 0) {
    throw new Error(result.userErrors.map((e) => e.message).join(", "));
  }
  return enabled;
}

// Whether .99 rounding is currently on for this market.
export function isRoundingEnabled(market) {
  return Boolean(market.currencySettings?.roundingEnabled);
}

// Extract unique currency codes from a market's country regions.
export function marketCurrencyCodes(market) {
  const codes = new Set();
  for (const region of market.regions?.nodes ?? []) {
    if (region.currency?.currencyCode) codes.add(region.currency.currencyCode);
  }
  if (market.currencySettings?.baseCurrency?.currencyCode) {
    codes.add(market.currencySettings.baseCurrency.currencyCode);
  }
  return [...codes];
}
