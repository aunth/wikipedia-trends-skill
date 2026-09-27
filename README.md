# Wikipedia Trends Skill

Agent Skill (tool set) for an LLM to compare public interest in a topic across
Wikipedia language editions and produce a 1-page PDF report. See `SKILL.md`
for the LLM-facing usage manual (workflow, error handling, scaling notes).

## Setup

```bash
npm install
npm run build
```

### macOS: `canvas` native dependency

Chart rendering uses `canvas` (via `chartjs-node-canvas`), which compiles a
native Cairo/Pango binding. On a fresh machine you may need:

```bash
brew install pkg-config cairo pango libpng jpeg giflib librsvg pixman
```

This project pins `canvas` to `^3.2.3` via an `overrides` entry (see
`package.json`) because `chartjs-node-canvas@4.x` declares a `canvas ^2.8.0`
dependency, but `canvas@2.x` does not build against current Node's V8 API.
`canvas@3.x` ships NAPI prebuilds and works fine with `chartjs-node-canvas`'s
actual usage (it only needs `createCanvas`/`registerFont`), so the override is
safe.

### Zod version pin

`zod` and `zod-to-json-schema` are pinned to `3.23.8` / `3.23.5`. Newer `zod`
3.25.x releases changed internal types in a way that makes
`zod-to-json-schema`'s generics blow up TypeScript's instantiation-depth limit
("Type instantiation is excessively deep"). These pinned versions are a known
good combination; bump both together and re-run `npm run build` if you change
either.

## Try it end-to-end (no LLM required)

```bash
npm run dev -- "Intermittent fasting" en uk,pl,de
```

This runs `resolve_topic_languages` -> `analyze_wikipedia_trends` ->
`generate_research_report` in sequence, exactly as an LLM tool loop would, and
writes a PDF to `output/`.

## Wiring into an actual LLM agent loop

```ts
import { getAnthropicToolDefinitions, runTool } from "./src/tools";

// Pass getAnthropicToolDefinitions() as the `tools` array in an Anthropic
// Messages API call. When the model returns a tool_use block, dispatch it:
const result = await runTool(toolUseBlock.name, toolUseBlock.input);
```

## Project layout

```
src/
  config.ts              Central config (User-Agent, thresholds, paths)
  types.ts                Zod schemas + shared TypeScript types
  utils/
    httpClient.ts          Retrying axios client with Wikimedia-compliant UA
    math.ts                Deterministic aggregation math (totals, trend, anomalies)
  services/
    wikidataService.ts     Module 1: topic -> per-language article titles
    pageviewsService.ts    Module 2a: raw daily pageviews fetch
    analyticsService.ts    Module 2b: fetch + reduce + persist dataset
    chartService.ts        Module 3a: multi-line comparison chart (PNG)
    pdfService.ts          Module 3b: 1-page PDF layout
    cacheService.ts        HTTP response cache (TTL) + dataset store (disk)
  tools/
    resolveTopicLanguages.ts
    analyzeWikipediaTrends.ts
    generateResearchReport.ts
    index.ts               Tool registry + dispatcher
assets/fonts/              Bundled Unicode font (DejaVu Sans) for non-Latin titles
data/                       Cache + persisted dataset JSON (gitignored)
output/                     Generated PDF reports (gitignored)
```

## Known limitations

- **Scripts requiring text shaping** (Arabic, Hebrew, and CJK line-breaking)
  are not rendered/laid out correctly by PDFKit -- the bundled font (DejaVu
  Sans) covers Latin/Cyrillic/Greek, which covers the large majority of
  Wikipedia language editions, but not all of them.
- The dataset store is local JSON files, sized for a single-process agent
  session, not concurrent multi-user production traffic (see SKILL.md's
  "Iterative Development" section for the scale-up path).
