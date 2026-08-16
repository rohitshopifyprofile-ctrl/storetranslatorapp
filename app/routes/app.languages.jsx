import { useState } from "react";
import { AppHero } from "../components/ui";
import { useLoaderData, useFetcher } from "react-router";
import { authenticate } from "../shopify.server";
import {
  listShopLocales,
  listAvailableLocales,
  enableLocale,
  setLocalePublished,
} from "../lib/shopify-translations.server";
import { listMarkets, marketWebPresence, setMarketDefaultLocale } from "../lib/markets.server";

export async function loader({ request }) {
  const { admin } = await authenticate.admin(request);
  const [shopLocales, availableLocales, rawMarkets] = await Promise.all([
    listShopLocales(admin),
    listAvailableLocales(admin),
    listMarkets(admin),
  ]);
  const enabledCodes = new Set(shopLocales.map((l) => l.locale));
  const addable = availableLocales.filter((l) => !enabledCodes.has(l.code));

  // The store's "native" language = its primary shop locale. Translations are
  // generated from it and buyers fall back to it. Should be English.
  const primary = shopLocales.find((l) => l.primary);
  const primaryLocale = primary?.locale ?? "en";
  const primaryName = primary?.name ?? "English";
  const primaryIsEnglish = primaryLocale.toLowerCase().startsWith("en");

  // Each market's web presence has its own default (fallback) language. If a
  // market's default isn't the native language, unmatched visitors to that
  // market see that language instead of English — the "French default" symptom.
  const marketDefaults = rawMarkets
    .map((m) => {
      const wp = marketWebPresence(m);
      if (!wp) return null;
      return {
        name: m.name,
        primaryMarket: m.primary,
        webPresenceId: wp.id,
        defaultLocale: wp.defaultLocale,
        alternateLocales: wp.alternateLocales,
        isNative: !!wp.defaultLocale && wp.defaultLocale.toLowerCase() === primaryLocale.toLowerCase(),
      };
    })
    .filter(Boolean);

  return { shopLocales, addable, primaryLocale, primaryName, primaryIsEnglish, marketDefaults };
}

export async function action({ request }) {
  const { admin } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = formData.get("intent");
  const locale = formData.get("locale");

  try {
    if (intent === "enable") {
      await enableLocale(admin, locale);
    } else if (intent === "publish") {
      await setLocalePublished(admin, locale, formData.get("published") === "true");
    } else if (intent === "reset_market_default") {
      const webPresenceId = formData.get("webPresenceId");
      const toLocale = formData.get("toLocale"); // the native/primary locale
      const currentDefault = formData.get("currentDefault");
      const alternates = JSON.parse(formData.get("alternateLocales") || "[]");
      // Shopify forbids a locale being both default and alternate: fold the old
      // default into alternates, then remove the new default from that list.
      const nextAlternates = [
        ...new Set([...alternates, currentDefault].filter(Boolean).filter((l) => l !== toLocale)),
      ];
      await setMarketDefaultLocale(admin, webPresenceId, toLocale, nextAlternates);
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, error: String(error.message || error) };
  }
}

