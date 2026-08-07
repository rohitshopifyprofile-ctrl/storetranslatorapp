import { useState, useEffect } from "react";
import { useLoaderData, useFetcher } from "react-router";
import { authenticate } from "../shopify.server";
import {
  getUntranslatedContent,
  registerTranslations,
  listShopLocales,
  getShopGid,
} from "../lib/shopify-translations.server";
import { translateFields, countWords } from "../lib/translation-provider.server";
import { translateWholeStore } from "../lib/auto-translate.server";
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
  return { locale, resourceTypes: RESOURCE_TYPES, shopLocales: nonPrimaryLocales, initialJob };
}

export async function action({ request }) {
  const { admin, session } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = formData.get("intent");

  // "Translate whole store" — sweep every content type × every published
  // language in the background (products, theme UI/buttons/checkout, collections,
  // pages, policies, metafields, etc.). Returns immediately; runs async.
  if (intent === "translate_whole_store") {
    const job = await db.translationJob.create({
      data: { shop: session.shop, resourceType: "ALL", targetLocale: "ALL", status: "running" },
    });
    translateWholeStore(admin, session.shop, job.id).catch(async (error) => {
      await db.translationJob
        .update({ where: { id: job.id }, data: { status: "failed", errorMessage: String(error?.message || error) } })
        .catch(() => {});
    });
    return { ok: true, sweepStarted: true };
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
  const { locale, resourceTypes, shopLocales, initialJob } = useLoaderData();
  const fetcher = useFetcher();
  const progress = useFetcher();
  const [targetLocale, setTargetLocale] = useState(locale || shopLocales[0]?.locale || "");
  const [resourceType, setResourceType] = useState(resourceTypes[0].value);

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
    <s-page heading="Translate content">
      <s-section heading="Translate whole store">
        <p style={{ color: "#555", marginBottom: "12px" }}>
          Translate <strong>everything</strong> into all your published languages in one go —
          products, product-page templates, buttons, checkout labels (theme UI), collections,
          pages, policies, and 3rd-party app content (metafields &amp; metaobjects). Run this at
          setup and whenever you add a new language.
        </p>
        <s-button
          variant="primary"
          disabled={isRunning || jobRunning}
          onClick={() => fetcher.submit({ intent: "translate_whole_store" }, { method: "post" })}
        >
          {jobRunning ? "Translating…" : isRunning ? "Starting…" : "Translate whole store"}
        </s-button>

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
