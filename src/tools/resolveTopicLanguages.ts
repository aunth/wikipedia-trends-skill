import { zodToJsonSchema } from "zod-to-json-schema";
import { resolveTopicLanguages } from "../services/wikidataService";
import { ResolveTopicLanguagesInputSchema, ResolveTopicLanguagesOutputSchema, normalizeLang } from "../types";

export const resolveTopicLanguagesTool = {
  name: "resolve_topic_languages",
  description:
    "Resolves a topic (e.g. 'Intermittent fasting') to its exact Wikipedia article title in each " +
    "requested target language via Wikidata. Always call this FIRST, before analyze_wikipedia_trends -- " +
    "article titles differ per language and cannot be guessed or translated. If a language is missing " +
    "from the result, tell the user and proceed with the languages that were found.",
  input_schema: zodToJsonSchema(ResolveTopicLanguagesInputSchema, "ResolveTopicLanguagesInput"),
  execute: async (rawInput: unknown) => {
    const parsed = ResolveTopicLanguagesInputSchema.parse(rawInput);
    const input = {
      ...parsed,
      source_language: normalizeLang(parsed.source_language),
      target_languages: parsed.target_languages.map(normalizeLang),
    };
    const result = await resolveTopicLanguages(input);
    return ResolveTopicLanguagesOutputSchema.parse(result);
  },
};
