import { useState } from "react";
import { AppHero } from "../components/ui";
import { useLoaderData, useNavigate, useNavigation } from "react-router";
import { authenticate } from "../shopify.server";
import {
  getTranslationsForReview,
  listShopLocales,
} from "../lib/shopify-translations.server";

// Keep this list aligned with the Translate page's most-reviewed types.
const RESOURCE_TYPES = [
  { value: "PRODUCT", label: "Products" },
  { value: "COLLECTION", label: "Collections" },
  { value: "PAGE", label: "Pages" },
  { value: "ARTICLE", label: "Blog posts" },
  { value: "SHOP", label: "Shop name & description" },
  { value: "ONLINE_STORE_THEME", label: "Theme UI strings" },
  { value: "SHOP_POLICY", label: "Shop policies" },
  { value: "METAFIELD", label: "Metafields (3rd-party apps)" },
  { value: "METAOBJECT", label: "Metaobjects" },
];

// Human-friendly labels for the raw translatable keys Shopify returns.
const KEY_LABELS = {
  title: "Title",
  body_html: "Description",
  handle: "URL handle",
  product_type: "Product type",
  meta_title: "SEO title",
  meta_description: "SEO description",
  summary_html: "Summary",
  label: "Label",
};

export async function loader({ request }) {
  const { admin } = await authenticate.admin(request);
  const url = new URL(request.url);
  const shopLocales = await listShopLocales(admin);
  const nonPrimary = shopLocales.filter((l) => !l.primary);

  const locale = url.searchParams.get("locale") || nonPrimary[0]?.locale || "";
  const resourceType = url.searchParams.get("resourceType") || "PRODUCT";

  let resources = [];
  if (locale) {
    const result = await getTranslationsForReview(admin, { resourceType, locale });
    resources = result.resources;
  }

  return { locale, resourceType, resources, shopLocales: nonPrimary, resourceTypes: RESOURCE_TYPES };
}

function truncate(html, n = 400) {
  if (!html) return "";
  // Strip tags for a readable side-by-side comparison.
  const text = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  return text.length > n ? text.slice(0, n) + "…" : text;
}

export default function Review() {
  const { locale, resourceType, resources, shopLocales, resourceTypes } = useLoaderData();
  const navigate = useNavigate();
  const navigation = useNavigation();
  const isLoading = navigation.state === "loading";

  const [pendingLocale, setPendingLocale] = useState(locale);
  const [pendingType, setPendingType] = useState(resourceType);

  function applyFilters(nextLocale, nextType) {
    const params = new URLSearchParams();
    params.set("locale", nextLocale);
    params.set("resourceType", nextType);
    navigate(`/app/review?${params.toString()}`);
  }

  const translatedCount = resources.reduce(
    (n, r) => n + r.fields.filter((f) => f.translated).length,
    0,
  );
  const totalCount = resources.reduce((n, r) => n + r.fields.length, 0);

  return (
    <s-page>
      <AppHero title="Review translations" subtitle="Compare source and translated content side by side." emoji="🔍" />
      <s-section heading="Preview & verify accuracy">
        <p style={{ color: "#555", marginBottom: "16px" }}>
          Compare the original content with its translation, field by field. Fields showing{" "}
          <em>Not translated yet</em> still need a batch run on the Translate page.
        </p>

        <s-stack direction="inline" gap="base">
          <div>
            <label style={labelStyle}>Language</label>
            {shopLocales.length > 0 ? (
              <select
                value={pendingLocale}
                onChange={(e) => {
                  setPendingLocale(e.target.value);
                  applyFilters(e.target.value, pendingType);
                }}
                style={inputStyle}
              >
                {shopLocales.map((l) => (
                  <option key={l.locale} value={l.locale}>
                    {l.name} ({l.locale})
                  </option>
                ))}
              </select>
            ) : (
              <p>No secondary languages enabled. Enable one on the Languages page first.</p>
            )}
          </div>

          <div>
            <label style={labelStyle}>Content type</label>
            <select
              value={pendingType}
              onChange={(e) => {
                setPendingType(e.target.value);
                applyFilters(pendingLocale, e.target.value);
              }}
              style={inputStyle}
            >
              {resourceTypes.map((r) => (
                <option key={r.value} value={r.value}>
                  {r.label}
                </option>
              ))}
            </select>
          </div>
        </s-stack>

        {locale && (
          <p style={{ margin: "12px 0", color: "#666", fontSize: 13 }}>
            {isLoading
              ? "Loading…"
              : `${translatedCount} of ${totalCount} field(s) translated across ${resources.length} item(s).`}
          </p>
        )}
      </s-section>

      {!isLoading && resources.length === 0 && (
        <s-section>
          <s-banner tone="info">
            <p>No translatable content found for this content type.</p>
          </s-banner>
        </s-section>
      )}

      {resources.map((resource, idx) => (
        <s-section key={resource.resourceId} heading={`Item ${idx + 1}`}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ borderBottom: "1px solid #e0e0e0" }}>
                <Th style={{ width: "15%" }}>Field</Th>
                <Th style={{ width: "42%" }}>Original</Th>
                <Th style={{ width: "43%" }}>{locale}</Th>
              </tr>
            </thead>
            <tbody>
              {resource.fields.map((f) => (
                <tr key={f.key} style={{ borderBottom: "1px solid #f0f0f0", verticalAlign: "top" }}>
                  <Td><strong>{KEY_LABELS[f.key] || f.key}</strong></Td>
                  <Td style={{ color: "#444" }}>{truncate(f.source)}</Td>
                  <Td>
                    {f.translated ? (
                      <span>
                        {truncate(f.translated)}
                        {f.outdated && (
                          <span style={{ marginLeft: 6, fontSize: 11, color: "#b26200" }}>
                            (outdated — source changed)
                          </span>
                        )}
                      </span>
                    ) : (
                      <span style={{ color: "#b12a2a", fontStyle: "italic" }}>Not translated yet</span>
                    )}
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
        </s-section>
      ))}
    </s-page>
  );
}

const labelStyle = { display: "block", marginBottom: "4px", fontWeight: 500 };
const inputStyle = { padding: "8px", minWidth: "220px", display: "block" };

function Th({ children, style }) {
  return <th style={{ textAlign: "left", padding: "8px 12px", fontSize: 13, color: "#666", ...style }}>{children}</th>;
}
function Td({ children, style }) {
  return <td style={{ padding: "8px 12px", fontSize: 14, lineHeight: 1.5, ...style }}>{children}</td>;
}
