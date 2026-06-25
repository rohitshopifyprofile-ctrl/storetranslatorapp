// Client for Shopify's App Events API — reports usage that feeds the
// "words_translated" usage meter configured in Shopify App Pricing.
//
// Setup (one-time, in the Dev Dashboard):
//   1. Settings > API access > create an App Events API key (separate from OAuth creds).
//   2. App pricing > add a usage meter with handle "words_translated".
//   3. Set price per word + monthly cap; Shopify handles invoicing automatically.

let cachedToken = null;
let cachedTokenExpiry = 0;

async function getAccessToken() {
  if (cachedToken && Date.now() < cachedTokenExpiry - 30_000) {
    return cachedToken;
  }
  const response = await fetch("https://api.shopify.com/auth/access_token", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_id: process.env.APP_EVENTS_CLIENT_ID,
      client_secret: process.env.APP_EVENTS_CLIENT_SECRET,
      grant_type: "client_credentials",
    }),
  });
  if (!response.ok) {
    throw new Error(`Failed to get App Events access token: ${response.status}`);
  }
  const { access_token, expires_in } = await response.json();
  cachedToken = access_token;
  cachedTokenExpiry = Date.now() + expires_in * 1000;
  return cachedToken;
}

// shopId must be a Shopify GID, e.g. "gid://shopify/Shop/23423423"
// (fetch it once per shop with getShopGid() and cache it in ShopSettings).
export async function reportUsageEvent({ shopId, eventHandle, value, idempotencyKey, attributes = {} }) {
  const token = await getAccessToken();
  const response = await fetch("https://api.shopify.com/app/unstable/events", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      shop_id: shopId,
      event_handle: eventHandle,
      timestamp: new Date().toISOString(),
      idempotency_key: idempotencyKey,
      attributes: { value, ...attributes },
    }),
  });

  // Returns 202 even when billing validation later fails — real errors surface
  // in the Dev Dashboard logs, not in this response.
  if (!response.ok) {
    console.error(`App Events API request failed: ${response.status} ${await response.text()}`);
  }
  return response.ok;
}

export async function reportWordsTranslated({ shopId, wordCount }) {
  if (!wordCount || wordCount <= 0) return true;
  return reportUsageEvent({
    shopId,
    eventHandle: "words_translated",
    value: wordCount,
    idempotencyKey: `words_translated_${shopId}_${Date.now()}_${Math.random().toString(36).slice(2)}`,
  });
}
