import { config } from "../config";
import { getWithRetry, describeAxiosError } from "../utils/httpClient";
import { cacheKeyFor, withHttpCache } from "./cacheService";
import { ResolveTopicLanguagesInput, ResolveTopicLanguagesOutput } from "../types";

/**
 * Entity Resolution Service.
 *
 * Why this exists at all: Wikipedia article titles are NOT simple translations
 * of the English title -- they're independently chosen per-language slugs
 * ("Intermittent fasting" -> "Інтервальне голодування" in Ukrainian). An LLM
 * guessing these will silently produce 404s or, worse, confidently link to the
 * wrong article. Wikidata is the canonical cross-language mapping: every
 * Wikipedia article about the same real-world concept links to one Wikidata
 * item (a "QID"), and that item's sitelinks give the exact title per language.
 */

// --- Minimal shapes of the Wikidata API responses we actually use ----------

interface WikidataSearchResponse {
  search?: Array<{ id: string; label?: string; description?: string }>;
}

interface WikidataEntitiesResponse {
  entities?: Record<
    string,
    {
      sitelinks?: Record<string, { site: string; title: string }>;
    }
  >;
}

function siteKeyFor(lang: string): string {
  return `${lang}wiki`;
}

interface EntityMatch {
  id: string;
  label?: string;
  description?: string;
}

/**
 * Takes Wikidata's top search hit blindly -- `wbsearchentities` ranks by its
 * own relevance heuristic, not by the caller's intent. For an unambiguous
 * topic this is fine, but for an ambiguous one ("Mercury": the planet? the
 * element? the Roman god? a car brand?) the top hit may not be what the user
 * meant, with nothing to catch it. Returning `label`/`description` alongside
 * the id lets the caller (the LLM, via resolveTopicLanguages' `message`) see
 * exactly what was matched and re-search with a disambiguating phrase if it
 * looks wrong, instead of silently analyzing the wrong real-world entity.
 */
async function searchEntity(topic: string, sourceLang: string): Promise<EntityMatch | null> {
  const params = {
    action: "wbsearchentities",
    search: topic,
    language: sourceLang,
    format: "json",
    limit: 1,
  };
  const key = cacheKeyFor(config.wikidataApiUrl, params);

  const data = await withHttpCache(key, () =>
    getWithRetry<WikidataSearchResponse>(config.wikidataApiUrl, params)
  );

  const firstResult = data.search?.[0];
  if (!firstResult) return null;
  return { id: firstResult.id, label: firstResult.label, description: firstResult.description };
}

async function getSitelinks(qid: string, targetLangs: string[]): Promise<Record<string, string>> {
  const params = {
    action: "wbgetentities",
    ids: qid,
    props: "sitelinks",
    format: "json",
  };
  const key = cacheKeyFor(config.wikidataApiUrl, params);

  const data = await withHttpCache(key, () =>
    getWithRetry<WikidataEntitiesResponse>(config.wikidataApiUrl, params)
  );

  const sitelinks = data.entities?.[qid]?.sitelinks ?? {};
  const result: Record<string, string> = {};

  for (const lang of targetLangs) {
    const link = sitelinks[siteKeyFor(lang)];
    if (link) {
      result[lang] = link.title;
    }
  }

  return result;
}

export async function resolveTopicLanguages(
  input: ResolveTopicLanguagesInput
): Promise<ResolveTopicLanguagesOutput> {
  const { topic, source_language, target_languages } = input;

  let match: EntityMatch | null;
  try {
    match = await searchEntity(topic, source_language);
  } catch (error) {
    return {
      ok: false,
      wikidata_id: null,
      resolved: [],
      missing_languages: target_languages,
      message: `Could not reach Wikidata to search for "${topic}": ${describeAxiosError(
        error
      )}. Tell the user the lookup failed due to a network/API issue and suggest retrying.`,
    };
  }

  if (!match) {
    return {
      ok: false,
      wikidata_id: null,
      resolved: [],
      missing_languages: target_languages,
      message: `No Wikidata entity found for "${topic}" in language "${source_language}". Tell the user this exact topic could not be found and suggest they try a more specific or differently-worded topic.`,
    };
  }

  const qid = match.id;
  const matchedAs = match.label ? `"${match.label}"${match.description ? ` (${match.description})` : ""}` : qid;

  let sitelinkMap: Record<string, string>;
  try {
    sitelinkMap = await getSitelinks(qid, target_languages);
  } catch (error) {
    return {
      ok: false,
      wikidata_id: qid,
      resolved: [],
      missing_languages: target_languages,
      message: `Found Wikidata entity ${qid} for "${topic}" but failed to fetch its language links: ${describeAxiosError(
        error
      )}. Tell the user the lookup partially failed and suggest retrying.`,
    };
  }

  const resolved = target_languages
    .filter((lang) => sitelinkMap[lang])
    .map((lang) => ({ lang, title: sitelinkMap[lang] as string }));
  const missingLanguages = target_languages.filter((lang) => !sitelinkMap[lang]);

  // Always surfaced, regardless of how many languages resolved -- this is the
  // disambiguation check: the caller should confirm the matched entity is
  // actually the real-world thing the user meant before trusting the data.
  const disambiguationNote =
    `Matched "${topic}" to Wikidata entity ${matchedAs} (${qid}). If this is not the concept the user meant ` +
    `(e.g. an ambiguous term resolved to the wrong sense), tell them what was matched and ask them to ` +
    `rephrase more specifically -- do not silently proceed with a mismatched topic.`;

  let message: string;
  if (resolved.length === 0) {
    message = `${disambiguationNote} None of the requested languages (${target_languages.join(
      ", "
    )}) have an article for it. Inform the user no comparison is possible for these languages.`;
  } else if (missingLanguages.length > 0) {
    message = `${disambiguationNote} Resolved for ${resolved
      .map((r) => r.lang)
      .join(", ")}. No article exists for: ${missingLanguages.join(
      ", "
    )} -- inform the user these languages will be skipped and proceed with the remaining languages.`;
  } else {
    message = `${disambiguationNote} Resolved for all requested languages: ${resolved
      .map((r) => r.lang)
      .join(", ")}.`;
  }

  return {
    ok: true,
    wikidata_id: qid,
    matched_label: match.label,
    matched_description: match.description,
    resolved,
    missing_languages: missingLanguages,
    message,
  };
}
