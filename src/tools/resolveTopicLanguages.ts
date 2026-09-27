import { zodToJsonSchema } from "zod-to-json-schema";
import { resolveTopicLanguages } from "../services/wikidataService";
import { ResolveTopicLanguagesInputSchema, ResolveTopicLanguagesOutputSchema, normalizeLang } from "../types";

export const resolveTopicLanguagesTool = {
  name: "resolve_topic_languages",
  description:
    "Resolves a topic (e.g. 'Intermittent fasting') to its exact Wikipedia article title in each " +
    "requested target language via Wikidata. Always call this FIRST, before analyze_wikipedia_trends -- " +
    "article titles differ per language and cannot be guessed or translated. If a language is missing " +
    "from the result, tell the user and proceed with the languages that were found. Check " +
    "`matched_description` against what the user meant -- for an ambiguous topic (e.g. 'Mercury': the " +
    "planet, the element, or the Roman god), Wikidata's top search hit may not be the sense the user " +
    "intended; if it looks wrong, tell the user what was matched and ask them to rephrase more " +
    "specifically instead of silently analyzing the wrong real-world entity.",
  input_schema: zodToJsonSchema(ResolveTopicLanguagesInputSchema),
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
