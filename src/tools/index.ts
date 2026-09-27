import { resolveTopicLanguagesTool } from "./resolveTopicLanguages";
import { analyzeWikipediaTrendsTool } from "./analyzeWikipediaTrends";
import { generateResearchReportTool } from "./generateResearchReport";

/**
 * The full tool registry exposed to the LLM. Each entry carries its own Zod
 * input schema (converted to JSON Schema for the tool-use API), description,
 * and execute() function -- so wiring this into an Anthropic Messages API tool
 * loop, or any other agent framework, is a matter of iterating this array.
 */
export const TOOLS = [resolveTopicLanguagesTool, analyzeWikipediaTrendsTool, generateResearchReportTool] as const;

export type ToolName = (typeof TOOLS)[number]["name"];

export async function runTool(name: string, input: unknown): Promise<unknown> {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) {
    throw new Error(`Unknown tool: "${name}". Available tools: ${TOOLS.map((t) => t.name).join(", ")}`);
  }
  return tool.execute(input);
}

/** Anthropic Messages API `tools` array shape (name/description/input_schema). */
export function getAnthropicToolDefinitions() {
  return TOOLS.map(({ name, description, input_schema }) => ({ name, description, input_schema }));
}
