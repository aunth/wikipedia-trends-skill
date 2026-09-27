import fs from "node:fs";
import path from "node:path";
import PDFDocument from "pdfkit";
import { config } from "../config";
import { StoredDataset } from "../types";

/**
 * PDF Report Generation.
 *
 * Builds a deliberately fixed, single-page layout rather than letting content
 * flow freely -- a founder wants one glanceable page, not a multi-page dump.
 * The two variable-length inputs (the metrics table and the LLM's analysis
 * text) are the only overflow risks, and both are bounded explicitly below:
 * the table by row count (== number of articles, already capped at 15 by the
 * tool schema) and the analysis text by a fixed box with `ellipsis: true`,
 * which truncates gracefully instead of pdfkit silently starting a page 2.
 */

const PAGE_MARGIN = 40;
const PAGE_WIDTH = 595.28; // A4 points
const PAGE_HEIGHT = 841.89; // A4 points
const CONTENT_WIDTH = PAGE_WIDTH - PAGE_MARGIN * 2;
// PDFKit auto-adds a page if content is placed past the bottom margin -- these
// two Y bounds keep everything strictly within the single printable page.
const FOOTER_Y = PAGE_HEIGHT - PAGE_MARGIN - 24;
const ANALYSIS_MAX_Y = FOOTER_Y - 14;

// PDFKit's built-in "Helvetica" is a PDF core font restricted to Latin-1 --
// article titles arrive in whatever script the language uses (Cyrillic, Greek,
// etc.) and would render as mojibake. Register the bundled Unicode font under
// these names and use them everywhere instead of the "Helvetica*" built-ins.
const FONT_REGULAR = "Body";
const FONT_BOLD = "Body-Bold";

const INK_PRIMARY = "#0b0b0b";
const INK_SECONDARY = "#52514e";
const INK_MUTED = "#898781";
const GRIDLINE = "#e1e0d9";

export interface GeneratePdfInput {
  dataset: StoredDataset;
  chartBuffer: Buffer;
  analysisText: string;
  title?: string;
}

function formatNumber(n: number): string {
  return n.toLocaleString("en-US");
}

function drawHeader(doc: PDFKit.PDFDocument, title: string, dataset: StoredDataset): number {
  doc.fillColor(INK_PRIMARY).font(FONT_BOLD).fontSize(20).text(title, PAGE_MARGIN, PAGE_MARGIN);

  const subtitle = `Wikipedia interest comparison · ${dataset.periodStart} to ${dataset.periodEnd} · Generated ${new Date().toISOString().slice(0, 10)}`;
  doc
    .fillColor(INK_SECONDARY)
    .font(FONT_REGULAR)
    .fontSize(9)
    .text(subtitle, PAGE_MARGIN, PAGE_MARGIN + 26);

  return PAGE_MARGIN + 26 + 16;
}

function drawChart(doc: PDFKit.PDFDocument, chartBuffer: Buffer, y: number): number {
  // Preserve the chart's native aspect ratio (config.chartWidthPx x chartHeightPx)
  // while fitting it to the page's content width.
  const aspectRatio = config.chartHeightPx / config.chartWidthPx;
  const height = CONTENT_WIDTH * aspectRatio;
  doc.image(chartBuffer, PAGE_MARGIN, y, { width: CONTENT_WIDTH, height });
  return y + height + 16;
}

