import { useState } from "react";
import { useLoaderData, useFetcher } from "react-router";
import { authenticate } from "../shopify.server";
import {
  getUntranslatedContent,
  registerTranslations,
  listShopLocales,
  getShopGid,
} from "../lib/shopify-translations.server";
import { translateFields, countWords } from "../lib/translation-provider.server";
import { reportWordsTranslated } from "../lib/billing-events.server";
import { glossaryForLocale } from "../lib/glossary.server";
import db from "../db.server";

// Full coverage:
//   • Core product content
//   • All online store content (pages, blogs, theme, menus, shop details)
//   • Shop policies and communication templates
//   • Third-party app content via metafields and metaobjects
//
// Shopify's Translations API handles any of these: as long as the source app
// stores its content in Shopify metafields/metaobjects, it will appear here.
const RESOURCE_TYPES = [
  // ── Core product content ────────────────────────────────────
  { value: "PRODUCT", label: "Products (title, description, SEO)", group: "Products" },
  { value: "PRODUCT_VARIANT", label: "Product variants (option names)", group: "Products" },
  { value: "PRODUCT_OPTION", label: "Product options (Size, Color…)", group: "Products" },
  { value: "COLLECTION", label: "Collections (title, description)", group: "Products" },
  // ── Online store ────────────────────────────────────────────
  { value: "ONLINE_STORE_PAGE", label: "Pages", group: "Online Store" },
  { value: "ONLINE_STORE_ARTICLE", label: "Blog posts", group: "Online Store" },
  { value: "ONLINE_STORE_BLOG", label: "Blog titles", group: "Online Store" },
  { value: "ONLINE_STORE_MENU", label: "Navigation menus", group: "Online Store" },
  { value: "ONLINE_STORE_SHOP", label: "Shop name & description", group: "Online Store" },
  { value: "ONLINE_STORE_THEME", label: "Theme UI strings (buttons, labels, checkout text)", group: "Online Store" },
  // ── Policies & checkout ─────────────────────────────────────
  { value: "SHOP_POLICY", label: "Shop policies (refund, privacy, TOS)", group: "Policies" },
  { value: "EMAIL_TEMPLATE", label: "Email templates", group: "Policies" },
  { value: "PACKING_SLIP_TEMPLATE", label: "Packing slip template", group: "Policies" },
  // ── Third-party app content ─────────────────────────────────
  { value: "METAFIELD", label: "Metafields (Kaching, review apps, upsell apps…)", group: "Third-party Apps" },
  { value: "METAOBJECT", label: "Metaobjects (custom structured content)", group: "Third-party Apps" },
  // ── Other ───────────────────────────────────────────────────
  { value: "PAYMENT_GATEWAY", label: "Payment gateway names", group: "Other" },
  { value: "DELIVERY_METHOD_DEFINITION", label: "Delivery method names", group: "Other" },
];

const BATCH_SIZE = 10;

export async function loader({ request }) {
  const { admin } = await authenticate.admin(request);
  const url = new URL(request.url);
  const locale = url.searchParams.get("locale") || "";
  const shopLocales = await listShopLocales(admin);
  const nonPrimaryLocales = shopLocales.filter((l) => !l.primary);
  return { locale, resourceTypes: RESOURCE_TYPES, shopLocales: nonPrimaryLocales };
}

export async function action({ request }) {
  const { admin, session } = await authenticate.admin(request);
  const formData = await request.formData();
  const targetLocale = formData.get("locale");
  const resourceType = formData.get("resourceType");

  const job = await db.translationJob.create({
    data: { shop: session.shop, resourceType, targetLocale, status: "running" },
  });

  try {
    const [glossary, settings] = await Promise.all([
      glossaryForLocale(session.shop, targetLocale),
      db.shopSettings.upsert({
        where: { shop: session.shop },
        update: {},
        create: { shop: session.shop },
      }),
    ]);

    const sourceLocale = settings.sourceLocale ?? "en";

    const { resources, hasNextPage } = await getUntranslatedContent(admin, {
      resourceType,
      locale: targetLocale,
      first: BATCH_SIZE,
    });

    let wordsTranslated = 0;

    for (const resource of resources) {
      // Skip resources with no text content (e.g. image-only metafields)
      const textFields = resource.pending.filter((c) => c.value && c.value.trim().length > 0);
      if (textFields.length === 0) continue;

      const translated = await translateFields({
        texts: textFields.map((c) => ({ key: c.key, value: c.value })),
        sourceLocale,
        targetLocale,
        glossary,
      });

      const translationInputs = translated.map((t) => {
        const original = textFields.find((c) => c.key === t.key);
        return {
          locale: targetLocale,
          key: t.key,
          value: t.value,
          translatableContentDigest: original.digest,
        };
      });

      await registerTranslations(admin, resource.resourceId, translationInputs);
      wordsTranslated += countWords(textFields);
    }

    await db.translationJob.update({
      where: { id: job.id },
      data: {
        status: "completed",
        totalResources: resources.length,
        wordsTranslated,
        completedAt: new Date(),
      },
    });

    // Report usage for billing
    if (wordsTranslated > 0) {
      let shopSettings = await db.shopSettings.findUnique({ where: { shop: session.shop } });
      if (!shopSettings?.shopGid) {
        const shopGid = await getShopGid(admin);
        shopSettings = await db.shopSettings.update({
          where: { shop: session.shop },
          data: { shopGid },
        });
      }
      await reportWordsTranslated({ shopId: shopSettings.shopGid, wordCount: wordsTranslated });
    }

    return { ok: true, resourcesTranslated: resources.length, wordsTranslated, hasNextPage };
  } catch (error) {
    await db.translationJob.update({
      where: { id: job.id },
      data: { status: "failed", errorMessage: String(error.message || error) },
    });
    return { ok: false, error: String(error.message || error) };
  }
}

