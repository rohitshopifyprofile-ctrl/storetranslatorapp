import { useState } from "react";
import { AppHero } from "../components/ui";
import { useLoaderData, useFetcher } from "react-router";
import { authenticate } from "../shopify.server";
import {
  listMarkets,
  setMarketRounding,
  isRoundingEnabled,
  marketCurrencyCodes,
  marketWebPresence,
  setMarketAlternateLocales,
} from "../lib/markets.server";
import { listShopLocales } from "../lib/shopify-translations.server";

export async function loader({ request }) {
  const { admin } = await authenticate.admin(request);
  const [rawMarkets, shopLocales] = await Promise.all([
    listMarkets(admin),
    listShopLocales(admin),
  ]);

  // Languages that CAN be shown to buyers (published, plus the primary).
  const publishedLocales = shopLocales
    .filter((l) => l.published || l.primary)
    .map((l) => ({ locale: l.locale, name: l.name }));

  // Pre-compute all derived values here (server-side) so the client component
  // never needs to import from the .server module.
  const markets = rawMarkets.map((m) => {
    const wp = marketWebPresence(m);
    const marketLocales = wp ? [wp.defaultLocale, ...wp.alternateLocales].filter(Boolean) : [];
    const addableLocales = publishedLocales.filter((pl) => !marketLocales.includes(pl.locale));
    return {
      id: m.id,
      name: m.name,
      primary: m.primary,
      enabled: m.enabled,
      countries: (m.regions?.nodes ?? []).map((r) => r.name).filter(Boolean),
      currencies: marketCurrencyCodes(m),
      roundingEnabled: isRoundingEnabled(m),
      webPresenceId: wp?.id ?? null,
      alternateLocales: wp?.alternateLocales ?? [],
      marketLocales,
      addableLocales,
    };
  });

  return { markets };
}

export async function action({ request }) {
  const { admin } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = formData.get("intent");
  const marketId = formData.get("marketId");

  try {
    if (intent === "enable_rounding") {
      await setMarketRounding(admin, marketId, true);
    } else if (intent === "disable_rounding") {
      await setMarketRounding(admin, marketId, false);
    } else if (intent === "add_language") {
      const webPresenceId = formData.get("webPresenceId");
      const locale = formData.get("locale");
      const existing = JSON.parse(formData.get("alternateLocales") || "[]");
      const next = existing.includes(locale) ? existing : [...existing, locale];
      await setMarketAlternateLocales(admin, webPresenceId, next);
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, error: String(error.message || error) };
  }
}

