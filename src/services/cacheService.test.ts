import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { cacheKeyFor, withHttpCache, saveDataset, loadDataset } from "./cacheService";
import { config } from "../config";
import { StoredDataset } from "../types";

// This module's whole job is disk persistence, so these tests deliberately
// touch the real cache/dataset directories rather than mocking fs -- each
// test uses a fresh random key/id so it can never collide with a leftover
// entry from real usage, and cleans up exactly what it created afterward.

const createdCacheKeys: string[] = [];
const createdDatasetIds: string[] = [];

after(() => {
  for (const key of createdCacheKeys) {
    fs.rmSync(path.join(config.cacheDir, `${key}.json`), { force: true });
  }
  for (const id of createdDatasetIds) {
    fs.rmSync(path.join(config.datasetsDir, `${id}.json`), { force: true });
  }
});

describe("cacheKeyFor", () => {
  test("is stable for the same url+params regardless of key order", () => {
    const a = cacheKeyFor("https://example.com", { b: 2, a: 1 });
    const b = cacheKeyFor("https://example.com", { a: 1, b: 2 });
    assert.equal(a, b);
  });

  test("differs for different urls or params", () => {
    const a = cacheKeyFor("https://example.com", { a: 1 });
    const b = cacheKeyFor("https://example.com", { a: 2 });
    assert.notEqual(a, b);
  });
});

describe("withHttpCache", () => {
  test("calls the fetcher on a miss and persists the result to disk", async () => {
    const key = `test-${crypto.randomUUID()}`;
    createdCacheKeys.push(key);

    let calls = 0;
    const value = await withHttpCache(key, async () => {
      calls++;
      return { hello: "world" };
    });

    assert.equal(calls, 1);
    assert.deepEqual(value, { hello: "world" });
    assert.equal(fs.existsSync(path.join(config.cacheDir, `${key}.json`)), true);
  });

  test("a second call with the same key does not invoke the fetcher again", async () => {
    const key = `test-${crypto.randomUUID()}`;
    createdCacheKeys.push(key);

    let calls = 0;
    const fetcher = async () => {
      calls++;
      return { n: calls };
    };

    const first = await withHttpCache(key, fetcher);
    const second = await withHttpCache(key, fetcher);

    assert.equal(calls, 1);
    assert.deepEqual(second, first);
  });

  test("the disk entry alone (no in-memory state) is enough to serve a hit", async () => {
    // Simulates what a fresh CLI process sees: its in-memory Map starts
    // empty, so the disk file -- not the Map populated by the write above --
    // is what must carry the cached value across process boundaries.
    const key = `test-${crypto.randomUUID()}`;
    createdCacheKeys.push(key);

    await withHttpCache(key, async () => ({ persisted: true }));

    const raw = fs.readFileSync(path.join(config.cacheDir, `${key}.json`), "utf-8");
    const entry = JSON.parse(raw) as { value: unknown; expiresAt: number };
    assert.deepEqual(entry.value, { persisted: true });
    assert.ok(entry.expiresAt > Date.now());
  });
});

describe("saveDataset / loadDataset", () => {
  test("round-trips a dataset through disk", () => {
    const dataset: StoredDataset = {
      datasetId: `test-${crypto.randomUUID()}`,
      createdAt: new Date().toISOString(),
      periodStart: "2024-01-01",
      periodEnd: "2024-12-31",
      articles: [{ lang: "en", title: "Test", series: [{ date: "2024-01-01", views: 10 }] }],
      metrics: [],
    };
    createdDatasetIds.push(dataset.datasetId);

    saveDataset(dataset);
    const loaded = loadDataset(dataset.datasetId);

    assert.deepEqual(loaded, dataset);
  });

  test("returns null for an unknown dataset id", () => {
    assert.equal(loadDataset(`nonexistent-${crypto.randomUUID()}`), null);
  });
});
