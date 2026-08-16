/**
 * Language & Country Selector — Storefront Script
 *
 * Responsibilities:
 *   1. Auto-submit the localization form when the visitor changes the
 *      language/country <select> (no separate button needed).
 *   2. Geo-detect the visitor's country on their first visit and switch them to
 *      the matching language automatically.
 *
 * Detection is intentionally multi-signal and defensive — a single source
 * (Shopify's suggestion endpoint) can be empty or shaped differently across
 * stores, so we combine it with the browser's own locale and try several
 * candidate languages before giving up. Every decision is logged (append
 * ?translator_debug=1 to any storefront URL to see an on-page panel).
 */
(function () {
  "use strict";

  var LOCALE_KEY = "translator_locale";
  var COUNTRY_KEY = "translator_country";
  // Per-session marker so one auto-switch attempt can't loop. sessionStorage
  // (not localStorage) so a failed switch retries in a new session.
  var ATTEMPT_KEY = "translator_auto_attempted";

  // Country ISO → preferred language locale. Merchants can extend/override via
  // the block's "Custom country → locale overrides" setting.
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

  // Merchant override map arrives as a JSON *string* (theme textarea). Parse safely.
  var customMap = {};
  var rawCustomMap = config.customCountryMap;
  if (rawCustomMap && typeof rawCustomMap === "string") {
    try { customMap = JSON.parse(rawCustomMap) || {}; } catch (_) { customMap = {}; }
  } else if (rawCustomMap && typeof rawCustomMap === "object") {
    customMap = rawCustomMap;
  }
  var countryToLocale = Object.assign({}, DEFAULT_MAP, customMap);

  // ---- URL flags -----------------------------------------------------------
  function hasFlag(name) {
    try { return new RegExp("[?&]" + name + "=1\\b").test(window.location.search); } catch (_) { return false; }
  }
  var DEBUG = hasFlag("translator_debug");
  // Clears any saved preference so detection runs fresh (useful for testing).
  var RESET = hasFlag("translator_reset");
  // Like reset, but also ignores the "manual choice" guard for this run — forces
  // a re-detect even if the visitor previously picked a language. Test-only.
  var FORCE = hasFlag("translator_force");

  // ---- Debug panel ---------------------------------------------------------
  var _panel = null;
  function debugPanel() {
    if (!DEBUG) return null;
    if (_panel) return _panel;
    var el = document.createElement("div");
    el.id = "translator-debug";
    el.style.cssText =
      "position:fixed;bottom:10px;right:10px;z-index:2147483000;max-width:400px;max-height:50vh;" +
      "overflow:auto;background:#111;color:#5f5;font:12px/1.45 monospace;padding:10px 12px;" +
      "border-radius:8px;white-space:pre-wrap;box-shadow:0 2px 12px rgba(0,0,0,.4)";
    el.textContent = "[translator debug]\n";
    (document.body || document.documentElement).appendChild(el);
    _panel = el;
    return el;
  }
  function log() {
    if (!DEBUG) return;
    var args = [].slice.call(arguments);
    if (window.console) console.info.apply(console, ["[translator]"].concat(args));
    var panel = debugPanel();
    if (panel) {
      try {
        panel.textContent += args
          .map(function (a) { return typeof a === "object" ? JSON.stringify(a) : String(a); })
          .join(" ") + "\n";
      } catch (_) {}
    }
  }

  // ---- Locale resolution ---------------------------------------------------
  // Find the best AVAILABLE locale for a wanted language. Handles exact matches
  // ("fr" -> "fr"), region variants ("fr" -> "fr-FR", "pt-BR" -> "pt"), and
  // base-language matches in either direction.
  function resolveAvailableLocale(want) {
    if (!want) return null;
    var t = String(want).toLowerCase();
    var lower = availableLocales.map(function (l) { return String(l).toLowerCase(); });
    var i = lower.indexOf(t);
    if (i !== -1) return availableLocales[i];
    var base = t.split("-")[0];
    for (var j = 0; j < lower.length; j++) {
      if (lower[j].split("-")[0] === base) return availableLocales[j];
    }
    return null;
  }

  // ---- Country normalization ----------------------------------------------
  // A country object from Shopify may expose its ISO code under different keys
  // depending on the endpoint/version. Pull out a clean 2-letter uppercase code.
  function normalizeCountry(obj) {
    if (!obj) return "";
    var raw = obj.handle || obj.iso_code || obj.code || obj.country_code || "";
    raw = String(raw).toUpperCase().trim();
    return /^[A-Z]{2}$/.test(raw) ? raw : "";
  }

  // The browser's own locale as a fallback signal, e.g. "es-ES" -> { country:
  // "ES", lang: "es" }. Country hint from the browser is weaker than IP (a
  // French speaker in Spain), so it's only used as a last resort for language.
  function browserLocaleHint() {
    var l = "";
    try { l = (navigator.languages && navigator.languages[0]) || navigator.language || ""; } catch (_) {}
    if (!l) return { country: "", lang: "" };
    var parts = String(l).split("-");
    return {
      lang: (parts[0] || "").toLowerCase(),
      country: parts[1] ? parts[1].toUpperCase() : "",
    };
  }

  // ---- Selects: auto-submit on change -------------------------------------
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

  // ---- Geo detection -------------------------------------------------------
  // Ask Shopify what it detected for THIS visitor (IP-based). window.Shopify.country
  // only reflects the active market, so it can't be used for detection — this
  // endpoint is the supported source of the visitor's real location.
  // https://shopify.dev/docs/storefronts/themes/markets/localization-discovery
  function fetchDetected() {
    var root = (window.Shopify && window.Shopify.routes && window.Shopify.routes.root) || "/";
    // Cache-bust so a CDN-cached English response can't mask a real detection.
    var url = root + "browsing_context_suggestions.json?country[enabled]=true&language[enabled]=true&_ts=" + Date.now();
    log("fetching geo endpoint", url);

    var controller = typeof AbortController !== "undefined" ? new AbortController() : null;
    var timer = controller ? setTimeout(function () { controller.abort(); }, 6000) : null;

    return fetch(url, { headers: { Accept: "application/json" }, signal: controller ? controller.signal : undefined })
      .then(function (r) {
        if (timer) clearTimeout(timer);
        log("geo endpoint status", r.status, r.ok ? "OK" : "(not served on this domain — use the real storefront, not a preview link)");
        return r.ok ? r.json() : null;
      })
      .catch(function (e) {
        if (timer) clearTimeout(timer);
        log("geo fetch failed", String(e && e.message ? e.message : e));
        return null;
      });
  }

  // Reduce the endpoint payload + browser hint into detection signals.
  function extractSignals(data) {
    var detected = (data && data.detected_values) || {};
    var suggestion = data && data.suggestions && data.suggestions.length ? data.suggestions[0].parts || {} : {};

    var country =
      normalizeCountry(detected.country) ||
      normalizeCountry(suggestion.country) ||
      "";

    var suggestedLang = "";
    if (suggestion.language && suggestion.language.handle) suggestedLang = String(suggestion.language.handle).toLowerCase();
    else if (detected.language && detected.language.handle) suggestedLang = String(detected.language.handle).toLowerCase();

    var hint = browserLocaleHint();
    if (!country && hint.country) country = hint.country; // last-resort country

    return { country: country, suggestedLang: suggestedLang, browserLang: hint.lang };
  }

  function runAutoDetect() {
    if (!autoDetect) { log("auto-detect disabled by theme setting"); return; }

    if (RESET || FORCE) {
      try { localStorage.removeItem(LOCALE_KEY); localStorage.removeItem(COUNTRY_KEY); } catch (_) {}
      try { sessionStorage.removeItem(ATTEMPT_KEY); } catch (_) {}
      log(FORCE ? "force: ignoring saved preference + attempt guard" : "reset: cleared saved preference + attempt marker");
    }

    if (!FORCE) {
      var savedLocale = null, savedCountry = null;
      try { savedLocale = localStorage.getItem(LOCALE_KEY); savedCountry = localStorage.getItem(COUNTRY_KEY); } catch (_) {}
      if (savedLocale || savedCountry) {
        log("manual choice found — respecting it, not auto-switching", { savedLocale: savedLocale, savedCountry: savedCountry });
        return;
      }
      var attempted = null;
      try { attempted = sessionStorage.getItem(ATTEMPT_KEY); } catch (_) {}
      if (attempted) { log("already attempted this session (target was " + attempted + ")"); return; }
    }

    log("context", { currentLocale: currentLocale, currentCountry: currentCountry, availableLocales: availableLocales });
    if (availableLocales.length < 2) {
      log("only one language available for this market (" + JSON.stringify(availableLocales) + ") — nothing to switch to. Add the target language to this market in the app's Markets & Currency page.");
      return;
    }

    fetchDetected().then(function (data) {
      var s = extractSignals(data);
      log("detected", { country: s.country || "(none)", shopifySuggestedLang: s.suggestedLang || "(none)", browserLang: s.browserLang || "(none)" });

      // Candidate languages, best signal first:
      //   1. our country -> language map (country-based, the app's core promise)
      //   2. Shopify's own suggested language
      //   3. the browser's language
      var candidates = [];
      if (s.country && countryToLocale[s.country]) candidates.push({ want: countryToLocale[s.country], via: "country " + s.country });
      if (s.suggestedLang) candidates.push({ want: s.suggestedLang, via: "shopify suggestion" });
      if (s.browserLang) candidates.push({ want: s.browserLang, via: "browser language" });

      if (candidates.length === 0) { log("no usable signal (no country map, no suggestion, no browser lang) — staying put"); return; }

      var target = null, chosenVia = "";
      for (var i = 0; i < candidates.length; i++) {
        var resolved = resolveAvailableLocale(candidates[i].want);
        log("candidate", candidates[i].want, "via", candidates[i].via, "->", resolved || "(not available in this market)");
        if (resolved) { target = resolved; chosenVia = candidates[i].via; break; }
      }

      if (!target) {
        log("none of the detected languages are available for this market. Available:", availableLocales,
            "— add the language to this market in the app's Markets & Currency page, and publish it under Languages.");
        return;
      }

      if (String(target).toLowerCase() === String(currentLocale).toLowerCase()) {
        log("already showing the target locale", target, "(via " + chosenVia + ") — nothing to do");
        return;
      }

      try { sessionStorage.setItem(ATTEMPT_KEY, target); } catch (_) {}

      var form = document.getElementById("translator-localization-form");
      if (!form) { log("localization form not present (needs >1 language or >1 country) — cannot switch"); return; }

      var langInput = form.querySelector('select[name="language_code"]');
      if (langInput) langInput.value = target;

      // Also switch country/market for currency, when the detected country is
      // one this storefront actually offers.
      var matchingCountry = "";
      if (s.country && availableCountries.indexOf(s.country) !== -1) {
        matchingCountry = s.country;
        var countryInput = form.querySelector('select[name="country_code"]');
        if (countryInput) countryInput.value = matchingCountry;
      }

      log("SWITCHING", { language: target, via: chosenVia, country: matchingCountry || "(unchanged)" });
      form.submit();
    });
  }

  function start() {
    log("widget loaded", { host: location.host, currentLocale: currentLocale, currentCountry: currentCountry, autoDetect: autoDetect });
    initSelects();
    runAutoDetect();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }
})();
