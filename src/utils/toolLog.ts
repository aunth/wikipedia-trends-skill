/**
 * Human-readable one-line summaries of tool calls/results for the CLI test
 * harnesses -- replaces dumping raw JSON args/results to the terminal, which
 * is unreadable once anomaly_dates/series arrays get long.
 */

export function describeToolStart(name: string, input: any): string {
  switch (name) {
    case "resolve_topic_languages": {
      const langs = Array.isArray(input?.target_languages) ? input.target_languages.join(", ") : "requested languages";
      return `Looking up "${input?.topic}" (${langs})`;
    }
    case "analyze_wikipedia_trends": {
      const langs = Array.isArray(input?.articles) ? input.articles.map((a: any) => a.lang).join(", ") : "";
      return `Fetching pageview trends (${langs})`;
    }
    case "generate_research_report":
      return `Generating report${input?.title ? `: "${input.title}"` : ""}`;
    default:
      return name;
  }
}

export function describeToolResult(name: string, result: any): { ok: boolean; text: string } {
  if (result && typeof result === "object" && "error" in result) {
    return { ok: false, text: String(result.error) };
  }

  switch (name) {
    case "resolve_topic_languages": {
      // Note: this tool's `message` field is written as an instruction *to
      // the model* (e.g. "Inform the user no comparison is possible..."), not
      // as human-facing status text -- never echo it into the log below.
      const missing: string[] = result?.missing_languages ?? [];
      if (!result?.ok) return { ok: false, text: "Could not resolve topic" };
      const resolved: unknown[] = result?.resolved ?? [];
      // The API call itself succeeded even when nothing resolved (that's a
      // valid "no article in these languages" answer, not a request error)
      // -- but showing that as a green checkmark reads as false success right
      // before a retry. Treat "resolved nothing" as a failed step here.
      if (resolved.length === 0) {
        return { ok: false, text: missing.length ? `No article found in: ${missing.join(", ")}` : "No article found" };
      }
      const base = `Resolved ${resolved.length} language(s)`;
      return { ok: true, text: missing.length ? `${base}, missing: ${missing.join(", ")}` : base };
    }
    case "analyze_wikipedia_trends": {
      const langs = result?.languages ?? [];
      const found = langs.filter((l: any) => l.found).length;
      const text = `Got data for ${found}/${langs.length} language(s) (${result.period_start} → ${result.period_end})`;
      return { ok: found > 0, text };
    }
    case "generate_research_report": {
      if (!result?.ok) return { ok: false, text: result?.message ?? "Report not generated" };
      // The full path is rendered (relative + clickable) in the assistant's
      // own answer -- no need to print it a second time here.
      return { ok: true, text: "Report generated" };
    }
    default:
      return { ok: true, text: typeof result === "string" ? result : JSON.stringify(result) };
  }
}
