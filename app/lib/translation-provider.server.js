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

async function translateWithClaude({ texts, sourceLocale, targetLocale, glossary }) {
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
      max_tokens: 4096,
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
  const raw = result.content.find((block) => block.type === "text")?.text ?? "[]";
  let translatedValues;
  try {
    translatedValues = JSON.parse(raw);
  } catch {
    throw new Error(`Claude returned non-JSON output: ${raw.slice(0, 200)}`);
  }

  return texts.map((t, i) => ({ key: t.key, value: translatedValues[i] }));
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
