import { useState, useEffect } from "react";
import { AppHero } from "../components/ui";
import { useLoaderData, useFetcher } from "react-router";
import { authenticate } from "../shopify.server";
import {
  getUntranslatedContent,
  registerTranslations,
  listShopLocales,
  getShopGid,
  getResourceReview,
} from "../lib/shopify-translations.server";
import { translateFields, countWords } from "../lib/translation-provider.server";
import { translateWholeStore, autoTranslateResource } from "../lib/auto-translate.server";
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
// Values must be valid Shopify TranslatableResourceType enum members.
const RESOURCE_TYPES = [
  // ── Core product content ────────────────────────────────────
  { value: "PRODUCT", label: "Products (title, description, SEO)", group: "Products" },
  { value: "PRODUCT_OPTION", label: "Product options (Size, Color…)", group: "Products" },
  { value: "PRODUCT_OPTION_VALUE", label: "Product option values (Small, Red…)", group: "Products" },
  { value: "COLLECTION", label: "Collections (title, description)", group: "Products" },
  // ── Online store ────────────────────────────────────────────
  { value: "PAGE", label: "Pages", group: "Online Store" },
  { value: "ARTICLE", label: "Blog posts", group: "Online Store" },
  { value: "BLOG", label: "Blog titles", group: "Online Store" },
  { value: "MENU", label: "Navigation menus", group: "Online Store" },
  { value: "SHOP", label: "Shop name & description", group: "Online Store" },
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
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;
  const url = new URL(request.url);
  const locale = url.searchParams.get("locale") || "";
  const shopLocales = await listShopLocales(admin);
  const nonPrimaryLocales = shopLocales.filter((l) => !l.primary);
  // Latest whole-store job, so the progress bar shows even after a page reload.
  const job = await db.translationJob.findFirst({
    where: { shop: session.shop, resourceType: "ALL" },
    orderBy: { createdAt: "desc" },
  });
  const initialJob = job
    ? {
        status: job.status,
        stepsTotal: job.stepsTotal,
        stepsDone: job.stepsDone,
        currentStep: job.currentStep,
        wordsTranslated: job.wordsTranslated,
        errorMessage: job.errorMessage,
      }
    : null;
  const provider = process.env.TRANSLATION_PROVIDER === "deepl" ? "DeepL" : "Claude";
  return { locale, resourceTypes: RESOURCE_TYPES, shopLocales: nonPrimaryLocales, initialJob, provider, shop };
}

