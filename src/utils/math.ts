import { DailyPageview } from "../types";
import { config } from "../config";

/**
 * Deterministic aggregation math, kept entirely out of LLM reach.
 *
 * Rationale for the module: an LLM asked to "eyeball" 730 daily numbers will
 * hallucinate trends and miscount. All of this is cheap, pure arithmetic --
 * there is no reason to spend tokens (or risk correctness) having a model do it.
 */

export function sum(values: number[]): number {
  return values.reduce((acc, v) => acc + v, 0);
}

export function average(values: number[]): number {
  return values.length === 0 ? 0 : sum(values) / values.length;
}

export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2 : (sorted[mid] as number);
}

/**
 * Trailing moving average: point i averages [i - window + 1, i]. Points before
 * the first full window use whatever history is available rather than NaN, so
 * short series still get a (slightly less stable) baseline for anomaly checks.
 */
export function trailingMovingAverage(values: number[], windowSize: number): number[] {
  const result: number[] = [];
  for (let i = 0; i < values.length; i++) {
    const start = Math.max(0, i - windowSize + 1);
    const window = values.slice(start, i + 1);
    result.push(average(window));
  }
  return result;
}

/**
 * Total views over the period. Simple sum -- no surprises here, but centralized
 * so every caller agrees on what "total" means (e.g. whether missing days count
 * as 0, which they do: absent day = zero traffic that day).
 */
export function totalViews(series: DailyPageview[]): number {
  return sum(series.map((d) => d.views));
}

/**
 * Average views per ~30-day month over the period, derived from the daily total
 * rather than calendar-month bucketing. This avoids partial-month distortion
 * (e.g. a period starting mid-month) while still being intuitive to a founder
 * reading "average monthly views".
 */
export function monthlyAverageViews(series: DailyPageview[]): number {
  if (series.length === 0) return 0;
  const dailyAverage = average(series.map((d) => d.views));
  return Math.round(dailyAverage * 30);
}

/**
 * Trend percentage: average daily views in the second half of the period vs the
 * first half. Chosen over "day 1 vs last day" because a single day is noisy;
 * chosen over linear regression slope because founders read "+42% vs first
 * half" far more easily than a slope coefficient, and it's just as deterministic.
 */
export function trendPercentage(series: DailyPageview[]): number {
  if (series.length < 2) return 0;

  const midpoint = Math.floor(series.length / 2);
  const firstHalf = series.slice(0, midpoint);
  const secondHalf = series.slice(midpoint);

  const firstAvg = average(firstHalf.map((d) => d.views));
  const secondAvg = average(secondHalf.map((d) => d.views));

  if (firstAvg === 0) {
    // Avoid a divide-by-zero producing Infinity: no baseline traffic means we
    // can't express a meaningful percentage change.
    return secondAvg > 0 ? 100 : 0;
  }

  return Math.round(((secondAvg - firstAvg) / firstAvg) * 1000) / 10; // one decimal place
}

export interface AnomalyDetectionResult {
  hasAnomalies: boolean;
  anomalyDates: string[];
}

/**
 * Flags days whose views exceed `thresholdMultiplier` times their own trailing
 * 7-day moving average -- a classic spike-vs-local-baseline check. A sliding
 * window (rather than the period-wide average) is essential here: a topic whose
 * popularity genuinely doubles over two years would otherwise trip a global
 * threshold every single day of its second year. Comparing each day only to its
 * own recent past isolates true single-day spikes (news events, viral moments)
 * from gradual, legitimate growth.
 *
 * The moving average itself is smoothed with a median pre-filter so that one
 * spike day doesn't inflate the very baseline it's being compared against for
 * the following days in its window.
 */
export function detectAnomalies(
  series: DailyPageview[],
  windowSize: number = config.movingAverageWindowDays,
  thresholdMultiplier: number = config.anomalyThresholdMultiplier
): AnomalyDetectionResult {
  if (series.length < config.minDaysForAnomalyDetection) {
    return { hasAnomalies: false, anomalyDates: [] };
  }

  const views = series.map((d) => d.views);
  const anomalyDates: string[] = [];

  for (let i = 0; i < series.length; i++) {
    const windowStart = Math.max(0, i - windowSize + 1);
    // Exclude the current day from its own baseline -- otherwise a spike partly
    // averages itself in and dilutes the very signal we're trying to detect.
    const priorWindow = views.slice(windowStart, i);
    if (priorWindow.length < 3) continue; // not enough history yet for a stable baseline

    // Median filter: robust to a prior spike still sitting inside the window.
    const baseline = median(priorWindow);
    if (baseline <= 0) continue; // no meaningful baseline to compare against

    const today = views[i] as number;
    if (today > baseline * thresholdMultiplier) {
      anomalyDates.push((series[i] as DailyPageview).date);
    }
  }

  return { hasAnomalies: anomalyDates.length > 0, anomalyDates };
}
