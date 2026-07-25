import { useLoaderData, useFetcher } from "react-router";
import { authenticate } from "../shopify.server";
import { listAvailableLocales } from "../lib/shopify-translations.server";
import db from "../db.server";

export async function loader({ request }) {
  const { admin, session } = await authenticate.admin(request);
  const [settings, availableLocales] = await Promise.all([
    db.shopSettings.upsert({
      where: { shop: session.shop },
      update: {},
      create: { shop: session.shop },
    }),
    listAvailableLocales(admin),
  ]);
  // Env vars must be read server-side; the component runs in the browser where
  // `process` is undefined.
  const provider = process.env.TRANSLATION_PROVIDER === "deepl" ? "DeepL" : "Claude (Anthropic)";
  return { settings, availableLocales, provider };
}

export async function action({ request }) {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = formData.get("intent");

  if (intent === "update_source_locale") {
    await db.shopSettings.update({
      where: { shop: session.shop },
      data: { sourceLocale: formData.get("sourceLocale") },
    });
  } else if (intent === "update_auto_translate") {
    await db.shopSettings.update({
      where: { shop: session.shop },
      data: { autoTranslate: formData.get("autoTranslate") === "true" },
    });
  }

  return { ok: true };
}

export default function Settings() {
  const { settings, availableLocales, provider } = useLoaderData();
  const fetcher = useFetcher();

  return (
    <s-page heading="Settings">
      <s-section heading="Source language">
        <p style={{ marginBottom: "12px" }}>
          The language your store's content is written in. Translations are generated{" "}
          <em>from</em> this language. Usually English.
        </p>
        <s-stack direction="inline" gap="base">
          <select
            defaultValue={settings.sourceLocale ?? "en"}
            id="source-locale-select"
            style={{ padding: "8px", minWidth: "240px" }}
          >
            {availableLocales.map((l) => (
              <option key={l.code} value={l.code}>
                {l.name} ({l.code})
              </option>
            ))}
          </select>
          <s-button
            variant="primary"
            onClick={() => {
              const val = document.getElementById("source-locale-select").value;
              fetcher.submit({ intent: "update_source_locale", sourceLocale: val }, { method: "post" });
            }}
          >
            Save
          </s-button>
        </s-stack>
        {fetcher.data?.ok && (
          <p style={{ marginTop: "8px", color: "#1a7f37" }}>Saved.</p>
        )}
      </s-section>

      <s-section heading="Automatic translation">
        <p style={{ marginBottom: "12px" }}>
          When on, every product you create or edit is automatically translated into all your
          published languages — no manual batch needed.
        </p>
        <label style={{ display: "inline-flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
          <input
            type="checkbox"
            defaultChecked={settings.autoTranslate}
            onChange={(e) =>
              fetcher.submit(
                { intent: "update_auto_translate", autoTranslate: String(e.target.checked) },
                { method: "post" }
              )
            }
          />
          <span>Automatically translate new &amp; updated products</span>
        </label>
        <p style={{ marginTop: "12px", color: "#666", fontSize: 13 }}>
          Auto-translation is delivered by webhooks, so it only runs while the app server is
          online. Store-wide UI (product-page templates, buttons, checkout labels) and existing
          content are translated with <strong>Translate whole store</strong> on the Translate page.
        </p>
      </s-section>

      <s-section heading="Translation provider">
        <p>
          Currently using: <strong>{provider}</strong>
        </p>
        <p style={{ marginTop: "8px", color: "#666" }}>
          To switch providers, update <code>TRANSLATION_PROVIDER</code> in your <code>.env</code>{" "}
          file (<code>claude</code> or <code>deepl</code>) and redeploy.
        </p>
      </s-section>

      <s-section heading="Billing">
        <p>
          This app bills per word translated through Shopify's usage-based pricing. Usage is
          reported automatically after each translation batch. To configure your pricing plan
          and per-word rate, go to your{" "}
          <a
            href="https://partners.shopify.com/organizations"
            target="_blank"
            rel="noreferrer"
          >
            Partner Dashboard → App → Pricing
          </a>
          .
        </p>
        <p style={{ marginTop: "8px", color: "#666" }}>
          Usage meter handle: <code>words_translated</code>
        </p>
      </s-section>

      <s-section heading="Country selector (storefront widget)">
        <p>
          The country and language picker (and the geo auto-detect) is a theme{" "}
          <strong>app embed</strong>, so it works on every storefront page. To turn it on:
        </p>
        <ol style={{ marginTop: "8px", lineHeight: 2 }}>
          <li>
            Go to <strong>Online Store → Themes → Customize</strong>.
          </li>
          <li>
            In the left sidebar, scroll to the bottom and open <strong>App embeds</strong>.
          </li>
          <li>
            Toggle on <strong>Language &amp; Country</strong>, then click <strong>Save</strong>.
          </li>
          <li>
            The selector appears fixed in the top-right of the storefront, and auto-detect runs
            on every page for first-time visitors.
          </li>
        </ol>
        <p style={{ marginTop: "8px", color: "#666" }}>
          Tip: add <code>?translator_debug=1</code> to any storefront URL to see the detection
          decision in the browser console.
        </p>
      </s-section>
    </s-page>
  );
}
