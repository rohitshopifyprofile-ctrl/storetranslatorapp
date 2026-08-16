// Pluggable AI translation backend.
//
// The app pays for translation calls itself (using its own API key) — merchants
// are charged through a Shopify App Pricing usage meter, not asked to bring
// their own key. Set TRANSLATION_PROVIDER=claude or deepl in .env.

import { getCachedMap, putCached, hashText } from "./translation-cache.server";

const PROVIDER = process.env.TRANSLATION_PROVIDER || "claude";

async function callProvider(texts, sourceLocale, targetLocale, glossary) {
  if (PROVIDER === "deepl") return translateWithDeepL({ texts, sourceLocale, targetLocale });
  return translateWithClaude({ texts, sourceLocale, targetLocale, glossary });
}

// texts: [{ key, value }] — value may contain HTML (product body_html etc.)
// glossary: [{ sourceTerm, targetLocale, targetTerm }]
// shop: enables the translation-memory cache (reuse identical strings).
// skipCacheRead: force fresh translation (e.g. Overwrite mode) but still store.
// Returns: [{ key, value }] translated, same order as input (value null on fail).
export async function translateFields({ texts, sourceLocale, targetLocale, glossary = [], shop = null, skipCacheRead = false }) {
  if (texts.length === 0) return [];

  const result = new Array(texts.length);

  // 1) Cache lookup — reuse anything we've translated before.
  const cached = shop && !skipCacheRead
    ? await getCachedMap(shop, sourceLocale, targetLocale, texts.map((t) => t.value))
    : new Map();

  // 2) Collect misses, de-duplicated by source text (same string once).
  const bySource = new Map(); // source value -> [indexes]
  texts.forEach((t, i) => {
    const hit = cached.get(hashText(t.value));
    if (hit != null) { result[i] = { key: t.key, value: hit }; return; }
    if (!bySource.has(t.value)) bySource.set(t.value, []);
    bySource.get(t.value).push(i);
  });

  // 3) Translate the unique missing source texts once.
  const uniqueSources = [...bySource.keys()];
  if (uniqueSources.length > 0) {
    const translated = await callProvider(
      uniqueSources.map((v, idx) => ({ key: `u${idx}`, value: v })),
      sourceLocale, targetLocale, glossary,
    );
    const toCache = [];
    uniqueSources.forEach((src, idx) => {
      const v = translated[idx]?.value ?? null;
      for (const i of bySource.get(src)) result[i] = { key: texts[i].key, value: v };
      if (shop && v != null && v !== src) toCache.push({ source: src, translated: v });
    });
    if (shop && toCache.length) await putCached(shop, sourceLocale, targetLocale, toCache);
  }

  return result;
}

// Keep each Claude call's input (and therefore its JSON output) small enough to
// fit comfortably under max_tokens. Theme templates can carry very long HTML, so
// we split a resource's fields into character-bounded chunks and translate each
// separately, then stitch the results back together in order.
const MAX_CHARS_PER_CHUNK = 6000;
const CLAUDE_MAX_TOKENS = 8192;
// How many translation requests to run at once. The big speed lever — a resource
// with many chunks (theme) translates ~Nx faster. Kept modest to stay under
// Anthropic rate limits (each call retries on 429). Override with TRANSLATION_CONCURRENCY.
const CONCURRENCY = Math.max(1, parseInt(process.env.TRANSLATION_CONCURRENCY || "5", 10) || 5);

// Run `fn` over items with at most `limit` in flight; results keep input order.
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

