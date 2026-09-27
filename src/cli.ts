import { runTool } from "./tools";

/**
 * Bash-invocable entrypoint for the skill's three tools, so any agent with a
 * plain shell/code-execution tool (not just a host that pre-registers these
 * as native function-calling schemas) can drive this skill exactly as
 * SKILL.md instructs: `node dist/cli.js <tool_name> '<json_input>'`.
 *
 * Contract: prints exactly one line of JSON (the tool's output) to stdout on
 * success. On failure, prints `{ "error": "..." }` to stderr and exits
 * non-zero -- never mixes the two, so a caller can always safely
 * `JSON.parse(stdout)` when the exit code is 0.
 */
async function main(): Promise<void> {
  const [toolName, jsonArg] = process.argv.slice(2);

  if (!toolName) {
    console.error(
      "Usage: node dist/cli.js <tool_name> '<json_input>'\n" +
        "Tools: resolve_topic_languages, analyze_wikipedia_trends, generate_research_report"
    );
    process.exit(1);
  }

  let input: unknown;
  try {
    input = jsonArg ? JSON.parse(jsonArg) : {};
  } catch (error) {
    console.error(
      JSON.stringify({ error: `Invalid JSON input: ${error instanceof Error ? error.message : String(error)}` })
    );
    process.exit(1);
  }

  try {
    const result = await runTool(toolName, input);
    console.log(JSON.stringify(result));
  } catch (error) {
    console.error(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    process.exit(1);
  }
}

main();
