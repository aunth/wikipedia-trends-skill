import { test, describe, mock } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { httpClient } from "../utils/httpClient";
import { resolveTopicLanguages } from "./wikidataService";

// Topics carry a random suffix purely so each test's request hits a fresh
// cache key -- withHttpCache is disk-persistent, so a stable topic string
// could otherwise be served from a leftover real cache entry instead of
// exercising the mocked httpClient response below.
function uniqueTopic(base: string): string {
  return `${base} ${crypto.randomUUID()}`;
}

function mockWikidata(impl: (params: Record<string, unknown>) => unknown) {
  mock.method(httpClient, "get", async (_url: string, requestConfig: { params?: Record<string, unknown> }) => ({
    data: impl(requestConfig?.params ?? {}),
  }));
}

describe("resolveTopicLanguages", () => {
  test("resolves per-language titles and surfaces the matched entity's label/description", async () => {
    mockWikidata((params) => {
      if (params.action === "wbsearchentities") {
        return { search: [{ id: "Q1", label: "Intermittent fasting", description: "eating pattern" }] };
      }
      if (params.action === "wbgetentities") {
        return {
          entities: {
            Q1: {
              sitelinks: {
                ukwiki: { site: "ukwiki", title: "Інтервальне голодування" },
                plwiki: { site: "plwiki", title: "Przerywany post" },
              },
            },
          },
        };
      }
      throw new Error(`unexpected Wikidata action: ${params.action}`);
    });

    try {
      const result = await resolveTopicLanguages({
        topic: uniqueTopic("Intermittent fasting"),
        source_language: "en",
        target_languages: ["uk", "pl", "de"],
      });

      assert.equal(result.ok, true);
      assert.equal(result.wikidata_id, "Q1");
      assert.equal(result.matched_label, "Intermittent fasting");
      assert.equal(result.matched_description, "eating pattern");
      assert.deepEqual(result.resolved, [
        { lang: "uk", title: "Інтервальне голодування" },
        { lang: "pl", title: "Przerywany post" },
      ]);
      assert.deepEqual(result.missing_languages, ["de"]);
    } finally {
      mock.restoreAll();
    }
  });

  test("reports ok:false when the topic matches no Wikidata entity at all", async () => {
    mockWikidata((params) => {
      if (params.action === "wbsearchentities") return { search: [] };
      throw new Error("should not call wbgetentities when nothing was found");
    });

    try {
      const result = await resolveTopicLanguages({
        topic: uniqueTopic("Definitely Not A Real Topic"),
        source_language: "en",
        target_languages: ["uk"],
      });

      assert.equal(result.ok, false);
      assert.equal(result.wikidata_id, null);
      assert.deepEqual(result.resolved, []);
      assert.deepEqual(result.missing_languages, ["uk"]);
    } finally {
      mock.restoreAll();
    }
  });

  test("a network failure during search surfaces as ok:false with a network-issue message", async () => {
    mock.method(httpClient, "get", async () => {
      throw new Error("ECONNREFUSED");
    });

    try {
      const result = await resolveTopicLanguages({
        topic: uniqueTopic("Anything"),
        source_language: "en",
        target_languages: ["uk"],
      });

      assert.equal(result.ok, false);
      assert.match(result.message, /network|API issue/i);
    } finally {
      mock.restoreAll();
    }
  });
});
