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
        regions {
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
        }
        priceAdjustments {
          nodes {
            id
            adjustment {
              __typename
              ... on MarketPriceAdjustmentPercentageDecrease {
                percentage
              }
              ... on MarketPriceAdjustmentPercentageIncrease {
                percentage
              }
            }
            currencyAdjustments {
              currency
              roundingRulesEnabled
              roundingAmount
            }
          }
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

const ADD_PRICE_ADJUSTMENT_MUTATION = `#graphql
  mutation MarketPriceAdjustmentAdd($marketId: ID!, $adjustment: MarketPriceAdjustmentInput!) {
    marketPriceAdjustmentAdd(marketId: $marketId, adjustment: $adjustment) {
      marketPriceAdjustment {
        id
        currencyAdjustments {
          currency
          roundingRulesEnabled
          roundingAmount
        }
      }
      userErrors { field message }
    }
  }
`;

const REMOVE_PRICE_ADJUSTMENT_MUTATION = `#graphql
  mutation MarketPriceAdjustmentRemove($id: ID!) {
    marketPriceAdjustmentRemove(id: $id) {
      deletedId
      userErrors { field message }
    }
  }
`;

// Adds a 0%-adjustment price rule with .99 rounding for all currencies in a market.
// currencyCodes: array of ISO currency codes (e.g. ["EUR", "GBP"])
export async function enableNinetyNineRounding(admin, marketId, currencyCodes) {
  const currencyAdjustments = currencyCodes.map((currency) => ({
    currency,
    roundingRulesEnabled: true,
    roundingAmount: -0.01,
  }));

  const response = await admin.graphql(ADD_PRICE_ADJUSTMENT_MUTATION, {
    variables: {
      marketId,
      adjustment: {
        // 0% keeps prices unchanged; this object just carries the rounding rule.
        adjustment: { percentageIncrease: { percentage: 0 } },
        currencyAdjustments,
      },
    },
  });

  const { data } = await response.json();
  const result = data.marketPriceAdjustmentAdd;
  if (result.userErrors.length > 0) {
    throw new Error(result.userErrors.map((e) => e.message).join(", "));
  }
  return result.marketPriceAdjustment;
}

export async function disableNinetyNineRounding(admin, adjustmentId) {
  const response = await admin.graphql(REMOVE_PRICE_ADJUSTMENT_MUTATION, {
    variables: { id: adjustmentId },
  });
  const { data } = await response.json();
  const result = data.marketPriceAdjustmentRemove;
  if (result.userErrors.length > 0) {
    throw new Error(result.userErrors.map((e) => e.message).join(", "));
  }
  return result.deletedId;
}

// Returns the GID of the first price adjustment that has .99 rounding enabled,
// or null if none exists.
export function findRoundingAdjustmentId(market) {
  for (const adj of market.priceAdjustments?.nodes ?? []) {
    if (adj.currencyAdjustments?.some((ca) => ca.roundingRulesEnabled && ca.roundingAmount === -0.01)) {
      return adj.id;
    }
  }
  return null;
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
