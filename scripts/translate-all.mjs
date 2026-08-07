// Standalone whole-store translator. Talks directly to the Shopify Admin API
// with the app's offline token, so it doesn't depend on the (flaky) dev tunnel.
// HTTP goes through curl (Node's fetch/undici hangs on reused connections in
// this environment; curl is reliable). Env: SHOP, TOKEN, ANTHROPIC_API_KEY,
// [ONLY_TYPES], [ONLY_LOCALES]
import { execFileSync } from "node:child_process";

// POST JSON via curl; returns the response body string. Throws on network
// failure/timeout (non-zero curl exit) so callers can retry.
function curlPost(url, headers, bodyObj, timeoutSec) {
  const args = ["-sS", "-m", String(timeoutSec), "-X", "POST", url];
  for (const [k, v] of Object.entries(headers)) args.push("-H", `${k}: ${v}`);
  args.push("--data-binary", "@-");
  return execFileSync("curl", args, {
    input: JSON.stringify(bodyObj),
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
}

const SHOP = process.env.SHOP;
const TOKEN = process.env.TOKEN;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const API_VERSION = "2026-07";
const ADMIN_URL = `https://${SHOP}/admin/api/${API_VERSION}/graphql.json`;

const SKIP_KEYS = new Set(["handle"]);
const MAX_CHARS_PER_CHUNK = 6000;
const REGISTER_BATCH = 50;

const ALL_TYPES = (process.env.ONLY_TYPES || [
  "PRODUCT", "COLLECTION", "PAGE", "ARTICLE", "BLOG", "MENU", "SHOP", "SHOP_POLICY",
  "ONLINE_STORE_THEME", "ONLINE_STORE_THEME_JSON_TEMPLATE", "ONLINE_STORE_THEME_LOCALE_CONTENT",
  "ONLINE_STORE_THEME_SECTION_GROUP", "ONLINE_STORE_THEME_SETTINGS_CATEGORY",
  "ONLINE_STORE_THEME_SETTINGS_DATA_SECTIONS", "ONLINE_STORE_THEME_APP_EMBED",
  "EMAIL_TEMPLATE", "PACKING_SLIP_TEMPLATE", "PAYMENT_GATEWAY", "DELIVERY_METHOD_DEFINITION",
  "METAFIELD", "METAOBJECT",
].join(",")).split(",").map((s) => s.trim()).filter(Boolean);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function shopify(query, variables) {
  for (let attempt = 0; attempt < 8; attempt++) {
    let out;
    try {
      out = curlPost(ADMIN_URL, { "Content-Type": "application/json", "X-Shopify-Access-Token": TOKEN }, { query, variables }, 45);
    } catch (e) {
      await sleep(2000 * (attempt + 1)); continue; // curl network failure/timeout → retry
    }
    let json;
    try { json = JSON.parse(out); }
    catch { await sleep(1500 * (attempt + 1)); continue; } // partial/empty body → retry
    if (json.errors) {
      const throttled = JSON.stringify(json.errors).includes("THROTTLED");
      if (throttled) { await sleep(2000 * (attempt + 1)); continue; }
      throw new Error("GraphQL: " + JSON.stringify(json.errors).slice(0, 200));
    }
    return json.data;
  }
  throw new Error("GraphQL: network/throttle failure after retries");
}

async function publishedLocales() {
  const d = await shopify(`{ shopLocales { locale primary published } }`);
  let locales = d.shopLocales.filter((l) => l.published && !l.primary).map((l) => l.locale);
  // Optional ONLY_LOCALES filter, so a run can be scoped to fit inside the
  // ~1-hour token window (the token doesn't refresh mid-run).
  if (process.env.ONLY_LOCALES) {
    const want = new Set(process.env.ONLY_LOCALES.split(",").map((s) => s.trim()));
    locales = locales.filter((l) => want.has(l));
  }
  return locales;
}

const CONTENT_Q = `query($t:TranslatableResourceType!,$first:Int!,$after:String,$locale:String!){
  translatableResources(resourceType:$t,first:$first,after:$after){
    pageInfo{hasNextPage endCursor}
    nodes{ resourceId
      translatableContent{key value digest}
      translations(locale:$locale){key value outdated} } } }`;

const REGISTER_M = `mutation($id:ID!,$translations:[TranslationInput!]!){
  translationsRegister(resourceId:$id,translations:$translations){ userErrors{message} } }`;

function chunk(texts, maxChars) {
  const out = []; let cur = [], len = 0;
  for (const t of texts) {
    const l = (t.value || "").length;
    if (cur.length && len + l > maxChars) { out.push(cur); cur = []; len = 0; }
    cur.push(t); len += l;
  }
  if (cur.length) out.push(cur);
  return out;
}
function parseArr(raw) {
  let s = String(raw).trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  const a = s.indexOf("["), b = s.lastIndexOf("]");
  if (a !== -1 && b > a) s = s.slice(a, b + 1);
  return JSON.parse(s);
}
async function claudeChunk(values, target) {
  const system = [
    "You are a professional e-commerce localization translator.",
    `Translate the given fields from English to locale "${target}".`,
    "Some values contain HTML — preserve every tag, attribute, and entity exactly; translate only the human-readable text.",
    "Keep tone and roughly the same length.",
    "Respond with ONLY a JSON array of strings, same length and order as input. No commentary, no code fences.",
  ].join(" ");
  for (let attempt = 0; attempt < 6; attempt++) {
    let out;
    try {
      out = curlPost(
        "https://api.anthropic.com/v1/messages",
        { "content-type": "application/json", "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
        { model: "claude-sonnet-4-6", max_tokens: 8192, system, messages: [{ role: "user", content: JSON.stringify(values) }] },
        120,
      );
    } catch (e) {
      await sleep(3000 * (attempt + 1)); continue; // curl network/timeout → retry
    }
    let j;
    try { j = JSON.parse(out); }
    catch { await sleep(2000 * (attempt + 1)); continue; }
    if (j.type === "error") {
      const t = j.error?.type || "";
      if (/overloaded|rate_limit|api_error|timeout/i.test(t)) { await sleep(3000 * (attempt + 1)); continue; }
      throw new Error("Claude: " + (j.error?.message || t).slice(0, 150));
    }
    const raw = j.content?.find((b) => b.type === "text")?.text ?? "[]";
    return parseArr(raw);
  }
  throw new Error("Claude failure after retries");
}
async function translateValues(texts, target) {
  const out = [];
  for (const c of chunk(texts, MAX_CHARS_PER_CHUNK)) {
    let vals;
    try {
      vals = await claudeChunk(c.map((t) => t.value), target);
    } catch (e) {
      // A malformed array (e.g. an unescaped quote in one field) shouldn't lose
      // the whole chunk — retry each field on its own (single-element arrays are
      // far less likely to malform), falling back to the original only per field.
      console.error("   chunk parse failed, retrying field-by-field:", e.message);
      vals = [];
      for (const t of c) {
        try { const r = await claudeChunk([t.value], target); vals.push(r[0]); }
        catch { vals.push(null); }
      }
    }
    for (let i = 0; i < c.length; i++) out.push(vals[i] != null ? vals[i] : c[i].value);
  }
  return out;
}
async function register(resourceId, inputs) {
  for (let i = 0; i < inputs.length; i += REGISTER_BATCH) {
    const batch = inputs.slice(i, i + REGISTER_BATCH);
    const d = await shopify(REGISTER_M, { id: resourceId, translations: batch });
    const errs = d.translationsRegister.userErrors;
    if (errs.length) throw new Error(errs.map((e) => e.message).join(", "));
    await sleep(150);
  }
}

async function run() {
  const targets = await publishedLocales();
  console.log("Target locales:", targets.join(", ") || "(none)");
  let grandFields = 0, grandResources = 0;
  for (const type of ALL_TYPES) {
    for (const locale of targets) {
      let after = null, hasNext = true, typeFields = 0, typeResources = 0;
      while (hasNext) {
        let data;
        try { data = await shopify(CONTENT_Q, { t: type, first: 10, after, locale }); }
        catch (e) { console.error(`[${type}/${locale}] query failed: ${e.message}`); break; }
        const conn = data.translatableResources;
        for (const node of conn.nodes) {
          const existing = new Map(node.translations.map((t) => [t.key, t]));
          const pending = node.translatableContent.filter((c) => {
            if (SKIP_KEYS.has(c.key)) return false;
            if (!c.value || !c.value.trim()) return false;
            const cur = existing.get(c.key);
            return !cur || cur.outdated;
          });
          if (!pending.length) continue;
          try {
            const vals = await translateValues(pending, locale);
            const inputs = pending.map((c, i) => ({ locale, key: c.key, value: vals[i], translatableContentDigest: c.digest }));
            await register(node.resourceId, inputs);
            typeFields += pending.length; typeResources += 1;
          } catch (e) { console.error(`   register ${node.resourceId} failed: ${e.message}`); }
        }
        hasNext = conn.pageInfo.hasNextPage; after = conn.pageInfo.endCursor;
      }
      if (typeResources) console.log(`[${type}/${locale}] ${typeResources} resources, ${typeFields} fields`);
      grandFields += typeFields; grandResources += typeResources;
    }
  }
  console.log(`\nDONE. ${grandResources} resources, ${grandFields} fields translated.`);
}
run().catch((e) => { console.error("FATAL", e); process.exit(1); });