export default function Markets() {
  const { markets } = useLoaderData();
  const fetcher = useFetcher();

  const isLoading = fetcher.state !== "idle";

  return (
    <s-page>
      <AppHero title="Markets & Currency" subtitle="Per-market languages and .99 price rounding for foreign currencies." emoji="💱" />
      <s-section heading="What this page does">
        <p>
          Shopify Markets lets you sell to different countries with localized pricing and currency.
          Enable <strong>.99 price rounding</strong> below to automatically round all foreign-market
          prices to the nearest X.99 (e.g. €20.00 → €19.99, $45.00 → $44.99).
        </p>
        <p style={{ marginTop: "8px", color: "#666" }}>
          The country selector widget on your storefront lets customers switch between markets. To
          set up new markets (add countries, set base currencies), go to{" "}
          <a href="https://admin.shopify.com/store/-/settings/markets" target="_blank" rel="noreferrer">
            Settings → Markets
          </a>{" "}
          in the Shopify admin.
        </p>
      </s-section>

      {fetcher.data && !fetcher.data.ok && (
        <s-banner tone="critical">
          <p>{fetcher.data.error}</p>
        </s-banner>
      )}
      {fetcher.data?.ok && (
        <s-banner tone="success">
          <p>Market settings updated.</p>
        </s-banner>
      )}

      <s-section heading="Your markets">
        {markets.length === 0 ? (
          <p>No markets found. Create a market first in Shopify admin → Settings → Markets.</p>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ borderBottom: "1px solid #e0e0e0" }}>
                <Th>Market</Th>
                <Th>Countries</Th>
                <Th>Currencies</Th>
                <Th>Status</Th>
                <Th>.99 Price Rounding</Th>
              </tr>
            </thead>
            <tbody>
              {markets.map((market) => {
                const hasRounding = market.roundingEnabled;
                const currencies = market.currencies;
                const countries = market.countries.join(", ");

                return (
                  <tr key={market.id} style={{ borderBottom: "1px solid #f0f0f0" }}>
                    <Td>
                      <strong>{market.name}</strong>
                      {market.primary && (
                        <span style={{ marginLeft: 8, fontSize: 11, color: "#0052cc" }}>Primary</span>
                      )}
                    </Td>
                    <Td style={{ maxWidth: 200 }}>{countries || "—"}</Td>
                    <Td>{currencies.join(", ") || "—"}</Td>
                    <Td>
                      <span style={{ color: market.enabled ? "#1a7f37" : "#999" }}>
                        {market.enabled ? "Active" : "Inactive"}
                      </span>
                    </Td>
                    <Td>
                      {market.primary ? (
                        <span style={{ color: "#999", fontSize: 13 }}>Not applicable (primary)</span>
                      ) : (
                        <s-button
                          variant={hasRounding ? "secondary" : "primary"}
                          disabled={isLoading}
                          onClick={() =>
                            fetcher.submit(
                              {
                                intent: hasRounding ? "disable_rounding" : "enable_rounding",
                                marketId: market.id,
                              },
                              { method: "post" }
                            )
                          }
                        >
                          {hasRounding ? "Disable .99 rounding" : "Enable .99 rounding"}
                        </s-button>
                      )}
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </s-section>

      <s-section heading="Languages per market">
        <p style={{ color: "#555", marginBottom: "12px" }}>
          A published language only appears on the storefront for a market if it's added to
          that market here. This is what makes the geo auto-switch (e.g. France → French) work.
        </p>
        {markets.filter((m) => m.webPresenceId).length === 0 ? (
          <p style={{ color: "#999" }}>No market web presences found.</p>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ borderBottom: "1px solid #e0e0e0" }}>
                <Th style={{ width: "25%" }}>Market</Th>
                <Th style={{ width: "35%" }}>Languages shown to buyers</Th>
                <Th style={{ width: "40%" }}>Add a published language</Th>
              </tr>
            </thead>
            <tbody>
              {markets
                .filter((m) => m.webPresenceId)
                .map((market) => (
                  <MarketLanguageRow
                    key={market.id}
                    market={market}
                    fetcher={fetcher}
                    isLoading={isLoading}
                  />
                ))}
            </tbody>
          </table>
        )}
      </s-section>

      <s-section heading="How .99 rounding works">
        <p>
          When you enable rounding for a market, Shopify rounds that market's converted
          multi-currency prices to a natural value per currency — for example:
        </p>
        <ul style={{ marginTop: "8px", lineHeight: 1.8 }}>
          <li>€20.00 → €19.99</li>
          <li>€24.50 → €23.99</li>
          <li>$100.00 → $99.99</li>
        </ul>
        <p style={{ marginTop: "8px", color: "#666" }}>
          Rounding only affects converted prices in a market's foreign currencies, so your base
          (primary market) prices are unaffected. It has no visible effect unless the market
          uses local/multi-currency.
        </p>
      </s-section>
    </s-page>
  );
}

function MarketLanguageRow({ market, fetcher, isLoading }) {
  const [sel, setSel] = useState(market.addableLocales[0]?.locale ?? "");

  return (
    <tr style={{ borderBottom: "1px solid #f0f0f0", verticalAlign: "top" }}>
      <Td>
        <strong>{market.name}</strong>
        {market.primary && (
          <span style={{ marginLeft: 8, fontSize: 11, color: "#0052cc" }}>Primary</span>
        )}
      </Td>
      <Td>{market.marketLocales.join(", ") || "—"}</Td>
      <Td>
        {market.addableLocales.length === 0 ? (
          <span style={{ color: "#999", fontSize: 13 }}>All published languages added</span>
        ) : (
          <span style={{ display: "inline-flex", gap: 8, alignItems: "center" }}>
            <select
              value={sel}
              onChange={(e) => setSel(e.target.value)}
              style={{ padding: "6px", minWidth: 180 }}
            >
              {market.addableLocales.map((l) => (
                <option key={l.locale} value={l.locale}>
                  {l.name} ({l.locale})
                </option>
              ))}
            </select>
            <s-button
              variant="secondary"
              disabled={isLoading || !sel}
              onClick={() =>
                fetcher.submit(
                  {
                    intent: "add_language",
                    webPresenceId: market.webPresenceId,
                    locale: sel,
                    alternateLocales: JSON.stringify(market.alternateLocales),
                  },
                  { method: "post" }
                )
              }
            >
              Add
            </s-button>
          </span>
        )}
      </Td>
    </tr>
  );
}

function Th({ children }) {
  return <th style={{ textAlign: "left", padding: "8px 12px", fontSize: "13px", color: "#666" }}>{children}</th>;
}
function Td({ children, style }) {
  return <td style={{ padding: "8px 12px", fontSize: "14px", ...style }}>{children}</td>;
}
