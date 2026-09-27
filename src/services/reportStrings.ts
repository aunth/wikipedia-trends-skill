/**
 * Fixed report "chrome" (table headers, chart title, footer disclaimer, etc.)
 * localized per report_language. This is NOT full i18n -- it's a small,
 * hand-maintained dictionary covering the handful of literal strings the PDF
 * renders around the LLM's own (already-localized) analysis text and article
 * titles. Article titles and the LLM's analysis text are never touched here;
 * they arrive already in whatever language they should be in.
 *
 * Unsupported languages fall back to English chrome rather than erroring --
 * the report is still fully usable, just with English labels around
 * non-English content, which is strictly better than mixed-up or missing
 * labels.
 */
export interface ReportStrings {
  subtitleLabel: string; // e.g. "Wikipedia interest comparison"
  generatedLabel: string; // e.g. "Generated"
  defaultTitle: string; // used when the caller doesn't pass a `title`
  table: {
    lang: string;
    article: string;
    totalViews: string;
    monthlyAvg: string;
    trend: string;
    spikes: string;
    noData: string; // shown in a cell when found === false
    none: string; // "Spikes" cell when has_anomalies === false
    detectedSuffix: string; // "{n} <detectedSuffix>", e.g. "{n} detected"
  };
  analysisHeading: string;
  chartTitle: string;
}

const EN: ReportStrings = {
  subtitleLabel: "Wikipedia interest comparison",
  generatedLabel: "Generated",
  defaultTitle: "Wikipedia Market Interest Report",
  table: {
    lang: "Lang",
    article: "Article",
    totalViews: "Total Views",
    monthlyAvg: "Monthly Avg",
    trend: "Trend",
    spikes: "Spikes",
    noData: "no data",
    none: "None",
    detectedSuffix: "detected",
  },
  analysisHeading: "Analysis & Insights",
  chartTitle: "Weekly-average Wikipedia pageviews by language",
};

const UK: ReportStrings = {
  subtitleLabel: "Порівняння інтересу у Wikipedia",
  generatedLabel: "Згенеровано",
  defaultTitle: "Звіт про інтерес до теми у Wikipedia",
  table: {
    lang: "Мова",
    article: "Стаття",
    totalViews: "Перегляди",
    monthlyAvg: "Сер. на місяць",
    trend: "Тренд",
    spikes: "Аномалії",
    noData: "немає даних",
    none: "Немає",
    detectedSuffix: "виявлено",
  },
  analysisHeading: "Аналіз і висновки",
  chartTitle: "Перегляди Wikipedia по тижнях, за мовами",
};

const CATALOG: Record<string, ReportStrings> = { en: EN, uk: UK };

export function reportStringsFor(reportLanguage?: string): ReportStrings {
  return CATALOG[(reportLanguage ?? "en").toLowerCase()] ?? EN;
}
