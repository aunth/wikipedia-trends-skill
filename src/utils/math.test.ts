import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  sum,
  average,
  median,
  trailingMovingAverage,
  totalViews,
  monthlyAverageViews,
  trendPercentage,
  detectAnomalies,
} from "./math";
import { DailyPageview } from "../types";

function series(views: number[], startDate = "2026-01-01"): DailyPageview[] {
  const start = new Date(startDate);
  return views.map((v, i) => {
    const d = new Date(start);
    d.setDate(d.getDate() + i);
    return { date: d.toISOString().slice(0, 10), views: v };
  });
}

describe("sum / average / median", () => {
  test("sum of empty array is 0", () => {
    assert.equal(sum([]), 0);
  });

  test("average of empty array is 0, not NaN", () => {
    assert.equal(average([]), 0);
  });

  test("median handles odd and even length arrays", () => {
    assert.equal(median([3, 1, 2]), 2);
    assert.equal(median([1, 2, 3, 4]), 2.5);
    assert.equal(median([]), 0);
  });
});

describe("trailingMovingAverage", () => {
  test("uses partial history before the first full window instead of NaN", () => {
    const result = trailingMovingAverage([10, 20, 30], 7);
    assert.equal(result[0], 10);
    assert.equal(result[1], 15);
    assert.equal(result[2], 20);
  });
});

describe("totalViews / monthlyAverageViews", () => {
  test("totalViews sums raw daily views", () => {
    assert.equal(totalViews(series([10, 20, 30])), 60);
  });

  test("monthlyAverageViews derives from daily average, not calendar buckets", () => {
    // daily avg = 100 -> 100 * 30 = 3000
    assert.equal(monthlyAverageViews(series([100, 100, 100])), 3000);
  });

  test("monthlyAverageViews is 0 for an empty series", () => {
    assert.equal(monthlyAverageViews([]), 0);
  });
});

describe("trendPercentage", () => {
  test("flat series has 0% trend", () => {
    assert.equal(trendPercentage(series([100, 100, 100, 100])), 0);
  });

  test("second half double the first half is +100%", () => {
    assert.equal(trendPercentage(series([100, 100, 200, 200])), 100);
  });

  test("second half half the first half is -50%", () => {
    assert.equal(trendPercentage(series([200, 200, 100, 100])), -50);
  });

  test("fewer than 2 data points returns 0 rather than dividing by nothing", () => {
    assert.equal(trendPercentage(series([100])), 0);
    assert.equal(trendPercentage([]), 0);
  });

  test("zero baseline with zero follow-up returns 0, not NaN/Infinity", () => {
    assert.equal(trendPercentage(series([0, 0, 0, 0])), 0);
  });

  test("zero baseline with nonzero follow-up returns 100, not Infinity", () => {
    assert.equal(trendPercentage(series([0, 0, 50, 50])), 100);
  });
});

describe("detectAnomalies", () => {
  test("series shorter than the minimum window reports no anomalies", () => {
    const result = detectAnomalies(series([10, 10, 10, 5000]));
    assert.equal(result.hasAnomalies, false);
    assert.deepEqual(result.anomalyDates, []);
  });

  test("a single-day spike far above its trailing baseline is flagged", () => {
    const baseline = new Array(20).fill(100);
    const withSpike = [...baseline];
    withSpike[19] = 10000; // >> 300% of the trailing baseline
    const result = detectAnomalies(series(withSpike));
    assert.equal(result.hasAnomalies, true);
    assert.equal(result.anomalyDates.length, 1);
  });

  test("gradual, sustained doubling is NOT flagged as an anomaly", () => {
    // Trend growth should never trip the spike detector -- only single-day
    // jumps relative to *recent* history should. Ramp slowly upward.
    const gradual = Array.from({ length: 40 }, (_, i) => 100 + i * 5);
    const result = detectAnomalies(series(gradual));
    assert.equal(result.hasAnomalies, false);
  });

  test("median pre-filter stops one spike from masking the next day's baseline", () => {
    const baseline = new Array(25).fill(100);
    const withSpikes = [...baseline];
    withSpikes[15] = 10000; // first spike
    withSpikes[16] = 10000; // second consecutive spike -- baseline just before it should still be ~100, not inflated by day 15
    const result = detectAnomalies(series(withSpikes));
    assert.ok(result.anomalyDates.length >= 2, "both spike days should still be detected");
  });
});
