export { TOOLS, runTool, getAnthropicToolDefinitions } from "./tools";
export * from "./types";

/**
 * Manual end-to-end smoke test, independent of any LLM.
 *
 * Run with: npm run dev -- "<topic>" <sourceLang> <targetLang1,targetLang2,...>
 * Example:  npm run dev -- "Intermittent fasting" en uk,pl,de
 *
 * This exercises the exact same tool functions an LLM would call, in the
 * documented order (resolve -> analyze -> report), so it's a fast way to
 * verify the pipeline works end-to-end without wiring up an actual agent loop.
 */
async function main() {
  const [topic, sourceLang, targetLangsRaw] = process.argv.slice(2);

  if (!topic || !sourceLang || !targetLangsRaw) {
    console.error('Usage: npm run dev -- "<topic>" <sourceLang> <targetLang1,targetLang2,...>');
    process.exit(1);
  }

  const { runTool } = await import("./tools");
  const targetLanguages = targetLangsRaw.split(",").map((l) => l.trim());

  console.log(`\n1) Resolving "${topic}" (${sourceLang}) -> [${targetLanguages.join(", ")}]...`);
  const resolveResult = (await runTool("resolve_topic_languages", {
    topic,
    source_language: sourceLang,
    target_languages: targetLanguages,
  })) as { resolved: Array<{ lang: string; title: string }>; message: string };
  console.log(resolveResult.message);

  if (resolveResult.resolved.length === 0) {
    console.error("Nothing resolved -- stopping.");
    return;
  }

  console.log(`\n2) Analyzing trends for ${resolveResult.resolved.length} article(s)...`);
  const analyzeResult = (await runTool("analyze_wikipedia_trends", {
    articles: resolveResult.resolved,
    period_months: 24,
  })) as { dataset_id: string; languages: unknown[]; warnings: string[] };
  console.log(JSON.stringify(analyzeResult.languages, null, 2));
  if (analyzeResult.warnings.length > 0) {
    console.log("Warnings:", analyzeResult.warnings);
  }

  console.log(`\n3) Generating PDF report...`);
  const reportResult = (await runTool("generate_research_report", {
    dataset_id: analyzeResult.dataset_id,
    llm_analysis_text:
      `Comparative interest in "${topic}" across ${resolveResult.resolved
        .map((r) => r.lang)
        .join(", ")} over the last 24 months, based on Wikipedia pageviews as a proxy for public curiosity.`,
  })) as { ok: boolean; file_path: string; message: string };
  console.log(reportResult.message);
}

if (require.main === module) {
  main().catch((error) => {
    console.error("Fatal error:", error);
    process.exit(1);
  });
}
