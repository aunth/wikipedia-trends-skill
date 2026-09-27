# Wikipedia Cross-Language Market Interest Skill

## Goal

You are helping a B2C product founder gauge public interest in a topic (a
product category, a health trend, a hobby, a diet, etc.) across different
language markets, using Wikipedia pageviews as a free, public proxy for
curiosity/awareness. You have three tools:

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

## Workflow

Follow this order. Do not skip steps or call them out of order.

### 1. Resolve

Call `resolve_topic_languages` with the topic as the user described it, the
language they described it in (`source_language`), and the list of Wikipedia
language codes they want to compare (`target_languages`).

- If `resolved` is empty, the topic itself could not be found at all. Tell the
  user and stop -- do not proceed to analysis with zero articles.
- If `missing_languages` is non-empty but `resolved` is not, **tell the user
  which languages have no Wikipedia article for this topic, then proceed with
  the languages that were found.** Do not treat a partial result as a failure.
- Never guess or translate an article title yourself. Only use titles that
  came back in `resolved`.

### 2. Analyze

Call `analyze_wikipedia_trends` with the `resolved` array from step 1 (pass
the `lang`/`title` pairs through unchanged) and a `period_months` value (24 by
default, unless the user asked for a different window).

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

Before generating the report, write your own analytical text: 2-4 short
paragraphs comparing relative interest levels, trend direction per language,
and any caveats (missing languages, anomalies, short history, low absolute
volume). This is the one part of the workflow that is genuinely yours --
the tools deliberately do not draft this for you.

Ground every claim in the numbers you were given. Do not invent context the
tools didn't provide (e.g. don't attribute a spike to a specific news event
unless the user told you what it was).

### 4. Generate the report

Call `generate_research_report` with the `dataset_id` from step 2 and the
analysis text from step 3. Report back the returned `file_path` to the user.

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
