import { v4 as uuidv4 } from "uuid";
import { subMonths, subDays, format } from "date-fns";
import { fetchDailyPageviewsForArticles } from "./pageviewsService";
import { saveDataset } from "./cacheService";
import {
  totalViews,
  monthlyAverageViews,
  trendPercentage,
  detectAnomalies,
} from "../utils/math";
import {
  AnalyzeWikipediaTrendsInput,
  AnalyzeWikipediaTrendsOutput,
  ArticleTimeSeries,
  LanguageTrendMetrics,
  StoredDataset,
} from "../types";

/**
 * Orchestrates Module 2: fetch raw daily series per article, reduce each to a
 * compact metrics object, persist the raw series under a dataset_id, and
 * return ONLY the compact summary + dataset_id to the LLM.
 *
 * This split (persist full fidelity, return only the summary) is the core
 * token-efficiency mechanism the whole skill is built around: a 24-month daily
 * series is ~730 numbers per language, which would dominate the LLM's context
 * for no analytical benefit -- everything it needs to reason about is already
 * in the reduced metrics.
 */

// Wikimedia's pageviews API has a short lag before the most recent 1-2 days are
// available; anchoring "end" a few days in the past avoids spurious 404s/partial
// days at the tail of the range.
const PAGEVIEWS_API_LAG_DAYS = 3;

function computeMetrics(article: ArticleTimeSeries, found: boolean): LanguageTrendMetrics {
  if (!found || article.series.length === 0) {
    return {
      lang: article.lang,
      title: article.title,
      found: false,
      total_views: 0,
      monthly_average_views: 0,
      trend_percentage: 0,
      has_anomalies: false,
      anomaly_dates: [],
    };
  }

  const anomalies = detectAnomalies(article.series);

  return {
    lang: article.lang,
    title: article.title,
    found: true,
    total_views: totalViews(article.series),
    monthly_average_views: monthlyAverageViews(article.series),
    trend_percentage: trendPercentage(article.series),
    has_anomalies: anomalies.hasAnomalies,
    anomaly_dates: anomalies.anomalyDates,
  };
}

export async function analyzeWikipediaTrends(
  input: AnalyzeWikipediaTrendsInput
): Promise<AnalyzeWikipediaTrendsOutput> {
  const end = subDays(new Date(), PAGEVIEWS_API_LAG_DAYS);
  const start = subMonths(end, input.period_months);

  const fetchResults = await fetchDailyPageviewsForArticles(input.articles, start, end);

  const warnings: string[] = [];
  const articleSeries: ArticleTimeSeries[] = [];
  const metrics: LanguageTrendMetrics[] = [];

  for (const result of fetchResults) {
    if (result.warning) warnings.push(result.warning);

    const withSeries: ArticleTimeSeries = { ...result.article, series: result.series };
    articleSeries.push(withSeries);
    metrics.push(computeMetrics(withSeries, result.found));
  }

  const foundCount = metrics.filter((m) => m.found).length;
  if (foundCount === 0) {
    warnings.push(
      "No pageview data was found for ANY of the requested articles. Do not proceed to chart/report generation -- inform the user directly."
    );
  }

  const datasetId = uuidv4();
  const dataset: StoredDataset = {
    datasetId,
    createdAt: new Date().toISOString(),
    periodStart: format(start, "yyyy-MM-dd"),
    periodEnd: format(end, "yyyy-MM-dd"),
    articles: articleSeries,
    metrics,
  };
  saveDataset(dataset);

  return {
    dataset_id: datasetId,
    period_start: dataset.periodStart,
    period_end: dataset.periodEnd,
    languages: metrics,
    warnings,
  };
}
