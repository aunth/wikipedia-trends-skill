---
name: wikipedia-trends-skill
description: Compares public interest in a topic across Wikipedia language editions using pageview data, and can generate a 1-page PDF market-research report (trend chart + metrics table). Use this skill whenever a user wants to gauge or compare interest/awareness for a topic -- a product category, health trend, hobby, diet, course subject, etc. -- across different language markets (e.g. "is interest in X growing in Polish vs Czech Wikipedia?", "should we localize into Japanese?", "which topic should we build a course around next?"), or explicitly asks for a Wikipedia trends chart, comparison, or PDF report.
---

# Wikipedia Cross-Language Market Interest Skill

## Goal

You are helping a B2C product founder gauge public interest in a topic (a
product category, a health trend, a hobby, a diet, etc.) across different
language markets, using Wikipedia pageviews as a free, public proxy for
curiosity/awareness. You have three tools, each a command you run yourself
with your shell/code-execution tool:

1. `resolve_topic_languages` -- find the exact Wikipedia article title for a
   topic in each language of interest.
2. `analyze_wikipedia_trends` -- fetch pageview history for those articles and
   reduce it to comparable metrics (you never see the raw daily numbers).
3. `generate_research_report` -- turn your analysis into a 1-page PDF with a
   chart and a metrics table.

All the number-crunching (totals, averages, trend %, spike detection) and all
chart/PDF rendering happen in code, not in your head. Your job is
interpretation and narrative, not arithmetic -- never restate, recompute, or
"sanity check" the numbers by re-deriving them; trust the tool outputs.

## Setup (once per session)

This skill's logic is a small TypeScript project in this directory. Before
the first tool call, make sure it's built:

```bash
cd <this skill's directory>
[ -f dist/cli.js ] || (npm install --legacy-peer-deps && npm run build)
```

Skip this if `dist/cli.js` already exists -- it means an earlier turn already
built it.

## Running a tool

Every tool below is invoked the same way:

```bash
node dist/cli.js <tool_name> '<json_input>'
```

On success it prints exactly one line of JSON to stdout -- that's the tool's
output, described per-tool below. On failure it prints `{"error": "..."}` to
stderr and exits non-zero; treat that as the network/programming-error case
in "Handling missing/partial data" below, not as a normal "no data" result.

## Workflow

Follow this order. Do not skip steps or call them out of order.

### 1. Resolve

Run:

```bash
node dist/cli.js resolve_topic_languages '{"topic":"<topic as the user described it>","source_language":"<language the topic is written in, e.g. \"en\">","target_languages":["<Wikipedia language codes to compare, e.g. \"uk\", \"pl\">"]}'
```

Output: `{ ok, wikidata_id, resolved: [{lang, title}], missing_languages: [...], message }`.

- If `resolved` is empty, immediately retry once yourself with an alternate
  phrasing of the same topic (a common synonym, singular/plural, or a more
  standard term -- e.g. "Electric bikes" -> "Electric bicycle") before saying
  anything to the user. Only if that second attempt also comes back empty is
  the topic genuinely not findable -- tell the user and stop there; do not
  proceed to analysis with zero articles, and don't ask the user how to
  proceed without having tried an alternate phrasing yourself first.
- If `missing_languages` is non-empty but `resolved` is not, **tell the user
  which languages have no Wikipedia article for this topic, then proceed with
  the languages that were found.** Do not treat a partial result as a failure.
- Never guess or translate an article title yourself. Only use titles that
  came back in `resolved`.

### 2. Analyze

Run:

```bash
node dist/cli.js analyze_wikipedia_trends '{"articles":<the "resolved" array from step 1, lang/title pairs unchanged>,"period_months":<24 by default, unless the user asked for a different window>}'
```

Output: `{ dataset_id, period_start, period_end, languages: [{lang, title, found, total_views, monthly_average_views, trend_percentage, has_anomalies, anomaly_dates}], warnings: [...] }`.

- Read the `warnings` array. If a language shows `found: false`, that
  article has no pageview data (too new, or an edge case Wikidata/Wikipedia
  disagree on) -- mention this to the user rather than silently omitting it.
- If **every** language comes back `found: false`, stop here. Tell the user
  there is no usable data and do not call `generate_research_report`.
- Interpret `trend_percentage` as "second half of the period vs first half":
  positive means growing interest, negative means declining. Interpret
  `has_anomalies` / `anomaly_dates` as one-off spikes (news events, viral
  moments) worth calling out as caveats, not as sustained trend.
- Do not ask for or expect raw daily numbers -- the `dataset_id` this returns
  is an opaque handle for the next step, not something to inspect or explain.

### 3. Conclude

When you present results to the user (whether or not you go on to generate a
report), show the per-language metrics -- total views, monthly average,
trend -- as a markdown table, one row per language. Don't restate them as
headings or bullet points instead; the table is what should carry the
numbers.

Before generating the report, also write your own analytical text: 2-4 short
paragraphs comparing relative interest levels, trend direction per language,
and any caveats (missing languages, anomalies, short history, low absolute
volume). This is the one part of the workflow that is genuinely yours --
the tools deliberately do not draft this for you.

