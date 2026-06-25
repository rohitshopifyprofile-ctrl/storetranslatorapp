// GDPR mandatory webhooks — required by Shopify for App Store submission.
// These three topics CANNOT be registered via GraphQL; they must be declared
// in shopify.app.toml (see shopify.app.toml.additions).
//
// All three compliance webhooks hit this single route. We distinguish the
// topic via the X-Shopify-Topic header.

import { authenticate } from "../shopify.server";
import db from "../db.server";

export async function action({ request }) {
  const { topic, shop, payload } = await authenticate.webhook(request);

  switch (topic) {
    case "customers/data_request":
      // A customer requested their data. In this app we store no personal
      // customer data — only shop-level settings, glossary terms, and job logs.
      // Respond 200 to acknowledge receipt; no further action needed.
      break;

    case "customers/redact":
      // A customer requested deletion of their data. Same as above — no PII stored.
      break;

    case "shop/redact":
      // The merchant uninstalled the app. Delete all shop-level data.
      await Promise.allSettled([
        db.shopSettings.deleteMany({ where: { shop } }),
        db.glossaryTerm.deleteMany({ where: { shop } }),
        db.translationJob.deleteMany({ where: { shop } }),
      ]);
      break;

    default:
      console.warn(`Unhandled compliance webhook topic: ${topic}`);
  }

  return new Response(null, { status: 200 });
}