function drawMetricsTable(doc: PDFKit.PDFDocument, dataset: StoredDataset, y: number): number {
  const columns = [
    { key: "lang", label: "Lang", width: 40 },
    { key: "title", label: "Article", width: 150 },
    { key: "total_views", label: "Total Views", width: 85 },
    { key: "monthly_average_views", label: "Monthly Avg", width: 85 },
    { key: "trend_percentage", label: "Trend", width: 70 },
    { key: "anomalies", label: "Spikes", width: 85 },
  ] as const;

  let x = PAGE_MARGIN;
  doc.font(FONT_BOLD).fontSize(9).fillColor(INK_SECONDARY);
  for (const col of columns) {
    doc.text(col.label, x, y, { width: col.width });
    x += col.width;
  }

  y += 14;
  doc.moveTo(PAGE_MARGIN, y).lineTo(PAGE_MARGIN + CONTENT_WIDTH, y).strokeColor(GRIDLINE).lineWidth(1).stroke();
  y += 6;

  doc.font(FONT_REGULAR).fontSize(9);
  for (const metric of dataset.metrics) {
    x = PAGE_MARGIN;
    const trendSign = metric.trend_percentage > 0 ? "+" : "";
    const rowValues: Record<(typeof columns)[number]["key"], string> = {
      lang: metric.lang.toUpperCase(),
      title: metric.found ? metric.title : `${metric.title} (no data)`,
      total_views: metric.found ? formatNumber(metric.total_views) : "-",
      monthly_average_views: metric.found ? formatNumber(metric.monthly_average_views) : "-",
      trend_percentage: metric.found ? `${trendSign}${metric.trend_percentage}%` : "-",
      anomalies: metric.found ? (metric.has_anomalies ? `${metric.anomaly_dates.length} detected` : "None") : "-",
    };

    doc.fillColor(metric.found ? INK_PRIMARY : INK_MUTED);
    for (const col of columns) {
      doc.text(rowValues[col.key], x, y, { width: col.width, ellipsis: true });
      x += col.width;
    }
    y += 16;
  }

  return y + 10;
}

function drawAnalysis(doc: PDFKit.PDFDocument, analysisText: string, y: number, maxY: number): number {
  doc.font(FONT_BOLD).fontSize(11).fillColor(INK_PRIMARY).text("Analysis & Insights", PAGE_MARGIN, y);
  y += 16;

  const truncated =
    analysisText.length > config.maxAnalysisTextChars
      ? `${analysisText.slice(0, config.maxAnalysisTextChars)}…`
      : analysisText;

  const availableHeight = maxY - y;
  doc.font(FONT_REGULAR).fontSize(9.5).fillColor(INK_SECONDARY).text(truncated, PAGE_MARGIN, y, {
    width: CONTENT_WIDTH,
    height: availableHeight,
    ellipsis: true, // guarantees single-page: overflow truncates with "..." instead of adding a page
  });

  return maxY;
}

function drawFooter(doc: PDFKit.PDFDocument): void {
  doc
    .font(FONT_REGULAR)
    .fontSize(7.5)
    .fillColor(INK_MUTED)
    .text(
      "Data: Wikimedia Pageviews API & Wikidata. Pageviews are a proxy for public curiosity, not purchase intent -- use alongside other market signals.",
      PAGE_MARGIN,
      FOOTER_Y,
      { width: CONTENT_WIDTH, height: PAGE_HEIGHT - PAGE_MARGIN - FOOTER_Y, ellipsis: true }
    );
}

export async function generatePdfReport(input: GeneratePdfInput): Promise<string> {
  const { dataset, chartBuffer, analysisText } = input;
  const title = input.title ?? "Wikipedia Market Interest Report";

  fs.mkdirSync(config.outputDir, { recursive: true });
  const fileName = `wikipedia-trends-${dataset.datasetId}.pdf`;
  const filePath = path.join(config.outputDir, fileName);

  const doc = new PDFDocument({ size: "A4", margin: PAGE_MARGIN, autoFirstPage: true, bufferPages: true });
  doc.registerFont(FONT_REGULAR, config.fontRegularPath);
  doc.registerFont(FONT_BOLD, config.fontBoldPath);

  const writeStream = fs.createWriteStream(filePath);
  doc.pipe(writeStream);

  let y = drawHeader(doc, title, dataset);
  y = drawChart(doc, chartBuffer, y);
  y = drawMetricsTable(doc, dataset, y);
  drawAnalysis(doc, analysisText, y, ANALYSIS_MAX_Y);
  drawFooter(doc);

  doc.end();

  await new Promise<void>((resolve, reject) => {
    writeStream.on("finish", () => resolve());
    writeStream.on("error", reject);
  });

  return filePath;
}