function chunkTexts(texts, maxChars) {
  const chunks = [];
  let current = [];
  let currentLen = 0;
  for (const t of texts) {
    const len = (t.value || "").length;
    if (current.length > 0 && currentLen + len > maxChars) {
      chunks.push(current);
      current = [];
      currentLen = 0;
    }
    current.push(t);
    currentLen += len;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

// Parse marker-delimited output into an array aligned to the input. Robust to
// quotes/HTML/newlines (a JSON array of HTML strings is fragile — the model
// often emits unescaped quotes). Missing segments come back as null.
function parseSegments(raw, n) {
  const parts = String(raw).split(/###SEG\s+(\d+)###/);
  const map = {};
  for (let i = 1; i < parts.length; i += 2) {
    const idx = parseInt(parts[i], 10);
    if (!Number.isNaN(idx)) map[idx] = (parts[i + 1] ?? "").replace(/^\n/, "").replace(/\s+$/, "");
  }
  return Array.from({ length: n }, (_, i) => (map[i] != null ? map[i] : null));
}

async function translateWithClaude({ texts, sourceLocale, targetLocale, glossary }) {
  const chunks = chunkTexts(texts, MAX_CHARS_PER_CHUNK);
  // Translate chunks concurrently (order preserved) — the main speedup.
  const perChunk = await mapLimit(chunks, CONCURRENCY, async (chunk) => {
    try {
      return await translateChunkWithClaude({ texts: chunk, sourceLocale, targetLocale, glossary });
    } catch (error) {
      console.error("[translate] chunk failed:", error?.message || error);
      return [];
    }
  });
  const out = [];
  chunks.forEach((chunk, ci) => {
    const values = perChunk[ci] || [];
    for (let i = 0; i < chunk.length; i++) {
      // On failure use null, NOT the original — registering source-as-translation
      // pollutes state and shows English. Null fields are left untranslated.
      out.push({ key: chunk[i].key, value: values[i] != null ? values[i] : null });
    }
  });
  return out;
}

async function translateChunkWithClaude({ texts, sourceLocale, targetLocale, glossary }) {
  const glossaryNote = glossary.length
    ? `Glossary terms — keep these exactly as given, never translate them: ${glossary
        .map((g) => `"${g.sourceTerm}" -> "${g.targetTerm}"`)
        .join(", ")}.`
    : "";

  const system = [
    "You are a professional e-commerce localization translator.",
    `Translate each segment from locale "${sourceLocale}" into locale "${targetLocale}".`,
    "Segments are delimited by lines of the form '###SEG k###' (k is the index). In your reply, output each segment's translation preceded by the exact same '###SEG k###' line, in the same order.",
    "Some values contain HTML — preserve every tag, attribute, and entity exactly; translate only the human-readable text. Keep tone and roughly the same length.",
    glossaryNote,
    "Output ONLY the '###SEG k###' markers and translated text. No commentary, no code fences.",
  ]
    .filter(Boolean)
    .join(" ");

  const userContent = texts.map((t, i) => `###SEG ${i}###\n${t.value}`).join("\n");
  const body = JSON.stringify({
    model: "claude-sonnet-4-6",
    max_tokens: CLAUDE_MAX_TOKENS,
    system,
    messages: [{ role: "user", content: userContent }],
  });

  // Hard timeout + retries so a single stalled request can never hang the whole
  // background sweep (which would freeze the progress bar / job forever).
  let response;
  let lastErr;
  for (let attempt = 0; attempt < 4; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 120000);
    try {
      response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": process.env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
        },
        body,
        signal: controller.signal,
      });
    } catch (e) {
      lastErr = e;
      clearTimeout(timer);
      await new Promise((r) => setTimeout(r, 2000 * (attempt + 1))); // timeout/network → retry
      continue;
    }
    clearTimeout(timer);
    if (response.status === 429 || response.status === 529) {
      await new Promise((r) => setTimeout(r, 3000 * (attempt + 1))); // rate limited → retry
      continue;
    }
    break;
  }
  if (!response) throw new Error(`Claude request failed after retries: ${lastErr?.message || "timeout"}`);
  if (!response.ok) {
    throw new Error(`Claude translation request failed: ${response.status} ${await response.text()}`);
  }

  const result = await response.json();
  const raw = result.content.find((block) => block.type === "text")?.text ?? "";
  return parseSegments(raw, texts.length);
}

async function translateWithDeepL({ texts, sourceLocale, targetLocale }) {
  const params = new URLSearchParams();
  texts.forEach((t) => params.append("text", t.value));
  params.append("source_lang", sourceLocale.toUpperCase());
  params.append("target_lang", targetLocale.toUpperCase());
  params.append("tag_handling", "html");

  const response = await fetch("https://api.deepl.com/v2/translate", {
    method: "POST",
    headers: {
      Authorization: `DeepL-Auth-Key ${process.env.DEEPL_API_KEY}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: params,
  });

  if (!response.ok) {
    throw new Error(`DeepL translation request failed: ${response.status} ${await response.text()}`);
  }

  const result = await response.json();
  return texts.map((t, i) => ({ key: t.key, value: result.translations[i].text }));
}

// Rough word count for usage-based billing (good enough for a meter; doesn't
// need to be linguistically precise).
export function countWords(texts) {
  return texts.reduce((total, t) => total + t.value.split(/\s+/).filter(Boolean).length, 0);
}
