import { test, describe, mock } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { httpClient } from "../utils/httpClient";
import { fetchDailyPageviews } from "./pageviewsService";

// Titles carry a random suffix purely so each test's request hits a fresh
// cache key -- withHttpCache is disk-persistent, so a stable title could
// otherwise be served from a leftover real cache entry instead of exercising
// the mocked httpClient response below.
function uniqueTitle(base: string): string {
  return `${base} ${crypto.randomUUID()}`;
}

describe("fetchDailyPageviews", () => {
  test("maps a successful response to a clean daily series", async () => {
    mock.method(httpClient, "get", async () => ({
      data: {
        items: [
          { timestamp: "2024010100", views: 42 },
          { timestamp: "2024010200", views: 58 },
        ],
      },
    }));

    try {
      const result = await fetchDailyPageviews(
        { lang: "en", title: uniqueTitle("Test Article") },
        new Date("2024-01-01"),
        new Date("2024-01-02")
      );

      assert.equal(result.found, true);
      assert.deepEqual(result.series, [
        { date: "2024-01-01", views: 42 },
        { date: "2024-01-02", views: 58 },
      ]);
      assert.equal(result.warning, undefined);
    } finally {
      mock.restoreAll();
    }
  });

  test("a 404 is treated as 'no data', not a hard failure", async () => {
    mock.method(httpClient, "get", async () => {
      const err = Object.assign(new Error("Request failed with status code 404"), {
        isAxiosError: true,
        response: { status: 404 },
      });
      throw err;
    });

    try {
      const result = await fetchDailyPageviews(
        { lang: "en", title: uniqueTitle("Nonexistent Article") },
        new Date("2024-01-01"),
        new Date("2024-01-02")
      );

      assert.equal(result.found, false);
      assert.deepEqual(result.series, []);
      assert.match(result.warning ?? "", /No pageview data found/);
    } finally {
      mock.restoreAll();
    }
  });

  test("a non-retryable error surfaces as a descriptive warning, not a thrown exception", async () => {
    mock.method(httpClient, "get", async () => {
      const err = Object.assign(new Error("Request failed with status code 400"), {
        isAxiosError: true,
        response: { status: 400 },
        config: { url: "https://wikimedia.org/api/rest_v1/metrics/pageviews/per-article/..." },
      });
      throw err;
    });

    try {
      const result = await fetchDailyPageviews(
        { lang: "en", title: uniqueTitle("Bad Request Article") },
        new Date("2024-01-01"),
        new Date("2024-01-02")
      );

      assert.equal(result.found, false);
      assert.match(result.warning ?? "", /Failed to fetch pageviews/);
    } finally {
      mock.restoreAll();
    }
  });
});
