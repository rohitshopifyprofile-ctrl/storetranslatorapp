import { useState } from "react";
import { useLoaderData, useFetcher } from "react-router";
import { authenticate } from "../shopify.server";
import { listGlossaryTerms, addGlossaryTerm, deleteGlossaryTerm } from "../lib/glossary.server";
import { listShopLocales } from "../lib/shopify-translations.server";

export async function loader({ request }) {
  const { admin, session } = await authenticate.admin(request);
  const [terms, shopLocales] = await Promise.all([
    listGlossaryTerms(session.shop),
    listShopLocales(admin),
  ]);
  return { terms, shopLocales: shopLocales.filter((l) => !l.primary) };
}

export async function action({ request }) {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = formData.get("intent");

  if (intent === "add") {
    await addGlossaryTerm(session.shop, {
      sourceTerm: formData.get("sourceTerm"),
      targetLocale: formData.get("targetLocale"),
      targetTerm: formData.get("targetTerm"),
    });
  } else if (intent === "delete") {
    await deleteGlossaryTerm(session.shop, formData.get("id"));
  }
  return { ok: true };
}

export default function Glossary() {
  const { terms, shopLocales } = useLoaderData();
  const fetcher = useFetcher();
  const [sourceTerm, setSourceTerm] = useState("");
  const [targetLocale, setTargetLocale] = useState(shopLocales[0]?.locale ?? "");
  const [targetTerm, setTargetTerm] = useState("");

  const submitAdd = () => {
    if (!sourceTerm || !targetLocale || !targetTerm) return;
    fetcher.submit({ intent: "add", sourceTerm, targetLocale, targetTerm }, { method: "post" });
    setSourceTerm("");
    setTargetTerm("");
  };

  return (
    <s-page heading="Glossary">
      <s-section heading="Do-not-translate terms">
        <p>
          Brand names, product codes, or phrases that should stay fixed in every language.
          These are sent to Claude/DeepL as instructions on every translation batch.
        </p>
        <s-stack direction="inline" gap="base" style={{ marginTop: "12px" }}>
          <div>
            <label style={labelStyle}>Source term</label>
            <input
              value={sourceTerm}
              onChange={(e) => setSourceTerm(e.target.value)}
              placeholder='e.g. "Acme Roastery"'
              style={inputStyle}
            />
          </div>
          <div>
            <label style={labelStyle}>Language</label>
            <select
              value={targetLocale}
              onChange={(e) => setTargetLocale(e.target.value)}
              style={{ ...inputStyle, width: "140px" }}
            >
              {shopLocales.map((l) => (
                <option key={l.locale} value={l.locale}>
                  {l.name}
                </option>
              ))}
              {shopLocales.length === 0 && (
                <option value="">—</option>
              )}
            </select>
          </div>
          <div>
            <label style={labelStyle}>Translated term (or same)</label>
            <input
              value={targetTerm}
              onChange={(e) => setTargetTerm(e.target.value)}
              placeholder='e.g. "Acme Roastery" (keep same)'
              style={inputStyle}
            />
          </div>
          <div style={{ paddingTop: "22px" }}>
            <s-button
              variant="primary"
              disabled={!sourceTerm || !targetLocale || !targetTerm}
              onClick={submitAdd}
            >
              Add term
            </s-button>
          </div>
        </s-stack>
      </s-section>

      <s-section heading="Current terms">
        {terms.length === 0 ? (
          <p style={{ color: "#666" }}>No glossary terms yet.</p>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ borderBottom: "1px solid #e0e0e0" }}>
                <Th>Source term</Th>
                <Th>Language</Th>
                <Th>Translated term</Th>
                <Th></Th>
              </tr>
            </thead>
            <tbody>
              {terms.map((t) => (
                <tr key={t.id} style={{ borderBottom: "1px solid #f0f0f0" }}>
                  <Td>{t.sourceTerm}</Td>
                  <Td><code>{t.targetLocale}</code></Td>
                  <Td>{t.targetTerm}</Td>
                  <Td>
                    <s-button
                      variant="secondary"
                      onClick={() => fetcher.submit({ intent: "delete", id: t.id }, { method: "post" })}
                    >
                      Remove
                    </s-button>
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </s-section>
    </s-page>
  );
}

const labelStyle = { display: "block", marginBottom: "4px", fontWeight: 500, fontSize: "13px" };
const inputStyle = { padding: "8px", display: "block" };

function Th({ children }) {
  return <th style={{ textAlign: "left", padding: "8px 12px", fontSize: "13px", color: "#666" }}>{children}</th>;
}
function Td({ children }) {
  return <td style={{ padding: "8px 12px", fontSize: "14px" }}>{children}</td>;
}
