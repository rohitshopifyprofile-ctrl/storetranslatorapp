// Pluggable AI translation backend.
//
// The app pays for translation calls itself (using its own API key) — merchants
// are charged through a Shopify App Pricing usage meter, not asked to bring
// their own key. Set TRANSLATION_PROVIDER=claude or deepl in .env.

const PROVIDER = process.env.TRANSLATION_PROVIDER || "claude";

// texts: [{ key, value }] — value may contain HTML (product body_html etc.)
// glossary: [{ sourceTerm, targetLocale, targetTerm }]
// Returns: [{ key, value }] translated, same order as input.
export async function translateFields({ texts, sourceLocale, targetLocale, glossary = [] }) {
  if (texts.length === 0) return [];
  if (PROVIDER === "deepl") {
    return translateWithDeepL({ texts, sourceLocale, targetLocale });
  }
  return translateWithClaude({ texts, sourceLocale, targetLocale, glossary });
}

// Keep each Claude call's input (and therefore its JSON output) small enough to
// fit comfortably under max_tokens. Theme templates can carry very long HTML, so
// we split a resource's fields into character-bounded chunks and translate each
// separately, then stitch the results back together in order.
const MAX_CHARS_PER_CHUNK = 6000;
const CLAUDE_MAX_TOKENS = 8192;

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

// Parse a JSON array of strings from a model response, tolerating stray prose or
// markdown code fences by extracting the outermost [ ... ].
function parseJsonArray(raw) {
  let s = String(raw).trim();
  s = s.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  const start = s.indexOf("[");
  const end = s.lastIndexOf("]");
  if (start !== -1 && end > start) s = s.slice(start, end + 1);
  return JSON.parse(s);
}

async function translateWithClaude({ texts, sourceLocale, targetLocale, glossary }) {
  const chunks = chunkTexts(texts, MAX_CHARS_PER_CHUNK);
  const out = [];
  for (const chunk of chunks) {
    const values = await translateChunkWithClaude({ texts: chunk, sourceLocale, targetLocale, glossary });
    for (let i = 0; i < chunk.length; i++) {
      // Fall back to the original if a field came back missing, so one bad item
      // never discards a whole chunk.
      out.push({ key: chunk[i].key, value: values[i] != null ? values[i] : chunk[i].value });
    }
  }
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
    `Translate the given fields from locale "${sourceLocale}" to locale "${targetLocale}".`,
    "Some values contain HTML — preserve every tag, attribute, and entity exactly; translate only the human-readable text inside them.",
    "Keep tone, formatting, and roughly the same length as the original (this is product and marketing copy).",
    glossaryNote,
    "Respond with ONLY a JSON array of strings, the same length and order as the input array. No commentary, no markdown code fences.",
  ]
    .filter(Boolean)
    .join(" ");

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: CLAUDE_MAX_TOKENS,
      system,
      messages: [
        {
          role: "user",
          content: JSON.stringify(texts.map((t) => t.value)),
        },
      ],
    }),
  });

  if (!response.ok) {
    throw new Error(`Claude translation request failed: ${response.status} ${await response.text()}`);
  }

  const result = await response.json();
  const stopReason = result.stop_reason;
  const raw = result.content.find((block) => block.type === "text")?.text ?? "[]";

  let translatedValues;
  try {
    translatedValues = parseJsonArray(raw);
  } catch {
    const hint = stopReason === "max_tokens" ? " (response hit max_tokens — input chunk too large)" : "";
    throw new Error(`Claude returned non-JSON output${hint}: ${raw.slice(0, 160)}`);
  }
  if (!Array.isArray(translatedValues)) {
    throw new Error("Claude did not return a JSON array");
  }
  return translatedValues;
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
