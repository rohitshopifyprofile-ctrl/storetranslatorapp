import { authenticate } from "../shopify.server";
import db from "../db.server";
import { autoTranslateResource } from "../lib/auto-translate.server";

// Fires on products/create and products/update. Auto-translates the changed
// product into every published language, then returns 200 immediately so
// Shopify doesn't time out / retry — the translation runs in the background.
export const action = async ({ request }) => {
  const { admin, shop, topic, payload } = await authenticate.webhook(request);

  // No offline admin client (app not fully installed) → nothing we can do.
  if (!admin) return new Response();

  // Respect the merchant's auto-translate toggle.
  const settings = await db.shopSettings.findUnique({ where: { shop } });
  if (settings && settings.autoTranslate === false) {
    return new Response();
  }

  const resourceId = payload?.admin_graphql_api_id;
  if (resourceId) {
    // Fire-and-forget: don't block the webhook response on the AI calls.
    autoTranslateResource(admin, shop, resourceId).catch((error) => {
      console.error(`[auto-translate] ${topic} ${resourceId} failed:`, error?.message || error);
    });
  }

  return new Response();
};