export async function action({ request }) {
  const { admin, session } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = formData.get("intent");

  // "Translate whole store" — sweep every content type × every published
  // language in the background (products, theme UI/buttons/checkout, collections,
  // pages, policies, metafields, etc.). Returns immediately; runs async.
  if (intent === "translate_whole_store") {
    // Supersede any previous sweep that's stuck "running" (e.g. a background job
    // that stalled/was killed), so it can't block the UI or double-run.
    await db.translationJob.updateMany({
      where: { shop: session.shop, resourceType: "ALL", status: "running" },
      data: { status: "failed", errorMessage: "superseded by a new run" },
    });
    // Optional locale scope: comma-separated list from the language picker.
    const localesRaw = formData.get("locales");
    const onlyLocales = localesRaw ? String(localesRaw).split(",").map((s) => s.trim()).filter(Boolean) : null;
    const overwrite = formData.get("overwrite") === "true";
    const job = await db.translationJob.create({
      data: {
        shop: session.shop,
        resourceType: "ALL",
        targetLocale: onlyLocales && onlyLocales.length ? onlyLocales.join(",") : "ALL",
        status: "running",
      },
    });
    translateWholeStore(admin, session.shop, job.id, onlyLocales, overwrite).catch(async (error) => {
      await db.translationJob
        .update({ where: { id: job.id }, data: { status: "failed", errorMessage: String(error?.message || error) } })
        .catch(() => {});
    });
    return { ok: true, sweepStarted: true };
  }

  // Translate ONE product (small, so we run it inline and return a preview).
  if (intent === "translate_one_product") {
    const productId = formData.get("productId");
    const handle = formData.get("handle") || "";
    const localesRaw = formData.get("locales");
    const onlyLocales = localesRaw ? String(localesRaw).split(",").map((s) => s.trim()).filter(Boolean) : null;
    const overwrite = formData.get("overwrite") === "true";
    if (!productId) return { ok: false, error: "Pick a product first." };
    try {
      await autoTranslateResource(admin, session.shop, productId, onlyLocales, overwrite);
      const locales =
        onlyLocales && onlyLocales.length
          ? onlyLocales
          : (await listShopLocales(admin)).filter((l) => !l.primary).map((l) => l.locale);
      const preview = [];
      for (const loc of locales) {
        const fields = await getResourceReview(admin, productId, loc);
        preview.push({ locale: loc, fields: fields.slice(0, 3) });
      }
      return { ok: true, productTranslated: true, handle, preview };
    } catch (error) {
      return { ok: false, error: String(error?.message || error) };
    }
  }

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

      const translationInputs = [];
      const done = [];
      for (const t of translated) {
        const original = textFields.find((c) => c.key === t.key);
        if (!original || t.value == null || t.value === original.value) continue; // skip failed/same-as-source
        translationInputs.push({
          locale: targetLocale,
          key: t.key,
          value: t.value,
          translatableContentDigest: original.digest,
        });
        done.push(original);
      }

      if (translationInputs.length > 0) {
        await registerTranslations(admin, resource.resourceId, translationInputs);
        wordsTranslated += countWords(done);
      }
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

// Flag emoji per locale (language → a representative region). Falls back to 🌐.
const FLAGS = {
  en: "🇬🇧", "en-US": "🇺🇸", fr: "🇫🇷", de: "🇩🇪", "de-AT": "🇦🇹", es: "🇪🇸", "es-MX": "🇲🇽",
  it: "🇮🇹", nl: "🇳🇱", sv: "🇸🇪", nb: "🇳🇴", no: "🇳🇴", da: "🇩🇰", fi: "🇫🇮", pt: "🇵🇹",
  "pt-BR": "🇧🇷", pl: "🇵🇱", cs: "🇨🇿", ja: "🇯🇵", "zh-CN": "🇨🇳", "zh-TW": "🇹🇼", ko: "🇰🇷",
  ru: "🇷🇺", ar: "🇸🇦", tr: "🇹🇷", hi: "🇮🇳", el: "🇬🇷", he: "🇮🇱", uk: "🇺🇦", ro: "🇷🇴", hu: "🇭🇺",
};
const flagFor = (loc) => FLAGS[loc] || FLAGS[loc?.split("-")[0]] || "🌐";

const KEY_LABELS = { title: "Title", body_html: "Description", meta_title: "SEO title", meta_description: "SEO description", handle: "Handle" };
function stripHtml(s, n = 120) {
  if (!s) return "";
  const t = s.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n) + "…" : t;
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
  const { locale, resourceTypes, shopLocales, initialJob, provider, shop } = useLoaderData();
  const fetcher = useFetcher();
  const progress = useFetcher();
  const productFetcher = useFetcher();
  const [selectedProduct, setSelectedProduct] = useState(null); // { id, handle, title }
  const productRunning = productFetcher.state !== "idle";
  const productResult = productFetcher.data;

  async function pickProduct() {
    try {
      const sel = await window.shopify.resourcePicker({ type: "product", multiple: false, action: "select" });
      if (sel && sel.length) setSelectedProduct({ id: sel[0].id, handle: sel[0].handle, title: sel[0].title });
    } catch (_) { /* picker dismissed */ }
  }
  const [targetLocale, setTargetLocale] = useState(locale || shopLocales[0]?.locale || "");
  const [resourceType, setResourceType] = useState(resourceTypes[0].value);
  // Which languages the whole-store sweep should cover (default: all).
  const [sweepLocales, setSweepLocales] = useState(() => shopLocales.map((l) => l.locale));
  const [overwrite, setOverwrite] = useState(false);
  const toggleSweepLocale = (loc) =>
    setSweepLocales((prev) => (prev.includes(loc) ? prev.filter((l) => l !== loc) : [...prev, loc]));
  const allSelected = sweepLocales.length === shopLocales.length && shopLocales.length > 0;

  const isRunning = fetcher.state !== "idle";
  const result = fetcher.data;

  // Live job = freshest of (polled) or (initial from loader).
  const job = progress.data?.job ?? initialJob;
  const jobRunning = job?.status === "running";

  // Poll the progress endpoint while a sweep is running (or just started).
  useEffect(() => {
    if (!jobRunning && !result?.sweepStarted) return;
    const id = setInterval(() => progress.load("/app/translate/progress"), 3000);
    progress.load("/app/translate/progress");
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobRunning, result?.sweepStarted]);

  const pct = job && job.stepsTotal > 0 ? Math.round((job.stepsDone / job.stepsTotal) * 100) : 0;

  return (
    <s-page>
      <AppHero title="Translate content" subtitle="Translate your whole store, a single product, or one content type at a time." emoji="✨" />
      <s-section heading="Translate whole store">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12 }}>
          <p style={{ color: "var(--p-color-text-secondary, #6d7175)", marginTop: 0, marginBottom: 16, maxWidth: 640 }}>
            Translate <strong>all content</strong> — products, product-page templates, buttons &amp;
            checkout labels (theme UI), collections, pages, policies, and 3rd-party app content
            (metafields &amp; metaobjects) — into the languages you pick.
          </p>
          <span style={engineBadge}>✦ AI engine · {provider === "DeepL" ? "DeepL" : "Claude"}</span>
        </div>

        {/* Language selection — flag grid + select all */}
        <div style={sectionLabel}>Languages</div>
        <label style={{ ...langRow, fontWeight: 600, borderBottom: "1px solid var(--p-color-border, #e1e3e5)", borderRadius: 0, marginBottom: 8, paddingBottom: 12 }}>
          <input
            type="checkbox"
            checked={allSelected}
            ref={(el) => { if (el) el.indeterminate = !allSelected && sweepLocales.length > 0; }}
            onChange={() => setSweepLocales(allSelected ? [] : shopLocales.map((l) => l.locale))}
          />
          Select all languages
        </label>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(185px, 1fr))", gap: "6px 12px", marginBottom: 4 }}>
          {shopLocales.map((l) => {
            const on = sweepLocales.includes(l.locale);
            return (
              <label key={l.locale} style={{ ...langRow, background: on ? "var(--p-color-bg-surface-success, #eef7f3)" : "transparent" }}>
                <input type="checkbox" checked={on} onChange={() => toggleSweepLocale(l.locale)} />
                <span style={{ fontSize: 16, lineHeight: 1 }}>{flagFor(l.locale)}</span>
                <span style={{ fontWeight: 500 }}>{l.name}</span>
                <span style={{ color: "var(--p-color-text-secondary, #6d7175)", fontSize: 12 }}>{l.locale}</span>
              </label>
            );
          })}
        </div>

        {/* Overwrite option */}
        <div style={{ marginTop: 16, paddingTop: 14, borderTop: "1px solid var(--p-color-border, #e1e3e5)" }}>
          <label style={{ display: "inline-flex", alignItems: "center", gap: 9, cursor: "pointer", fontWeight: 500 }}>
            <input type="checkbox" checked={overwrite} onChange={(e) => setOverwrite(e.target.checked)} />
            Overwrite existing translations
          </label>
          <div style={{ color: "var(--p-color-text-secondary, #6d7175)", fontSize: 12, margin: "3px 0 0 25px" }}>
            Re-translate fields that already have a translation — fixes anything stuck in the source language.
          </div>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 14, marginTop: 18, flexWrap: "wrap" }}>
          <s-button
            variant="primary"
            disabled={isRunning || sweepLocales.length === 0}
            onClick={() =>
              fetcher.submit(
                { intent: "translate_whole_store", locales: sweepLocales.join(","), overwrite: String(overwrite) },
                { method: "post" }
              )
            }
          >
            {isRunning
              ? "Starting…"
              : jobRunning
              ? "Restart / resume"
              : `Translate ${sweepLocales.length} language${sweepLocales.length === 1 ? "" : "s"}`}
          </s-button>
          <span style={{ fontSize: 13, color: "var(--p-color-text-secondary, #6d7175)" }}>
            New &amp; edited products auto-translate going forward.
          </span>
        </div>
        {jobRunning && (
          <p style={{ marginTop: 8, fontSize: 12, color: "var(--p-color-text-secondary, #6d7175)" }}>
            A run is in progress below. If the bar stalls for a few minutes, click{" "}
            <strong>Restart / resume</strong> — it picks up where it left off.
          </p>
        )}

        {job && (job.status === "running" || job.status === "completed") && (
          <div style={{ marginTop: 16, maxWidth: 560 }}>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, marginBottom: 6 }}>
              <span>
                {job.status === "completed" ? "Completed" : "Translating…"}{" "}
                {job.currentStep && job.status === "running" ? `(${job.currentStep})` : ""}
              </span>
              <span>{pct}%</span>
            </div>
            <div style={{ height: 10, background: "#e6e6e6", borderRadius: 6, overflow: "hidden" }}>
              <div
                style={{
                  width: `${pct}%`,
                  height: "100%",
                  background: job.status === "completed" ? "#1a7f37" : "#0a7",
                  transition: "width 0.4s ease",
                }}
              />
            </div>
            <p style={{ marginTop: 6, fontSize: 12, color: "#666" }}>
              {job.stepsDone}/{job.stepsTotal} steps · {job.wordsTranslated?.toLocaleString?.() ?? job.wordsTranslated} words translated
            </p>
          </div>
        )}

        {job?.status === "failed" && (
          <s-banner tone="critical">
            <p>Translation stopped: {job.errorMessage || "unknown error"}. Click Translate whole store to resume.</p>
          </s-banner>
        )}
      </s-section>

      {/* ── Translate a single product (with preview) ── */}
      <s-section heading="Translate a single product">
        <p style={{ color: "var(--p-color-text-secondary, #6d7175)", marginTop: 0, marginBottom: 14, maxWidth: 640 }}>
          Just need one product done (not the whole theme)? Pick a product and translate only its
          content into the languages selected above — then preview the result before anyone sees it.
        </p>

        <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
          <s-button variant="secondary" onClick={pickProduct}>
            {selectedProduct ? "Change product" : "Choose product"}
          </s-button>
          {selectedProduct && (
            <span style={{ fontSize: 14 }}>
              <strong>{selectedProduct.title}</strong>
            </span>
          )}
          <s-button
            variant="primary"
            disabled={!selectedProduct || productRunning || sweepLocales.length === 0}
            onClick={() =>
              productFetcher.submit(
                {
                  intent: "translate_one_product",
                  productId: selectedProduct.id,
                  handle: selectedProduct.handle || "",
                  locales: sweepLocales.join(","),
                  overwrite: String(overwrite),
                },
                { method: "post" }
              )
            }
          >
            {productRunning ? "Translating…" : `Translate this product`}
          </s-button>
        </div>

        {productResult && !productResult.ok && (
          <s-banner tone="critical"><p>{productResult.error}</p></s-banner>
        )}

        {productResult?.ok && productResult.productTranslated && (
          <div style={{ marginTop: 18 }}>
            <div style={sectionLabel}>Preview</div>
            {productResult.preview.map((p) => (
              <div key={p.locale} style={{ border: "1px solid var(--p-color-border, #e1e3e5)", borderRadius: 10, padding: "12px 14px", marginBottom: 10 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                  <span style={{ fontWeight: 600 }}>{flagFor(p.locale)} {p.locale}</span>
                  {productResult.handle && (
                    <a href={`https://${shop}/${p.locale}/products/${productResult.handle}`} target="_blank" rel="noreferrer" style={{ fontSize: 13 }}>
                      View on storefront →
                    </a>
                  )}
                </div>
                {p.fields.length === 0 ? (
                  <p style={{ fontSize: 13, color: "var(--p-color-text-secondary, #6d7175)", margin: 0 }}>No translatable text.</p>
                ) : (
                  p.fields.map((f) => (
                    <div key={f.key} style={{ display: "grid", gridTemplateColumns: "90px 1fr 1fr", gap: 10, fontSize: 13, padding: "4px 0", borderTop: "1px solid var(--p-color-border, #f1f2f3)" }}>
                      <span style={{ color: "var(--p-color-text-secondary, #6d7175)" }}>{KEY_LABELS[f.key] || f.key}</span>
                      <span style={{ color: "var(--p-color-text-secondary, #6d7175)" }}>{stripHtml(f.source)}</span>
                      <span style={{ color: f.translated ? "inherit" : "#b12a2a" }}>{f.translated ? stripHtml(f.translated) : "not translated"}</span>
                    </div>
                  ))
                )}
              </div>
            ))}
          </div>
        )}
      </s-section>

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
const engineBadge = {
  display: "inline-flex", alignItems: "center", gap: 6, whiteSpace: "nowrap",
  background: "var(--p-color-bg-surface-success, #eef7f3)", color: "var(--p-color-text-success, #008060)",
  fontSize: 12, fontWeight: 600, padding: "5px 10px", borderRadius: 20,
};
const sectionLabel = {
  fontSize: 12, fontWeight: 600, textTransform: "uppercase", letterSpacing: ".05em",
  color: "var(--p-color-text-secondary, #6d7175)", margin: "4px 0 10px",
};
const langRow = {
  display: "flex", alignItems: "center", gap: 9, fontSize: 14,
  padding: "7px 9px", borderRadius: 8, cursor: "pointer",
};
