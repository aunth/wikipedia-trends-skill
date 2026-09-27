import { zodToJsonSchema } from "zod-to-json-schema";
import { analyzeWikipediaTrends } from "../services/analyticsService";
import { AnalyzeWikipediaTrendsInputSchema, AnalyzeWikipediaTrendsOutputSchema, normalizeLang } from "../types";

export const analyzeWikipediaTrendsTool = {
  name: "analyze_wikipedia_trends",
  description:
    "Fetches daily Wikipedia pageviews for the given (lang, title) articles and returns AGGREGATED " +
    "metrics only (total views, monthly average, trend %, spike/anomaly flags) plus a dataset_id -- " +
    "never raw daily numbers. Use the exact titles from resolve_topic_languages. Pass the returned " +
    "dataset_id to generate_research_report; do not attempt to recompute or restate the raw series yourself.",
  input_schema: zodToJsonSchema(AnalyzeWikipediaTrendsInputSchema, "AnalyzeWikipediaTrendsInput"),
  execute: async (rawInput: unknown) => {
    const parsed = AnalyzeWikipediaTrendsInputSchema.parse(rawInput);
    const input = {
      ...parsed,
      articles: parsed.articles.map((a) => ({ ...a, lang: normalizeLang(a.lang) })),
    };
    const result = await analyzeWikipediaTrends(input);
    return AnalyzeWikipediaTrendsOutputSchema.parse(result);
  },
};
