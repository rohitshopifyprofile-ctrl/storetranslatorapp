import { Link, useLoaderData } from "react-router";
import { authenticate } from "../shopify.server";
import { listShopLocales } from "../lib/shopify-translations.server";
import db from "../db.server";
import { AppHero, StatTile, Card, Badge } from "../components/ui";

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

const STATUS_TONE = { completed: "success", running: "warning", failed: "critical" };

export default function Dashboard() {
  const { shopLocales, recentJobs } = useLoaderData();
  const publishedCount = shopLocales.filter((l) => l.published).length;
  const totalWords = recentJobs.reduce((sum, j) => sum + (j.wordsTranslated ?? 0), 0);

  return (
    <s-page>
      <AppHero
        title="Translate your entire store"
        subtitle="AI-powered translation for products, theme UI, collections, pages, metafields and more — into every language, automatically."
        emoji="🌐"
      />

      {/* Stats */}
      <div style={row}>
        <StatTile value={shopLocales.length} label="Languages enabled" accent="#00a08e" emoji="🗣️" />
        <StatTile value={publishedCount} label="Published to storefront" accent="#1c5fbf" emoji="🚀" />
        <StatTile value={totalWords.toLocaleString()} label="Words translated" accent="#7a4fd0" emoji="✨" />
      </div>

      {/* Quick actions */}
      <div style={{ ...row, marginTop: 14, marginBottom: 20, flexWrap: "wrap" }}>
        <Link to="/app/translate"><s-button variant="primary">Translate content</s-button></Link>
        <Link to="/app/languages"><s-button variant="secondary">Manage languages</s-button></Link>
        <Link to="/app/markets"><s-button variant="secondary">Markets & Currency</s-button></Link>
        <Link to="/app/review"><s-button variant="secondary">Review</s-button></Link>
        <Link to="/app/glossary"><s-button variant="secondary">Glossary</s-button></Link>
        <Link to="/app/settings"><s-button variant="secondary">Settings</s-button></Link>
      </div>

      {/* Features */}
      <div style={grid}>
        <FeatureCard emoji="🤖" accent="#00a08e" title="AI-powered translations"
          desc="Products, collections, pages, blogs, theme UI strings, metafields and shop policies — translated by Claude." />
        <FeatureCard emoji="📍" accent="#1c5fbf" title="Geo-detect & redirect"
          desc="The storefront selector auto-detects a visitor's country and switches to their language and currency." />
        <FeatureCard emoji="💱" accent="#9a6a00" title=".99 price rounding"
          desc="Rounds converted prices to a natural value per market — €19.99 instead of €20.00." />
        <FeatureCard emoji="🧩" accent="#7a4fd0" title="3rd-party app content"
          desc="Translates metafields & metaobjects from apps like bundles, reviews and upsells." />
      </div>

      {/* Recent jobs */}
      <Card style={{ marginTop: 18 }}>
        <div style={cardTitle}>Recent translation jobs</div>
        {recentJobs.length === 0 ? (
          <p style={{ color: "var(--p-color-text-secondary,#6d7175)", margin: "8px 0 0" }}>
            No translation jobs yet — head to <Link to="/app/translate">Translate content</Link> to run your first.
          </p>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 520 }}>
              <thead>
                <tr style={{ borderBottom: "1px solid var(--p-color-border,#e1e3e5)" }}>
                  <Th>Languages</Th><Th>Type</Th><Th>Status</Th><Th>Words</Th><Th>When</Th>
                </tr>
              </thead>
              <tbody>
                {recentJobs.map((job) => (
                  <tr key={job.id} style={{ borderBottom: "1px solid var(--p-color-border,#f1f2f3)" }}>
                    <Td>{job.targetLocale}</Td>
                    <Td>{job.resourceType}</Td>
                    <Td><Badge tone={STATUS_TONE[job.status] || "default"}>{job.status}</Badge></Td>
                    <Td>{(job.wordsTranslated ?? 0).toLocaleString()}</Td>
                    <Td>{new Date(job.createdAt).toLocaleString()}</Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </s-page>
  );
}

function FeatureCard({ emoji, title, desc, accent }) {
  return (
    <Card>
      <div style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
        <span style={{ fontSize: 20, width: 40, height: 40, display: "grid", placeItems: "center", borderRadius: 11, background: accent + "1a", flex: "none" }}>{emoji}</span>
        <div>
          <strong style={{ fontSize: 15 }}>{title}</strong>
          <p style={{ margin: "3px 0 0", color: "var(--p-color-text-secondary,#6d7175)", fontSize: 13, lineHeight: 1.5 }}>{desc}</p>
        </div>
      </div>
    </Card>
  );
}

const row = { display: "flex", gap: 14 };
const grid = { display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(280px,1fr))", gap: 14 };
const cardTitle = { fontSize: 15, fontWeight: 640, marginBottom: 10 };
function Th({ children }) { return <th style={{ textAlign: "left", padding: "8px 12px", fontSize: 13, color: "var(--p-color-text-secondary,#6d7175)" }}>{children}</th>; }
function Td({ children }) { return <td style={{ padding: "8px 12px", fontSize: 14 }}>{children}</td>; }