Ground every claim in the numbers you were given. Do not invent context the
tools didn't provide -- this means not just specific news events, but any
unconfirmed cause: cultural trends, legislation, market conditions, seasonal
behavior, "growing awareness," etc. If you want to speculate about a
plausible driver, hedge it explicitly as your own guess (e.g. "one possible
explanation, which the data can't confirm, is...") rather than stating it as
if it were established fact.

Write your entire response -- table headers, prose analysis, everything --
in a single, consistent language: the one the user has been writing in.
Never switch languages partway through a response (e.g. Ukrainian table
headers followed by an English analysis paragraph).

**If the user later asks you to restate, translate, or rephrase results you
already gave earlier in this conversation** (e.g. "say that in Ukrainian",
"can you repeat that in English?"), re-read the exact figures from the
`analyze_wikipedia_trends` output already in this conversation -- never
retype numbers, dates, or anomaly counts from memory or from your own
previous prose. Small/free models are especially prone to drifting figures
(or inventing new anomaly dates) when asked to reformulate an answer instead
of re-grounding it in the tool output. If a number doesn't match what the
tool actually returned, that's a bug in your response, not an acceptable
paraphrase.

### 4. Generate the report -- only when asked

Only run this if the user explicitly asked for a report, PDF, or document
(e.g. "generate a report", "make me a PDF", "save this as a report"):

```bash
node dist/cli.js generate_research_report '{"dataset_id":"<from step 2>","llm_analysis_text":"<your analysis text from step 3>","title":"<optional>","report_language":"<language you have been conversing in, e.g. \"uk\">","save_to":"<optional, see below>"}'
```

Set `report_language` to the language the user has been writing in (e.g.
`"uk"` if they've been asking in Ukrainian, omit or use `"en"` otherwise) --
this localizes the report's fixed labels (table headers, chart title, footer
disclaimer) to match. Only `en` and `uk` are fully translated today; any
other code falls back to English labels, but your `llm_analysis_text` and
`title` are entirely your own text and should always be in whatever language
fits the conversation, regardless of this field.

If the user asked for the file to go somewhere specific or under a specific
name ("save it to my Desktop", "call it wwii-report.pdf"), pass that as
`save_to` -- a bare directory (`"~/Desktop"`) keeps the default generated
filename, a path ending in `.pdf` is used as the exact filename. `~` expands
to the user's home directory in code, so pass it literally; don't try to
resolve it to a concrete path yourself. If the user didn't ask for a
location, omit `save_to` entirely -- it saves into this skill's own
`output/` directory, and the returned `file_path` tells you exactly where
regardless. Never silently save to the default location when the user did
name one -- that includes plain "save it" after an explicit location was
already given earlier in the conversation.

Output: `{ ok, file_path, message }` -- report the returned `file_path` to the
user.

If the user is instead asking a quick question or follow-up comparison (e.g.
"is X better than Y?", "which one is growing faster?"), answer directly in
text using the metrics from step 2 -- do not generate a report unless asked,
even if one was generated earlier in the conversation.

If the tool returns `ok: false`, relay its `message` verbatim-ish to the user
and do not claim a report was generated.

## Handling missing/partial data

This is a common, expected outcome -- not an error state to apologize
excessively for:

- **Missing article in one language** (`resolve_topic_languages` ->
  `missing_languages`): inform the user, proceed with the rest.
- **No pageview data for a resolved article** (`analyze_wikipedia_trends` ->
  a metric with `found: false`): inform the user, exclude it from your
  narrative conclusions, but it still appears in the report's table as "no
  data" for transparency.
- **Nothing resolves, or nothing has data at all**: stop, explain why, do not
  force a report out of an empty dataset.
- **Wikidata/Wikimedia network failure**: the tools return a clear message
  describing the failure; relay it and suggest retrying rather than
  fabricating a result.

## What NOT to do

- Do not guess article titles across languages -- always resolve first.
- Do not attempt to compute totals, averages, or trends yourself from any
  numbers you see -- if you ever find yourself doing arithmetic on Wikipedia
  data, stop and use the tools instead.
- Do not tell the user Wikipedia pageviews equal market demand or purchase
  intent -- they measure curiosity/awareness. Say so explicitly in your
  analysis if the user might act on this report commercially.
- Do not request more than ~15 languages at once (tool schema limit) -- for
  broader studies, run multiple smaller comparisons instead.
- Do not re-derive, retype, or "helpfully" round figures from memory when
  asked to restate or translate a previous answer -- always trace back to the
  actual tool output already in this conversation.

## Iterative Development (how this scales beyond the current version)

The current implementation is intentionally scoped to "a handful of specific
articles, per-article REST calls, up to a few years of daily data" -- the
right shape for one founder validating one topic on demand. Scaling it up
would mean:

- **Wikimedia Data Dumps / ClickHouse for category-wide analysis.** The
  per-article REST API doesn't scale to "compare pageviews across an entire
  Wikipedia category" (e.g. all articles under "Diets"). That requires
  ingesting Wikimedia's bulk pageview dumps (hourly TSV dumps) into a
  columnar store like ClickHouse or DuckDB, then querying by category via the
  Wikipedia/Wikidata category graph. This trades per-request latency for an
  ETL pipeline, and is the right move once a user wants "what's trending in
  category X" rather than "how is topic Y doing."
- **Correlating with Google Trends / other signals.** Wikipedia pageviews
  are one proxy among several. A natural next tool would fetch a parallel
  series from Google Trends (or App Store/Play Store search volume, or
  Reddit/X mention counts) for the same topic and languages, normalize both
  to a common index (e.g. 0-100 like Google Trends does), and chart them
  together -- giving a cross-validated confidence signal instead of a single
  source.
- **Persistent dataset store.** The current `data/datasets/*.json` file
  store is fine for a single agent session. A multi-user product would move
  this to a real database (e.g. Postgres) keyed by user + topic, enabling
  historical comparisons ("how has interest in this topic changed since we
  last checked 3 months ago") without re-fetching from Wikimedia.
- **Category/competitor sets.** Instead of one topic, resolve and analyze a
  basket of competing topics (e.g. 5 different diet trends) in one report,
  turning this from "validate my idea" into "see how my idea ranks against
  alternatives."
