import { z } from "zod";

/**
 * Shared domain types + Zod schemas.
 *
 * Zod schemas double as the LLM-facing tool contracts (via zod-to-json-schema)
 * AND as runtime validators for data crossing network/process boundaries. This
 * keeps "what the LLM is told the shape is" and "what we actually enforce" from
 * drifting apart.
 */

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

// Plain ZodString (no .transform()/.trim()/.toLowerCase() chain): those turn a
// schema into ZodEffects, which is fine at runtime but blows up TypeScript's
// type instantiation depth once nested inside arrays/objects and re-processed
// by zod-to-json-schema's generics. Case-insensitive regex here; callers
// normalize to lowercase in plain JS where it matters (see `normalizeLang`).
export const LanguageCodeSchema = z
  .string()
  .regex(/^[a-zA-Z-]{2,12}$/, "Expected a Wikipedia language code, e.g. 'en', 'uk', 'pl'.");

export function normalizeLang(lang: string): string {
  return lang.trim().toLowerCase();
}

export const ArticleRefSchema = z.object({
  lang: LanguageCodeSchema.describe("Wikipedia language code, e.g. 'en', 'uk', 'pl'."),
  title: z.string().min(1).describe("Exact article title as it appears in that language's Wikipedia URL."),
});
export type ArticleRef = z.infer<typeof ArticleRefSchema>;

export interface DailyPageview {
  date: string; // ISO yyyy-MM-dd
  views: number;
}

export interface ArticleTimeSeries extends ArticleRef {
  series: DailyPageview[];
}

// ---------------------------------------------------------------------------
// Module 1: Entity resolution (Wikidata)
// ---------------------------------------------------------------------------

export const ResolveTopicLanguagesInputSchema = z.object({
  topic: z.string().min(1).describe("The topic/entity to search for, e.g. 'Intermittent fasting'."),
  source_language: LanguageCodeSchema.describe(
    "Language the `topic` string is written in, e.g. 'en'."
  ),
  target_languages: z
    .array(LanguageCodeSchema)
    .min(1)
    .max(15)
    .describe("Wikipedia language codes to resolve the topic into, e.g. ['uk', 'pl', 'de']."),
});
export type ResolveTopicLanguagesInput = z.infer<typeof ResolveTopicLanguagesInputSchema>;

export const ResolvedLanguageSchema = z.object({
  lang: z.string(),
  title: z.string(),
});

export const ResolveTopicLanguagesOutputSchema = z.object({
  ok: z.boolean().describe("False only if the topic itself could not be found at all."),
  wikidata_id: z.string().nullable().describe("The resolved Wikidata QID, or null if not found."),
  matched_label: z
    .string()
    .optional()
    .describe("The label of the Wikidata entity that was actually matched -- compare against the user's intent."),
  matched_description: z
    .string()
    .optional()
    .describe(
      "Wikidata's short description of the matched entity, e.g. 'planet of the Solar System' -- use this to " +
        "catch an ambiguous topic (e.g. 'Mercury') resolving to the wrong sense before trusting the data."
    ),
  resolved: z
    .array(ResolvedLanguageSchema)
    .describe("Language -> exact article title, for every target language that has an article."),
  missing_languages: z
    .array(z.string())
    .describe("Target languages that have no corresponding Wikipedia article for this topic."),
  message: z
    .string()
    .describe(
      "Human-readable summary written for an LLM to relay to the end user, including how to handle missing languages."
    ),
});
export type ResolveTopicLanguagesOutput = z.infer<typeof ResolveTopicLanguagesOutputSchema>;

// ---------------------------------------------------------------------------
// Module 2: Pageviews analysis
// ---------------------------------------------------------------------------

export const AnalyzeWikipediaTrendsInputSchema = z.object({
  articles: z
    .array(ArticleRefSchema)
    .min(1)
    .max(15)
    .describe("Exact (lang, title) pairs to analyze, typically the `resolved` output of resolve_topic_languages."),
  period_months: z
    .number()
    .int()
    .min(1)
    .max(60)
    .default(24)
    .describe("How many months of history to analyze, counting back from the last fully available day."),
});
export type AnalyzeWikipediaTrendsInput = z.infer<typeof AnalyzeWikipediaTrendsInputSchema>;

export const LanguageTrendMetricsSchema = z.object({
  lang: z.string(),
  title: z.string(),
  found: z.boolean().describe("False if Wikimedia had no pageview data for this article at all."),
  total_views: z.number().int(),
  monthly_average_views: z.number().int(),
  trend_percentage: z
    .number()
    .describe("% change of the second half of the period vs the first half. Positive = growing interest."),
  has_anomalies: z.boolean(),
  anomaly_dates: z.array(z.string()).describe("ISO dates flagged as 1-day spikes (>300% of 7-day moving average)."),
});
export type LanguageTrendMetrics = z.infer<typeof LanguageTrendMetricsSchema>;

export const AnalyzeWikipediaTrendsOutputSchema = z.object({
  dataset_id: z.string().describe("Opaque reference to the full daily time series, needed by generate_research_report."),
  period_start: z.string(),
  period_end: z.string(),
  languages: z.array(LanguageTrendMetricsSchema),
  warnings: z.array(z.string()).describe("Non-fatal issues an LLM should mention to the user (missing data, short history, etc.)."),
});
export type AnalyzeWikipediaTrendsOutput = z.infer<typeof AnalyzeWikipediaTrendsOutputSchema>;

// Full-fidelity record persisted under dataset_id. Never sent to the LLM directly.
export interface StoredDataset {
  datasetId: string;
  createdAt: string;
  periodStart: string;
  periodEnd: string;
  articles: ArticleTimeSeries[];
  metrics: LanguageTrendMetrics[];
}

// ---------------------------------------------------------------------------
// Module 3: Report generation
// ---------------------------------------------------------------------------

export const GenerateResearchReportInputSchema = z.object({
  dataset_id: z.string().min(1).describe("The dataset_id returned by analyze_wikipedia_trends."),
  llm_analysis_text: z
    .string()
    .min(1)
    .max(4000)
    .describe(
      "The agent's written insights and caveats about the trends, in plain prose. Will be truncated if it doesn't fit one page."
    ),
  title: z.string().max(120).optional().describe("Optional report title. Defaults to a generic market-research title."),
  save_to: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Where to save the PDF, if the user asked for a specific location or filename (e.g. \"save it to my " +
        "Desktop\", \"call it wwii-report.pdf\"). Accepts a directory (e.g. '~/Desktop') -- the file keeps its " +
        "default generated name -- or a full path ending in '.pdf' for a specific filename. '~' expands to the " +
        "user's home directory. Omit entirely if the user didn't ask for a particular location; it then saves " +
        "into this project's own output/ directory, whose path is returned in file_path either way."
    ),
  report_language: LanguageCodeSchema.optional().describe(
    "Language for the report's fixed labels (table headers, chart title, footer disclaimer) -- e.g. 'uk' if the " +
      "user has been writing in Ukrainian. Defaults to 'en'. Only 'en' and 'uk' are fully translated today; any " +
      "other code falls back to English labels (your `llm_analysis_text` and `title` are unaffected -- write " +
      "those in whatever language fits the conversation regardless of this field)."
  ),
});
export type GenerateResearchReportInput = z.infer<typeof GenerateResearchReportInputSchema>;

export const GenerateResearchReportOutputSchema = z.object({
  ok: z.boolean(),
  file_path: z.string().describe("Absolute path to the generated PDF file."),
  message: z.string(),
});
export type GenerateResearchReportOutput = z.infer<typeof GenerateResearchReportOutputSchema>;
