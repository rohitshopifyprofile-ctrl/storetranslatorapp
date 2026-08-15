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

export async function loader({ request }) {
  const { admin } = await authenticate.admin(request);
  const [shopLocales, availableLocales] = await Promise.all([
    listShopLocales(admin),
    listAvailableLocales(admin),
  ]);
  const enabledCodes = new Set(shopLocales.map((l) => l.locale));
  const addable = availableLocales.filter((l) => !enabledCodes.has(l.code));
  return { shopLocales, addable };
}

export async function action({ request }) {
  const { admin } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = formData.get("intent");
  const locale = formData.get("locale");

  if (intent === "enable") {
    await enableLocale(admin, locale);
  } else if (intent === "publish") {
    await setLocalePublished(admin, locale, formData.get("published") === "true");
  }
  return { ok: true };
}

export default function Languages() {
  const { shopLocales, addable } = useLoaderData();
  const fetcher = useFetcher();
  const [selected, setSelected] = useState(addable[0]?.code ?? "");

  return (
    <s-page>
      <AppHero title="Languages" subtitle="Enable, publish and manage the languages your storefront offers." emoji="🗣️" />
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
