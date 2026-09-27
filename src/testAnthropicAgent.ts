import { createInterface } from "node:readline/promises";
import Anthropic from "@anthropic-ai/sdk";
import { getAnthropicToolDefinitions, runTool } from "./tools";
import { SYSTEM_PROMPT } from "./agentSystemPrompt";
import { youLabel, promptGlyph, assistantLabel, dim, renderAssistantMessage } from "./utils/cliRender";
import { ToolProgress } from "./utils/toolProgress";

// Harness-only pseudo-tool: NOT part of the skill's own tool registry (a real
// Skill invocation doesn't need one -- the surrounding chat UI owns ending the
// conversation). This interactive CLI REPL does need an explicit signal, and
// routing it through the model instead of matching a fixed keyword list means
// any phrasing, in any language, works ("exit", "вийти", "that's all, thanks").
const END_SESSION_TOOL: Anthropic.Tool = {
  name: "end_session",
  description:
    "Call this if, and only if, the user's message indicates they want to end this conversation/session " +
    "-- in any language or phrasing (e.g. \"exit\", \"quit\", \"stop\", \"bye\", \"вийти\", \"that's all, thanks\", " +
    "\"I'm done\"). Do not call any other tool in the same turn as this one.",
  input_schema: { type: "object", properties: {}, additionalProperties: false },
};

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
 * comparison, until they indicate (in whatever language or phrasing) that
 * they're done.
 */

const DEFAULT_MODEL = "claude-haiku-4-5-20251001"; // small/cheap model, matching the task brief's target
const MAX_TURNS = 8;

/** Re-prompts on a blank Enter instead of sending an empty message. */
async function nextUserInput(rl: ReturnType<typeof createInterface>): Promise<string> {
  while (true) {
    const input = (await rl.question(promptGlyph)).trim();
    if (input) return input;
  }
}

/**
 * Runs the tool-calling loop for ONE user message: keeps calling Claude and
 * executing whatever tools it requests, appending results back into
 * `messages`, until Claude responds with no tool_use blocks. The concatenated
 * text of that final response is returned; `exit` is true if the model called
 * end_session, meaning the CLI session should stop after showing this answer.
 */
async function runAgentTurn(
  anthropic: Anthropic,
  model: string,
  messages: Anthropic.MessageParam[]
): Promise<{ text: string; exit: boolean }> {
  const progress = new ToolProgress();
  let exit = false;

  for (let step = 1; step <= MAX_TURNS; step++) {
    const response = await anthropic.messages.create({
      model,
      max_tokens: 2048,
      system: SYSTEM_PROMPT,
      tools: [...getAnthropicToolDefinitions(), END_SESSION_TOOL] as Anthropic.Tool[],
      messages,
    });

    messages.push({ role: "assistant", content: response.content });

    const toolUses = response.content.filter(
      (block): block is Anthropic.ToolUseBlock => block.type === "tool_use"
    );

    if (toolUses.length === 0) {
      progress.flush();
      const text = response.content
        .filter((block): block is Anthropic.TextBlock => block.type === "text")
        .map((block) => block.text)
        .join("\n")
        .trim() || "(empty response)";
      return { text, exit };
    }

    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const toolUse of toolUses) {
      if (toolUse.name === "end_session") {
        exit = true;
        toolResults.push({ type: "tool_result", tool_use_id: toolUse.id, content: JSON.stringify({ ok: true }) });
        continue;
      }

      progress.start(toolUse.name, toolUse.input);

      let resultText: string;
      let parsedResult: unknown;
      try {
        parsedResult = await runTool(toolUse.name, toolUse.input);
        resultText = JSON.stringify(parsedResult);
      } catch (error) {
        parsedResult = { error: error instanceof Error ? error.message : String(error) };
        resultText = JSON.stringify(parsedResult);
      }
      progress.finish(toolUse.name, parsedResult);

      toolResults.push({ type: "tool_result", tool_use_id: toolUse.id, content: resultText });
    }

    messages.push({ role: "user", content: toolResults });
  }

  progress.flush();
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

  console.log(dim(`Model: ${model}`));
  console.log(dim("Say you're done (in any language) to end the session.\n"));

  const messages: Anthropic.MessageParam[] = [];
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  // Only the very first prompt needs to be echoed -- it comes from argv/the
  // default, so it was never actually typed into this terminal. Every prompt
  // after that comes back from rl.question(), which readline already echoed
  // as the user typed it; logging it again would just double it up.
  let nextPrompt =
    process.argv.slice(2).join(" ") ||
    'Compare interest in "Intermittent fasting" between Ukrainian, Polish, and German Wikipedia over the last 24 months, then generate a report.';
  console.log(`${youLabel} ${nextPrompt}\n`);

  try {
    while (true) {
      messages.push({ role: "user", content: nextPrompt });

      let exit = false;
      try {
        const result = await runAgentTurn(anthropic, model, messages);
        console.log(`\n${assistantLabel}\n${renderAssistantMessage(result.text)}\n`);
        exit = result.exit;
      } catch (error) {
        console.error(`\n${dim("Error:")} ${error instanceof Error ? error.message : String(error)}\n`);
      }

      if (exit) break;
      nextPrompt = await nextUserInput(rl);
    }
  } finally {
    rl.close();
    console.log(); // guarantee a trailing newline so the shell doesn't render a "%" glued to our last output
  }
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
