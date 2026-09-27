import path from "node:path";

/**
 * Centralized, environment-overridable configuration.
 *
 * Why a contact email is required in the User-Agent: Wikimedia's API etiquette
 * policy (https://meta.wikimedia.org/wiki/User-Agent_policy) blocks or throttles
 * generic/anonymous User-Agents. A descriptive UA with contact info is the
 * difference between "works reliably" and "gets silently rate-limited in prod".
 */
export const config = {
  userAgent:
    process.env.WIKI_SKILL_USER_AGENT ??
    "B2CMarketResearchAgent/1.0 (contact@example.com)",

  wikidataApiUrl: "https://www.wikidata.org/w/api.php",
  pageviewsApiUrl: "https://wikimedia.org/api/rest_v1/metrics/pageviews/per-article",

  // HTTP layer resilience
  httpTimeoutMs: 15_000,
  httpMaxRetries: 3,
  httpRetryBaseDelayMs: 500,

  // Cache TTLs. Wikidata sitelinks rarely change; pageviews for past days never
  // change once published, so both can be cached aggressively within a single
  // agent session (and beyond, since we persist to disk).
  httpCacheTtlMs: 6 * 60 * 60 * 1000, // 6 hours

  // Analytics
  defaultPeriodMonths: 24,
  movingAverageWindowDays: 7,
  anomalyThresholdMultiplier: 3.0, // a day is anomalous if views > 300% of its 7-day moving average
  minDaysForAnomalyDetection: 14, // need at least ~2 windows of data to be meaningful

  // Storage
  rootDir: path.resolve(__dirname, ".."),
  cacheDir: path.resolve(__dirname, "..", "data", "cache"),
  datasetsDir: path.resolve(__dirname, "..", "data", "datasets"),
  outputDir: path.resolve(__dirname, "..", "output"),

  // Fonts. Article titles come from Wikipedia in whatever script that language
  // uses (Cyrillic, Greek, Vietnamese diacritics, etc.) -- PDFKit's built-in
  // "Helvetica" is the Latin-1-only PDF core font and renders anything outside
  // that as mojibake. DejaVu Sans (bundled, SIL/Bitstream-derived permissive
  // license, see assets/fonts/LICENSE-DejaVuFonts.txt) covers Latin Extended,
  // Cyrillic and Greek, which covers the vast majority of Wikipedia language
  // editions. CJK/RTL scripts are a known gap -- see SKILL.md caveats.
  fontRegularPath: path.resolve(__dirname, "..", "assets", "fonts", "DejaVuSans.ttf"),
  fontBoldPath: path.resolve(__dirname, "..", "assets", "fonts", "DejaVuSans-Bold.ttf"),

  // Report generation
  maxAnalysisTextChars: 1800, // guarantees the analysis section fits on one PDF page
  chartWidthPx: 900,
  chartHeightPx: 420,
};
