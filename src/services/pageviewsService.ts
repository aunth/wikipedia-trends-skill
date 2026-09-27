import { format } from "date-fns";
import { config } from "../config";
import { getWithRetry, isNotFoundError, describeAxiosError } from "../utils/httpClient";
import { cacheKeyFor, withHttpCache } from "./cacheService";
import { ArticleRef, DailyPageview } from "../types";

/**
 * Pageviews Fetcher.
 *
 * Talks to the Wikimedia REST API's per-article daily pageviews endpoint. This
 * module's only job is "get clean daily (date, views) pairs for one article" --
 * all aggregation/math lives in `utils/math.ts` and `analyticsService.ts` so this
 * stays a thin, testable I/O boundary.
 */

interface PageviewsApiResponse {
  items?: Array<{
    project: string;
    article: string;
    granularity: string;
    timestamp: string; // yyyyMMddHH, e.g. "2024010100"
    access: string;
    agent: string;
    views: number;
  }>;
}

function toWikimediaDate(date: Date): string {
  return format(date, "yyyyMMdd");
}

function fromWikimediaTimestamp(timestamp: string): string {
  // timestamp is "yyyyMMddHH" -- we only need the date part.
  const y = timestamp.slice(0, 4);
  const m = timestamp.slice(4, 6);
  const d = timestamp.slice(6, 8);
  return `${y}-${m}-${d}`;
}

export interface FetchResult {
  article: ArticleRef;
  series: DailyPageview[];
  found: boolean;
  warning?: string;
}

/**
 * Fetches daily pageviews for one article across [start, end] (inclusive).
 *
 * A 404 from this endpoint has two legitimate causes: the article doesn't exist
 * in that language project, or Wikimedia simply has no pageview data for the
 * requested range (e.g. article created after the range started). Either way,
 * we treat it as "no data" rather than a hard failure -- the caller decides
 * whether that's fatal for the overall request.
 */
export async function fetchDailyPageviews(
  article: ArticleRef,
  start: Date,
  end: Date
): Promise<FetchResult> {
  const encodedTitle = encodeURIComponent(article.title.replace(/ /g, "_"));
  const url = [
    config.pageviewsApiUrl,
    `${article.lang}.wikipedia.org`,
    "all-access",
    "all-agents",
    encodedTitle,
    "daily",
    toWikimediaDate(start),
    toWikimediaDate(end),
  ].join("/");

  const key = cacheKeyFor(url);

  try {
    const data = await withHttpCache(key, () => getWithRetry<PageviewsApiResponse>(url));
    const series: DailyPageview[] = (data.items ?? []).map((item) => ({
      date: fromWikimediaTimestamp(item.timestamp),
      views: item.views,
    }));

    return { article, series, found: series.length > 0 };
  } catch (error) {
    if (isNotFoundError(error)) {
      return {
        article,
        series: [],
        found: false,
        warning: `No pageview data found for "${article.title}" (${article.lang}) in the requested period -- the article may not exist in this language, or may be too new.`,
      };
    }

    return {
      article,
      series: [],
      found: false,
      warning: `Failed to fetch pageviews for "${article.title}" (${article.lang}): ${describeAxiosError(
        error
      )}`,
    };
  }
}

export async function fetchDailyPageviewsForArticles(
  articles: ArticleRef[],
  start: Date,
  end: Date
): Promise<FetchResult[]> {
  // Sequential rather than Promise.all: Wikimedia's etiquette policy asks for
  // considerate request pacing, and the retry/backoff logic already adds
  // latency per call -- fanning out 15 concurrent retrying requests would be
  // the opposite of "respect the rate limit". Each request is fast (<1s) so
  // sequential fetching for a handful of articles is not a real UX cost.
  const results: FetchResult[] = [];
  for (const article of articles) {
    results.push(await fetchDailyPageviews(article, start, end));
  }
  return results;
}
