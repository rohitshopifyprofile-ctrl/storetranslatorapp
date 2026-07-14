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
          The country and language picker shown to storefront visitors is a theme app extension
          block. To add it to your store:
        </p>
        <ol style={{ marginTop: "8px", lineHeight: 2 }}>
          <li>
            Go to <strong>Online Store → Themes → Customize</strong>.
          </li>
          <li>
            Click <strong>Add section</strong> or <strong>Add block</strong> in the header area.
          </li>
          <li>
            Search for <strong>Language &amp; Country Selector</strong> and add it.
          </li>
          <li>
            Enable <strong>Auto-detect visitor country</strong> in the block settings to
            automatically redirect visitors based on their location.
          </li>
        </ol>
      </s-section>
    </s-page>
  );
}
