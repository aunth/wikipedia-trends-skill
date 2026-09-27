import { zodToJsonSchema } from "zod-to-json-schema";
import { loadDataset } from "../services/cacheService";
import { renderComparisonChart } from "../services/chartService";
import { generatePdfReport } from "../services/pdfService";
import { GenerateResearchReportInputSchema, GenerateResearchReportOutputSchema } from "../types";

export const generateResearchReportTool = {
  name: "generate_research_report",
  description:
    "Renders a 1-page PDF market-research report (chart + metrics table + your analysis text) for a " +
    "dataset previously produced by analyze_wikipedia_trends. Call this LAST, after you have written " +
    "your analytical conclusion. Returns the absolute file path of the generated PDF.",
  input_schema: zodToJsonSchema(GenerateResearchReportInputSchema, "GenerateResearchReportInput"),
  execute: async (rawInput: unknown) => {
    const input = GenerateResearchReportInputSchema.parse(rawInput);
    const dataset = loadDataset(input.dataset_id);

    if (!dataset) {
      return GenerateResearchReportOutputSchema.parse({
        ok: false,
        file_path: "",
        message: `No dataset found for dataset_id "${input.dataset_id}". It may be invalid or expired -- call analyze_wikipedia_trends again to produce a fresh one.`,
      });
    }

    const hasAnyData = dataset.articles.some((a) => a.series.length > 0);
    if (!hasAnyData) {
      return GenerateResearchReportOutputSchema.parse({
        ok: false,
        file_path: "",
        message: "This dataset has no pageview data for any article -- there is nothing to chart or report on. Inform the user instead of generating a report.",
      });
    }

    const chart = await renderComparisonChart(dataset);
    const filePath = await generatePdfReport({
      dataset,
      chartBuffer: chart.buffer,
      analysisText: input.llm_analysis_text,
      title: input.title,
    });

    const omittedNote =
      chart.seriesOmitted.length > 0
        ? ` Note: ${chart.seriesOmitted.join(", ")} were omitted from the chart (too many series to plot legibly/accessibly) but remain in the metrics table.`
        : "";

    return GenerateResearchReportOutputSchema.parse({
      ok: true,
      file_path: filePath,
      message: `Report generated at ${filePath}.${omittedNote}`,
    });
  },
};
