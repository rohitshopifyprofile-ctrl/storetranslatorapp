/**
 * Language & Country Selector — Storefront Script
 *
 * Handles:
 *   1. Auto-submit the localization form on <select> change (no button click needed).
 *   2. Geo-detect the visitor's country via window.Shopify.country and auto-redirect
 *      them to the matching locale on their first visit (once only; respects manual
 *      override stored in localStorage).
 */
(function () {
  "use strict";

  var LOCALE_KEY = "translator_locale";
  var COUNTRY_KEY = "translator_country";

  // Country ISO → preferred locale. Covers the most common markets; merchants
  // can extend/override via the block's "Custom country → locale overrides" setting.
  var DEFAULT_MAP = {
    // French
    FR: "fr", BE: "fr", CH: "fr", LU: "fr", MC: "fr",
    // German
    DE: "de", AT: "de", LI: "de",
    // Spanish
    ES: "es", MX: "es", AR: "es", CL: "es", CO: "es", PE: "es",
    VE: "es", EC: "es", GT: "es", CU: "es", BO: "es", DO: "es",
    HN: "es", PY: "es", SV: "es", NI: "es", CR: "es", PA: "es", UY: "es",
    // Portuguese
    PT: "pt-PT", BR: "pt-BR", AO: "pt-PT", MZ: "pt-PT",
    // Italian
    IT: "it", SM: "it", VA: "it",
    // Dutch
    NL: "nl",
    // Polish
    PL: "pl",
    // Swedish
    SE: "sv",
    // Norwegian
    NO: "nb",
    // Danish
    DK: "da",
    // Finnish
    FI: "fi",
    // Japanese
    JP: "ja",
    // Korean
    KR: "ko",
    // Chinese
    CN: "zh-CN", TW: "zh-TW", HK: "zh-TW", MO: "zh-TW",
    // Russian
    RU: "ru", BY: "ru", KZ: "ru",
    // Arabic
    SA: "ar", AE: "ar", EG: "ar", QA: "ar", KW: "ar", BH: "ar", OM: "ar",
    // Turkish
    TR: "tr",
    // Hindi
    IN: "hi",
    // Thai
    TH: "th",
    // Vietnamese
    VN: "vi",
    // Indonesian
    ID: "id",
    // Czech
    CZ: "cs",
    // Romanian
    RO: "ro",
    // Hungarian
    HU: "hu",
    // Greek
    GR: "el",
    // Hebrew
    IL: "he",
  };

  var config = window.__translatorConfig || {};
  var autoDetect = config.autoDetect !== false;
  var currentCountry = config.currentCountry || "";
  var currentLocale = config.currentLocale || "";
  var availableLocales = config.availableLocales || [];
  var availableCountries = config.availableCountries || [];

  // Merge default map with merchant overrides. The override comes from a theme
  // setting (a textarea), so it arrives as a JSON *string* — parse it safely.
  var customMap = {};
  var rawCustomMap = config.customCountryMap;
  if (rawCustomMap && typeof rawCustomMap === "string") {
    try { customMap = JSON.parse(rawCustomMap) || {}; } catch (_) { customMap = {}; }
  } else if (rawCustomMap && typeof rawCustomMap === "object") {
    customMap = rawCustomMap;
  }
  var countryToLocale = Object.assign({}, DEFAULT_MAP, customMap);

  /**
   * Wire up the <select> elements to auto-submit on change and save preference.
   */
  function initSelects() {
    var form = document.getElementById("translator-localization-form");
    if (!form) return;

    var selects = form.querySelectorAll("select");
    selects.forEach(function (sel) {
      sel.addEventListener("change", function () {
        if (sel.name === "language_code") {
          try { localStorage.setItem(LOCALE_KEY, sel.value); } catch (_) {}
        } else if (sel.name === "country_code") {
          try { localStorage.setItem(COUNTRY_KEY, sel.value); } catch (_) {}
        }
        form.submit();
      });
    });
  }

  // Debug mode: append ?translator_debug=1 to any storefront URL to see, in the
  // browser console, exactly what was detected and why we did or didn't switch.
  var DEBUG = false;
  try { DEBUG = /[?&]translator_debug=1\b/.test(window.location.search); } catch (_) {}
  function log() {
    if (DEBUG && window.console) console.info.apply(console, ["[translator]"].concat([].slice.call(arguments)));
  }

  // Find the best published locale for a target language. Handles exact matches
  // ("fr" -> "fr") and region variants ("fr" -> "fr-FR", "pt-BR" -> "pt").
  function resolveAvailableLocale(target) {
    if (!target) return null;
    var t = String(target).toLowerCase();
    var lower = availableLocales.map(function (l) { return String(l).toLowerCase(); });
    // 1. exact match
    var i = lower.indexOf(t);
    if (i !== -1) return availableLocales[i];
    // 2. same base language (fr vs fr-FR)
    var base = t.split("-")[0];
    for (var j = 0; j < lower.length; j++) {
      if (lower[j].split("-")[0] === base) return availableLocales[j];
    }
    return null;
  }

  // Ask Shopify which country/language it detected for THIS visitor by IP.
  // window.Shopify.country only reflects the currently-active market (defaults
  // to the shop's setting), so it can't be used for geo-detection — this
  // endpoint is the supported source of the visitor's real detected location.
  // https://shopify.dev/docs/storefronts/themes/markets/localization-discovery
  function fetchDetectedLocalization() {
    var root = (window.Shopify && window.Shopify.routes && window.Shopify.routes.root) || "/";
    var url = root +
      "browsing_context_suggestions.json?country[enabled]=true&language[enabled]=true";
    return fetch(url, { headers: { Accept: "application/json" } })
      .then(function (r) { return r.ok ? r.json() : null; })
      .catch(function (e) { log("suggestions fetch failed", e); return null; });
  }

  /**
   * On the visitor's first visit, ask Shopify what country/language it detected
   * from their IP, and if we support that language, switch them to it.
   */
  function runAutoDetect() {
    if (!autoDetect) { log("auto-detect disabled"); return; }

    // If the customer has already manually chosen, respect that forever.
    var savedLocale = null;
    var savedCountry = null;
    try {
      savedLocale = localStorage.getItem(LOCALE_KEY);
      savedCountry = localStorage.getItem(COUNTRY_KEY);
    } catch (_) {}

    if (savedLocale || savedCountry) {
      log("prior choice found, not redirecting", { savedLocale: savedLocale, savedCountry: savedCountry });
      return;
    }

    fetchDetectedLocalization().then(function (data) {
      var detected = (data && data.detected_values) || {};
      var detectedCountry = detected.country && detected.country.handle
        ? String(detected.country.handle).toUpperCase()
        : "";

      // Shopify may also directly suggest a language for this visitor — prefer
      // that, then fall back to our country -> language map.
      var suggestedLang = null;
      if (data && data.suggestions && data.suggestions.length) {
        var parts = data.suggestions[0].parts || {};
        if (parts.language && parts.language.handle) suggestedLang = parts.language.handle;
      }

      log("Shopify detected", { country: detectedCountry || "(none)", suggestedLanguage: suggestedLang || "(none)" },
        "current locale", currentLocale, "available", availableLocales);

      if (!detectedCountry && !suggestedLang) { log("nothing detected, aborting"); return; }

      var wantLocale = suggestedLang || countryToLocale[detectedCountry];
      if (!wantLocale) { log("no language for detected country", detectedCountry); return; }

      var targetLocale = resolveAvailableLocale(wantLocale);
      if (!targetLocale) {
        log("language", wantLocale, "is not a PUBLISHED locale on this shop — publish it on the Languages page");
        return;
      }

      if (String(targetLocale).toLowerCase() === String(currentLocale).toLowerCase()) {
        log("already showing target locale", targetLocale);
        return;
      }

      // Mark as handled so we don't loop or override the customer later.
      try { localStorage.setItem(LOCALE_KEY, targetLocale); } catch (_) {}

      // Also switch the country/market (for currency) if it's available.
      var matchingCountry = null;
      if (detectedCountry && availableCountries.indexOf(detectedCountry) !== -1) {
        matchingCountry = detectedCountry;
        try { localStorage.setItem(COUNTRY_KEY, detectedCountry); } catch (_) {}
      }

      var form = document.getElementById("translator-localization-form");
      if (!form) { log("localization form not found (block needs >1 language/country)"); return; }

      var langInput = form.querySelector('select[name="language_code"]');
      if (langInput) langInput.value = targetLocale;

      if (matchingCountry) {
        var countryInput = form.querySelector('select[name="country_code"]');
        if (countryInput) countryInput.value = matchingCountry;
      }

      log("switching to", { language: targetLocale, country: matchingCountry || "(unchanged)" });
      form.submit();
    });
  }

  function start() {
    initSelects();
    runAutoDetect();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }
})();
