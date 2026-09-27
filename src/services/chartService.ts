import { registerFont } from "canvas";
import { ChartJSNodeCanvas } from "chartjs-node-canvas";
import { ChartConfiguration } from "chart.js";
import { config } from "../config";
import { StoredDataset } from "../types";

const CHART_FONT_FAMILY = "DejaVu Sans";

// Registered once at module load, before any chart is rendered. Without this,
// node-canvas falls back to a core font that can't render article titles in
// Cyrillic/Greek/etc. and silently drops those glyphs (legend labels).
registerFont(config.fontRegularPath, { family: CHART_FONT_FAMILY, weight: "normal" });
registerFont(config.fontBoldPath, { family: CHART_FONT_FAMILY, weight: "bold" });

/**
 * Chart rendering for the PDF report.
 *
 * Color and mark choices below follow this project's data-viz standard
 * (fixed-order categorical palette, validated for colorblind-safe adjacent
 * contrast; 2px lines; hairline recessive gridlines; text in ink tokens, never
 * series colors) rather than chart.js defaults, which are neither
 * colorblind-validated nor visually consistent with the rest of the report.
 */

// Fixed-order categorical palette (light-surface variant), used verbatim from
// the validated reference palette -- NOT re-ordered or re-generated per chart,
// since the ordering itself is the colorblind-safety mechanism.
const CATEGORICAL_PALETTE = [
  "#2a78d6", // 1 blue
  "#eb6834", // 2 orange
  "#1baf7a", // 3 aqua
  "#eda100", // 4 yellow
  "#e87ba4", // 5 magenta
  "#008300", // 6 green
  "#4a3aa7", // 7 violet
  "#e34948", // 8 red
];

// The palette validates its fixed adjacent ordering up to all 8 slots for line
// charts; beyond that, an additional series would force either a repeated hue
// (which breaks the "color follows identity" rule) or an unvalidated hue. We
// cap and let the caller fold the rest into a warning instead.
const MAX_CHART_SERIES = CATEGORICAL_PALETTE.length;

const CHART_SURFACE = "#fcfcfb";
const INK_PRIMARY = "#0b0b0b";
const INK_SECONDARY = "#52514e";
const INK_MUTED = "#898781";
const GRIDLINE = "#e1e0d9";

const chartCanvas = new ChartJSNodeCanvas({
  width: config.chartWidthPx,
  height: config.chartHeightPx,
  backgroundColour: CHART_SURFACE,
});

/**
 * Downsamples a daily series to weekly points (mean per ISO week-ish bucket).
 *
 * Why: plotting 730 raw daily points on a 900px-wide static chart produces an
 * illegible, noisy line and a bloated PNG for no visual benefit -- the reader
 * cares about the trend shape, not every individual day. Weekly buckets keep
 * the chart readable across periods from a few months up to several years.
 */
function downsampleWeekly(series: Array<{ date: string; views: number }>): Array<{ date: string; views: number }> {
  if (series.length <= 60) return series; // short periods: show daily detail as-is

  const buckets: Array<{ date: string; views: number }> = [];
  for (let i = 0; i < series.length; i += 7) {
    const chunk = series.slice(i, i + 7);
    const avgViews = chunk.reduce((acc, d) => acc + d.views, 0) / chunk.length;
    buckets.push({ date: chunk[0]!.date, views: Math.round(avgViews) });
  }
  return buckets;
}

export interface RenderChartResult {
  buffer: Buffer;
  seriesRendered: string[];
  seriesOmitted: string[];
}

export async function renderComparisonChart(dataset: StoredDataset): Promise<RenderChartResult> {
  const foundArticles = dataset.articles.filter((a) => a.series.length > 0);

  // If there are more series than the validated palette supports, keep the
  // highest-total-views languages -- those are the most relevant comparison
  // for a founder assessing market interest -- and report the rest as omitted
  // rather than silently dropping them.
  const byTotalViewsDesc = [...foundArticles].sort(
    (a, b) => b.series.reduce((s, d) => s + d.views, 0) - a.series.reduce((s, d) => s + d.views, 0)
  );
  const rendered = byTotalViewsDesc.slice(0, MAX_CHART_SERIES);
  const omitted = byTotalViewsDesc.slice(MAX_CHART_SERIES);

  // Union of all dates across rendered series, sorted, so every line shares one
  // x-axis even if articles have slightly different data availability.
  const allDates = Array.from(
    new Set(rendered.flatMap((a) => downsampleWeekly(a.series).map((d) => d.date)))
  ).sort();

  const datasets = rendered.map((article, index) => {
    const bucketed = downsampleWeekly(article.series);
    const viewsByDate = new Map(bucketed.map((d) => [d.date, d.views]));
    const color = CATEGORICAL_PALETTE[index % CATEGORICAL_PALETTE.length];

    return {
      label: `${article.title} (${article.lang})`,
      data: allDates.map((date) => viewsByDate.get(date) ?? null),
      borderColor: color,
      backgroundColor: color,
      borderWidth: 2, // fixed mark spec: 2px lines
      pointRadius: 0,
      pointHoverRadius: 0,
      spanGaps: true,
      tension: 0.15,
    };
  });

  const chartConfig: ChartConfiguration<"line"> = {
    type: "line",
    data: { labels: allDates, datasets },
    options: {
      responsive: false,
      animation: false,
      layout: { padding: 12 },
      plugins: {
        legend: {
          display: datasets.length >= 2, // single series needs no legend box (title already names it)
          position: "bottom",
          labels: { color: INK_SECONDARY, boxWidth: 12, font: { size: 11, family: CHART_FONT_FAMILY } },
        },
        title: {
          display: true,
          text: "Weekly-average Wikipedia pageviews by language",
          color: INK_PRIMARY,
          font: { size: 14, weight: "bold", family: CHART_FONT_FAMILY },
        },
      },
      scales: {
        x: {
          ticks: { color: INK_MUTED, maxTicksLimit: 10, font: { size: 10, family: CHART_FONT_FAMILY } },
          grid: { color: GRIDLINE },
        },
        y: {
          beginAtZero: true,
          ticks: { color: INK_MUTED, font: { size: 10, family: CHART_FONT_FAMILY } },
          grid: { color: GRIDLINE },
        },
      },
    },
  };

  const buffer = await chartCanvas.renderToBuffer(chartConfig as ChartConfiguration);

  return {
    buffer,
    seriesRendered: rendered.map((a) => `${a.title} (${a.lang})`),
    seriesOmitted: omitted.map((a) => `${a.title} (${a.lang})`),
  };
}
