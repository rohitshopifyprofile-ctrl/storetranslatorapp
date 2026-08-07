// Enable + publish a set of locales and add them to every market's web presence,
// so they show on the storefront. Then run scripts/translate-all.mjs to fill in
// the translations. Env: SHOP, TOKEN, [LOCALES]
const SHOP = process.env.SHOP;
const TOKEN = process.env.TOKEN;
const API_VERSION = "2026-07";
const ADMIN_URL = `https://${SHOP}/admin/api/${API_VERSION}/graphql.json`;

// Default: Spanish, German (covers Austria), Italian, Dutch, Swedish, Norwegian (Bokmål)
const LOCALES = (process.env.LOCALES || "es,de,it,nl,sv,nb").split(",").map((s) => s.trim()).filter(Boolean);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function shopify(query, variables) {
  for (let attempt = 0; attempt < 6; attempt++) {
    const res = await fetch(ADMIN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": TOKEN },
      body: JSON.stringify({ query, variables }),
    });
    const json = await res.json();
    if (json.errors) {
      if (JSON.stringify(json.errors).includes("THROTTLED")) { await sleep(2000 * (attempt + 1)); continue; }
      throw new Error("GraphQL: " + JSON.stringify(json.errors).slice(0, 200));
    }
    return json.data;
  }
  throw new Error("throttled after retries");
}

const ENABLE = `mutation($locale:String!){ shopLocaleEnable(locale:$locale){ shopLocale{locale} userErrors{message} } }`;
const PUBLISH = `mutation($locale:String!){ shopLocaleUpdate(locale:$locale, shopLocale:{published:true}){ shopLocale{locale published} userErrors{message} } }`;
const MARKETS = `{ markets(first:50){ nodes{ id name webPresences(first:5){ nodes{ id defaultLocale{locale} alternateLocales{locale} } } } } }`;
const WP_UPDATE = `mutation($id:ID!,$input:WebPresenceUpdateInput!){ webPresenceUpdate(id:$id,input:$input){ webPresence{id alternateLocales{locale}} userErrors{message} } }`;

async function run() {
  console.log("Locales to add:", LOCALES.join(", "));

  // 1. Enable + publish each locale (idempotent — ignore "already enabled").
  for (const locale of LOCALES) {
    const e = await shopify(ENABLE, { locale });
    const eErr = e.shopLocaleEnable.userErrors.map((u) => u.message).join(", ");
    if (eErr && !/already|enabled/i.test(eErr)) console.log(`  enable ${locale}: ${eErr}`);
    const p = await shopify(PUBLISH, { locale });
    const pErr = p.shopLocaleUpdate.userErrors.map((u) => u.message).join(", ");
    console.log(`  ${locale}: ${pErr ? "publish error: " + pErr : "enabled + published"}`);
    await sleep(200);
  }

  // 2. Add every locale to each market's web presence (union with existing).
  const data = await shopify(MARKETS);
  for (const m of data.markets.nodes) {
    const wp = m.webPresences?.nodes?.[0];
    if (!wp) continue;
    const def = wp.defaultLocale?.locale;
    const existing = new Set((wp.alternateLocales || []).map((l) => l.locale));
    for (const loc of LOCALES) if (loc !== def) existing.add(loc);
    const alternateLocales = [...existing];
    const r = await shopify(WP_UPDATE, { id: wp.id, input: { alternateLocales } });
    const err = r.webPresenceUpdate.userErrors.map((u) => u.message).join(", ");
    console.log(`  market "${m.name}": ${err ? "error: " + err : "languages -> " + [def, ...alternateLocales].join(", ")}`);
    await sleep(200);
  }
  console.log("\nDONE enabling/publishing/market-adding. Now run scripts/translate-all.mjs to translate.");
}
run().catch((e) => { console.error("FATAL", e); process.exit(1); });