export default function Languages() {
  const { shopLocales, addable, primaryLocale, primaryName, primaryIsEnglish, marketDefaults } =
    useLoaderData();
  const fetcher = useFetcher();
  const [selected, setSelected] = useState(addable[0]?.code ?? "");

  const isLoading = fetcher.state !== "idle";
  const offenders = marketDefaults.filter((m) => !m.isNative);

  return (
    <s-page>
      <AppHero title="Languages" subtitle="Enable, publish and manage the languages your storefront offers." emoji="🗣️" />

      <s-section heading="Native language & market defaults">
        <p style={{ marginBottom: 12 }}>
          Your store's <strong>native language</strong> is the language content is written in and
          the one buyers fall back to when nothing else matches. Every translation is generated
          from it. It should be English.
        </p>

        {primaryIsEnglish ? (
          <p style={{ marginBottom: 12 }}>
            Native language:{" "}
            <span style={badge("#0052cc")}>{primaryName} ({primaryLocale})</span> ✓
          </p>
        ) : (
          <s-banner tone="critical">
            <p>
              Your store's primary language is <strong>{primaryName} ({primaryLocale})</strong>, not
              English. That makes {primaryName} — not English — the native/fallback language. The API
              can't change a store's primary language; fix it in{" "}
              <strong>Shopify admin → Settings → Languages</strong> (set English as the default
              language), then come back here.
            </p>
          </s-banner>
        )}

        {fetcher.data?.ok && (
          <s-banner tone="success"><p>Market default language updated.</p></s-banner>
        )}
        {fetcher.data && fetcher.data.ok === false && (
          <s-banner tone="critical"><p>{fetcher.data.error}</p></s-banner>
        )}

        <p style={{ margin: "12px 0 8px", color: "#555" }}>
          Each market has its own default language. If a market's default isn't your native
          language, visitors to that market whose language isn't matched will see that language
          instead — this is the usual cause of a store unexpectedly showing French (or another
          language). A dedicated single-country market (e.g. a France-only market) defaulting to
          that country's language is fine and can be left as-is.
        </p>

        {marketDefaults.length === 0 ? (
          <p style={{ color: "#999" }}>No market web presences found.</p>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ borderBottom: "1px solid #e0e0e0" }}>
                <Th>Market</Th>
                <Th>Default (fallback) language</Th>
                <Th>Fix</Th>
              </tr>
            </thead>
            <tbody>
              {marketDefaults.map((m) => (
                <tr key={m.webPresenceId} style={{ borderBottom: "1px solid #f0f0f0" }}>
                  <Td>
                    {m.name}
                    {m.primaryMarket && (
                      <span style={{ marginLeft: 8, fontSize: 11, color: "#0052cc" }}>Primary</span>
                    )}
                  </Td>
                  <Td>
                    {m.isNative ? (
                      <span style={badge("#1a7f37")}>{m.defaultLocale} · native ✓</span>
                    ) : (
                      <span style={badge("#b42318")}>{m.defaultLocale ?? "—"}</span>
                    )}
                  </Td>
                  <Td>
                    {m.isNative ? (
                      <span style={{ color: "#999", fontSize: 13 }}>—</span>
                    ) : m.primaryMarket ? (
                      <span style={{ color: "#999", fontSize: 13 }}>
                        Change in Settings → Languages
                      </span>
                    ) : (
                      <s-button
                        variant="primary"
                        disabled={isLoading || !primaryIsEnglish}
                        onClick={() =>
                          fetcher.submit(
                            {
                              intent: "reset_market_default",
                              webPresenceId: m.webPresenceId,
                              toLocale: primaryLocale,
                              currentDefault: m.defaultLocale ?? "",
                              alternateLocales: JSON.stringify(m.alternateLocales),
                            },
                            { method: "post" }
                          )
                        }
                      >
                        Set to {primaryName} ({primaryLocale})
                      </s-button>
                    )}
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {offenders.length === 0 && marketDefaults.length > 0 && (
          <p style={{ marginTop: 10, color: "#1a7f37" }}>
            Every market defaults to your native language. Nothing to fix. ✓
          </p>
        )}
      </s-section>

      <s-section heading="Add a language">
        {addable.length === 0 ? (
          <p>All available locales are already enabled on this shop.</p>
        ) : (
          <s-stack direction="inline" gap="base">
            <select
              value={selected}
              onChange={(e) => setSelected(e.target.value)}
              style={{ padding: "8px", minWidth: "260px" }}
            >
              {addable.map((l) => (
                <option key={l.code} value={l.code}>
                  {l.name} ({l.code})
                </option>
              ))}
            </select>
            <s-button
              variant="primary"
              disabled={!selected}
              onClick={() =>
                fetcher.submit({ intent: "enable", locale: selected }, { method: "post" })
              }
            >
              Enable language
            </s-button>
          </s-stack>
        )}
        <p style={{ marginTop: "12px", color: "#666", fontSize: "13px" }}>
          After enabling a language, go to{" "}
          <a href="/app/translate">Translate content</a> to generate translations, then
          publish the locale when ready for buyers.
        </p>
      </s-section>

      <s-section heading="Enabled languages">
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr style={{ borderBottom: "1px solid #e0e0e0" }}>
              <Th>Language</Th>
              <Th>Code</Th>
              <Th>Status</Th>
              <Th>Translate</Th>
              <Th>Visibility</Th>
            </tr>
          </thead>
          <tbody>
            {shopLocales.map((l) => (
              <tr key={l.locale} style={{ borderBottom: "1px solid #f0f0f0" }}>
                <Td>{l.name}</Td>
                <Td><code>{l.locale}</code></Td>
                <Td>
                  <StatusBadge primary={l.primary} published={l.published} />
                </Td>
                <Td>
                  {!l.primary && (
                    <a href={`/app/translate?locale=${l.locale}`}>Translate content →</a>
                  )}
                </Td>
                <Td>
                  {!l.primary && (
                    <s-button
                      variant="secondary"
                      onClick={() =>
                        fetcher.submit(
                          { intent: "publish", locale: l.locale, published: String(!l.published) },
                          { method: "post" }
                        )
                      }
                    >
                      {l.published ? "Unpublish" : "Publish"}
                    </s-button>
                  )}
                </Td>
              </tr>
            ))}
          </tbody>
        </table>
      </s-section>

      <s-section heading="How language switching works on your storefront">
        <p>
          Add the <strong>Language &amp; Country Selector</strong> app block to your theme via{" "}
          <strong>Online Store → Themes → Customize</strong>. The block shows a dropdown and
          automatically redirects visitors based on their detected country.
        </p>
        <p style={{ marginTop: "8px", color: "#666", fontSize: "13px" }}>
          Only published locales appear in the storefront selector. Draft locales are invisible to buyers.
        </p>
      </s-section>
    </s-page>
  );
}

function StatusBadge({ primary, published }) {
  if (primary) return <span style={badge("#0052cc")}>Primary</span>;
  if (published) return <span style={badge("#1a7f37")}>Published</span>;
  return <span style={badge("#999")}>Draft</span>;
}

function badge(color) {
  return {
    display: "inline-block",
    padding: "2px 8px",
    borderRadius: "12px",
    fontSize: "12px",
    fontWeight: 500,
    color: "#fff",
    background: color,
  };
}

function Th({ children }) {
  return <th style={{ textAlign: "left", padding: "8px 12px", fontSize: "13px", color: "#666" }}>{children}</th>;
}
function Td({ children }) {
  return <td style={{ padding: "8px 12px", fontSize: "14px" }}>{children}</td>;
}
