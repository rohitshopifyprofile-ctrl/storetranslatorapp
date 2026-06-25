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

  // Merge default map with merchant overrides
  var countryToLocale = Object.assign({}, DEFAULT_MAP, config.customCountryMap || {});

  /**
   * Wire up the <select> elements to auto-submit on change and save preference.
   */
  function initSelects() {
    var form = document.getElementById("translator-localization-form");
    if (!form) return;

    var selects = form.querySelectorAll("select");
    selects.forEach(function (sel) {
      sel.addEventListener("change", function () {
        if (sel.name === "locale") {
          try { localStorage.setItem(LOCALE_KEY, sel.value); } catch (_) {}
        } else if (sel.name === "country_code") {
          try { localStorage.setItem(COUNTRY_KEY, sel.value); } catch (_) {}
        }
        form.submit();
      });
    });
  }

  /**
   * On the visitor's first visit, check if their detected country maps to a
   * locale we support, and if so redirect them to it.
   */
  function runAutoDetect() {
    if (!autoDetect) return;

    // If the customer has already manually chosen, respect that forever.
    var savedLocale = null;
    var savedCountry = null;
    try {
      savedLocale = localStorage.getItem(LOCALE_KEY);
      savedCountry = localStorage.getItem(COUNTRY_KEY);
    } catch (_) {}

    if (savedLocale || savedCountry) return;

    // Shopify injects window.Shopify.country (ISO-3166 alpha-2) via geo-detection.
    var detectedCountry =
      (window.Shopify && window.Shopify.country) || currentCountry;

    if (!detectedCountry) return;

    var targetLocale = countryToLocale[detectedCountry];
    if (!targetLocale) return; // No mapping for this country

    // Only redirect if the locale is available in this shop and differs from current.
    if (targetLocale === currentLocale) return;
    if (availableLocales.indexOf(targetLocale) === -1) return;

    // Mark as auto-redirected so we don't loop.
    try { localStorage.setItem(LOCALE_KEY, targetLocale); } catch (_) {}

    // Find the country that matches (so we also switch the market/currency).
    var matchingCountry = null;
    if (availableCountries.indexOf(detectedCountry) !== -1) {
      matchingCountry = detectedCountry;
      try { localStorage.setItem(COUNTRY_KEY, detectedCountry); } catch (_) {}
    }

    // Submit the form programmatically.
    var form = document.getElementById("translator-localization-form");
    if (!form) return;

    var localeInput = form.querySelector('select[name="locale"]');
    if (localeInput) localeInput.value = targetLocale;

    if (matchingCountry) {
      var countryInput = form.querySelector('select[name="country_code"]');
      if (countryInput) countryInput.value = matchingCountry;
    }

    form.submit();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", function () {
      initSelects();
      // Small delay so Shopify.country is populated before we read it.
      setTimeout(runAutoDetect, 300);
    });
  } else {
    initSelects();
    setTimeout(runAutoDetect, 300);
  }
})();
