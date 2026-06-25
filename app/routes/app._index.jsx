import { Link, useLoaderData } from "react-router";
import { authenticate } from "../shopify.server";
import { listShopLocales } from "../lib/shopify-translations.server";
import db from "../db.server";

export async function loader({ request }) {
  const { admin, session } = await authenticate.admin(request);
  const [shopLocales, recentJobs] = await Promise.all([
    listShopLocales(admin),
    db.translationJob.findMany({
      where: { shop: session.shop },
      orderBy: { createdAt: "desc" },
      take: 10,
    }),
  ]);
  return { shopLocales, recentJobs };
}

const STATUS_COLORS = { completed: "#1a7f37", running: "#b45309", failed: "#c0392b" };

export default function Dashboard() {
  const { shopLocales, recentJobs } = useLoaderData();
  const publishedCount = shopLocales.filter((l) => l.published).length;
  const totalWords = recentJobs.reduce((sum, j) => sum + (j.wordsTranslated ?? 0), 0);

  return (
    <s-page heading="Translator">
      {/* ── Stats row ── */}
      <s-section heading="Overview">
        <s-stack direction="inline" gap="loose">
          <div style={statCard}>
            <div style={statNumber}>{shopLocales.length}</div>
            <div style={statLabel}>Languages enabled</div>
          </div>
          <div style={statCard}>
            <div style={statNumber}>{publishedCount}</div>
            <div style={statLabel}>Published to storefront</div>
          </div>
          <div style={statCard}>
            <div style={statNumber}>{totalWords.toLocaleString()}</div>
            <div style={statLabel}>Words translated (all-time)</div>
          </div>
        </s-stack>

        <s-stack direction="inline" gap="base" style={{ marginTop: "16px" }}>
          <Link to="/app/languages">
            <s-button variant="primary">Manage languages</s-button>
          </Link>
          <Link to="/app/translate">
            <s-button variant="secondary">Translate content</s-button>
          </Link>
          <Link to="/app/markets">
            <s-button variant="secondary">Markets & Currency</s-button>
          </Link>
          <Link to="/app/glossary">
            <s-button variant="secondary">Glossary</s-button>
          </Link>
          <Link to="/app/settings">
            <s-button variant="secondary">Settings</s-button>
          </Link>
        </s-stack>
      </s-section>

      {/* ── Feature callouts ── */}
      <s-section heading="What this app does">
        <s-stack direction="block" gap="base">
          <FeatureRow
            icon="🌐"
            title="AI-powered translations"
            desc="Translates products, collections, pages, blog posts, theme UI strings, metafields, and shop policies using Claude."
          />
          <FeatureRow
            icon="📍"
            title="Geo-detection & redirect"
            desc="The storefront Country Selector block auto-detects the visitor's country and redirects them to the correct language. Add the block via the theme editor."
          />
          <FeatureRow
            icon="💱"
            title=".99 price rounding"
            desc='Automatically rounds foreign-currency prices to the nearest X.99 (e.g. €19.99 instead of €20.00). Configured per market in the Markets & Currency page.'
          />
          <FeatureRow
            icon="🧩"
            title="Third-party app content"
            desc="Translates metafields and metaobjects used by apps like Kaching Bundles, review apps, and post-purchase extensions."
          />
        </s-stack>
      </s-section>

      {/* ── Recent jobs ── */}
      <s-section heading="Recent translation jobs">
        {recentJobs.length === 0 ? (
          <p>No translation jobs yet. Head to Translate content to run your first batch.</p>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ borderBottom: "1px solid #e0e0e0" }}>
                <Th>Locale</Th>
                <Th>Type</Th>
                <Th>Status</Th>
                <Th>Words</Th>
                <Th>When</Th>
              </tr>
            </thead>
            <tbody>
              {recentJobs.map((job) => (
                <tr key={job.id} style={{ borderBottom: "1px solid #f0f0f0" }}>
                  <Td>{job.targetLocale}</Td>
                  <Td>{job.resourceType}</Td>
                  <Td>
                    <span style={{ color: STATUS_COLORS[job.status] ?? "#666", fontWeight: 500 }}>
                      {job.status}
                    </span>
                  </Td>
                  <Td>{(job.wordsTranslated ?? 0).toLocaleString()}</Td>
                  <Td>{new Date(job.createdAt).toLocaleString()}</Td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </s-section>
    </s-page>
  );
}

function FeatureRow({ icon, title, desc }) {
  return (
    <div style={{ display: "flex", gap: "12px", alignItems: "flex-start" }}>
      <span style={{ fontSize: "20px", lineHeight: 1 }}>{icon}</span>
      <div>
        <strong>{title}</strong>
        <p style={{ margin: "2px 0 0", color: "#555" }}>{desc}</p>
      </div>
    </div>
  );
}

function Th({ children }) {
  return <th style={{ textAlign: "left", padding: "8px 12px", fontSize: "13px", color: "#666" }}>{children}</th>;
}
function Td({ children }) {
  return <td style={{ padding: "8px 12px", fontSize: "14px" }}>{children}</td>;
}

const statCard = {
  background: "#f6f6f7",
  borderRadius: "8px",
  padding: "16px 24px",
  minWidth: "140px",
  textAlign: "center",
};
const statNumber = { fontSize: "28px", fontWeight: "700", lineHeight: 1.2 };
const statLabel = { fontSize: "13px", color: "#666", marginTop: "4px" };