// Group resource types for the select options
function groupedTypes(types) {
  const groups = {};
  for (const t of types) {
    if (!groups[t.group]) groups[t.group] = [];
    groups[t.group].push(t);
  }
  return Object.entries(groups);
}

export default function Translate() {
  const { locale, resourceTypes, shopLocales } = useLoaderData();
  const fetcher = useFetcher();
  const [targetLocale, setTargetLocale] = useState(locale || shopLocales[0]?.locale || "");
  const [resourceType, setResourceType] = useState(resourceTypes[0].value);

  const isRunning = fetcher.state !== "idle";
  const result = fetcher.data;

  return (
    <s-page heading="Translate content">
      <s-section heading="Run a translation batch">
        <p style={{ color: "#555", marginBottom: "16px" }}>
          Each batch translates up to {BATCH_SIZE} items. Click <em>Translate next {BATCH_SIZE}</em> repeatedly
          until the banner says there's nothing left.
        </p>

        <s-stack direction="block" gap="base">
          <div>
            <label style={labelStyle}>Target language</label>
            {shopLocales.length > 0 ? (
              <select
                value={targetLocale}
                onChange={(e) => setTargetLocale(e.target.value)}
                style={inputStyle}
              >
                {shopLocales.map((l) => (
                  <option key={l.locale} value={l.locale}>
                    {l.name} ({l.locale})
                  </option>
                ))}
              </select>
            ) : (
              <input
                type="text"
                value={targetLocale}
                onChange={(e) => setTargetLocale(e.target.value)}
                placeholder="e.g. fr, es-MX, de"
                style={inputStyle}
              />
            )}
          </div>

          <div>
            <label style={labelStyle}>Content type</label>
            <select
              value={resourceType}
              onChange={(e) => setResourceType(e.target.value)}
              style={inputStyle}
            >
              {groupedTypes(resourceTypes).map(([group, items]) => (
                <optgroup key={group} label={group}>
                  {items.map((r) => (
                    <option key={r.value} value={r.value}>
                      {r.label}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </div>

          <s-button
            variant="primary"
            disabled={!targetLocale || isRunning}
            onClick={() =>
              fetcher.submit({ locale: targetLocale, resourceType }, { method: "post" })
            }
          >
            {isRunning ? "Translating…" : `Translate next ${BATCH_SIZE}`}
          </s-button>

          {result?.ok && (
            <s-banner tone="success">
              <p>
                Translated <strong>{result.resourcesTranslated}</strong> item(s),{" "}
                <strong>{result.wordsTranslated}</strong> words.
                {result.hasNextPage
                  ? " Click again to process the next batch."
                  : " All done — no more items to translate for this content type."}
              </p>
            </s-banner>
          )}

          {result && !result.ok && (
            <s-banner tone="critical">
              <p>{result.error}</p>
            </s-banner>
          )}
        </s-stack>
      </s-section>

      <s-section heading="Third-party app content">
        <p>
          Apps like <strong>Kaching Bundles</strong>, <strong>review apps</strong>, and
          {" "}<strong>post-purchase extensions</strong> that store their content in Shopify
          metafields or metaobjects are automatically translated when you select{" "}
          <em>Metafields</em> or <em>Metaobjects</em> above.
        </p>
        <p style={{ marginTop: "8px", color: "#666" }}>
          Apps that store content in their own external database cannot be translated through
          Shopify's Translations API — those apps must integrate with the API themselves.
        </p>
      </s-section>
    </s-page>
  );
}

const labelStyle = { display: "block", marginBottom: "4px", fontWeight: 500 };
const inputStyle = { padding: "8px", width: "100%", maxWidth: "420px", display: "block" };
