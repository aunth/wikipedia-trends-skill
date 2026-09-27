import { createInterface } from "node:readline/promises";
import Anthropic from "@anthropic-ai/sdk";
import { getAnthropicToolDefinitions, runTool } from "./tools";
import { SYSTEM_PROMPT } from "./agentSystemPrompt";

/**
 * Interactive end-to-end agent test harness using Claude directly via the
 * Anthropic API -- this is the "real" agent the skill was built for (the task
 * brief's target model), as opposed to testOpenRouterAgent.ts, which exists
 * to sanity-check the tool definitions against other/free models.
 *
 * Same contract as the OpenRouter harness: the tool-calling loop
 * (runAgentTurn) stops the moment Claude produces a plain-text answer with no
 * further tool_use blocks -- it does not keep going on its own. Control then
 * returns to a human at a prompt, who can ask a follow-up (about the same
 * report/dataset -- conversation history is preserved) or start a new
 * comparison, until they type "exit".
 */

const DEFAULT_MODEL = "claude-haiku-4-5-20251001"; // small/cheap model, matching the task brief's target
const MAX_TURNS = 8;

/**
 * Runs the tool-calling loop for ONE user message: keeps calling Claude and
 * executing whatever tools it requests, appending results back into
 * `messages`, until Claude responds with no tool_use blocks. The concatenated
 * text of that final response is returned and the function stops there.
 */
async function runAgentTurn(
  anthropic: Anthropic,
  model: string,
  messages: Anthropic.MessageParam[]
): Promise<string> {
  for (let step = 1; step <= MAX_TURNS; step++) {
    const response = await anthropic.messages.create({
      model,
      max_tokens: 2048,
      system: SYSTEM_PROMPT,
      tools: getAnthropicToolDefinitions() as Anthropic.Tool[],
      messages,
    });

    messages.push({ role: "assistant", content: response.content });

    const toolUses = response.content.filter(
      (block): block is Anthropic.ToolUseBlock => block.type === "tool_use"
    );

    if (toolUses.length === 0) {
      return response.content
        .filter((block): block is Anthropic.TextBlock => block.type === "text")
        .map((block) => block.text)
        .join("\n")
        .trim() || "(empty response)";
    }

    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const toolUse of toolUses) {
      console.log(`  [tool call] ${toolUse.name}(${JSON.stringify(toolUse.input)})`);

      let resultText: string;
      try {
        const result = await runTool(toolUse.name, toolUse.input);
        resultText = JSON.stringify(result);
      } catch (error) {
        resultText = JSON.stringify({ error: error instanceof Error ? error.message : String(error) });
      }
      console.log(`  [tool result] ${resultText}`);

      toolResults.push({ type: "tool_result", tool_use_id: toolUse.id, content: resultText });
    }

    messages.push({ role: "user", content: toolResults });
  }

  throw new Error(`Stopped after ${MAX_TURNS} tool-call steps without a final answer -- Claude may be stuck in a loop.`);
}

async function main() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error(
      "Missing ANTHROPIC_API_KEY. Get one at https://console.anthropic.com/settings/keys and run:\n" +
        "  ANTHROPIC_API_KEY=sk-ant-... npm run test:agent -- \"<your prompt>\""
    );
    process.exit(1);
  }

  const model = process.env.ANTHROPIC_MODEL ?? DEFAULT_MODEL;
  const anthropic = new Anthropic({ apiKey });

  console.log(`Model: ${model}`);
  console.log("Type 'exit' or 'quit' at any prompt to stop.\n");

  const messages: Anthropic.MessageParam[] = [];
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  let nextPrompt =
    process.argv.slice(2).join(" ") ||
    'Compare interest in "Intermittent fasting" between Ukrainian, Polish, and German Wikipedia over the last 24 months, then generate a report.';

  try {
    while (true) {
      console.log(`You: ${nextPrompt}\n`);
      messages.push({ role: "user", content: nextPrompt });

      try {
        const answer = await runAgentTurn(anthropic, model, messages);
        console.log(`\nAssistant: ${answer}\n`);
      } catch (error) {
        console.error(`\nError: ${error instanceof Error ? error.message : String(error)}\n`);
      }

      const input = (await rl.question("You (or 'exit'): ")).trim();
      if (!input || /^(exit|quit)$/i.test(input)) break;
      nextPrompt = input;
    }
  } finally {
    rl.close();
  }
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
