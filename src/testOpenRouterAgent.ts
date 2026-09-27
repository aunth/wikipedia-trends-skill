import { createInterface } from "node:readline/promises";
import { getOpenAIToolDefinitions, runTool } from "./tools";
import { SYSTEM_PROMPT } from "./agentSystemPrompt";
import { youLabel, promptGlyph, assistantLabel, dim, renderAssistantMessage } from "./utils/cliRender";
import { ToolProgress } from "./utils/toolProgress";

// Harness-only pseudo-tool: NOT part of the skill's own tool registry (a real
// Skill invocation doesn't need one -- the surrounding chat UI owns ending the
// conversation). This interactive CLI REPL does need an explicit signal, and
// routing it through the model instead of matching a fixed keyword list means
// any phrasing, in any language, works ("exit", "вийти", "that's all, thanks").
const END_SESSION_TOOL = {
  type: "function" as const,
  function: {
    name: "end_session",
    description:
      "Call this if, and only if, the user's message indicates they want to end this conversation/session " +
      "-- in any language or phrasing (e.g. \"exit\", \"quit\", \"stop\", \"bye\", \"вийти\", \"that's all, thanks\", " +
      "\"I'm done\"). Do not call any other tool in the same turn as this one.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
};

/**
 * Interactive end-to-end agent test harness using OpenRouter.
 *
 * Why this exists as its own script rather than reusing index.ts's demo: that
 * demo calls the tools directly in a hardcoded order to prove the pipeline
 * itself works. This script instead hands the tool definitions to a real LLM
 * and lets IT decide which tools to call and when -- the actual thing being
 * tested is whether SKILL.md's instructions are followed (resolve before
 * analyze, handle missing languages gracefully, write real analysis text
 * before generating the report).
 *
 * The agentic tool-calling loop (runAgentTurn) stops as soon as the model
 * produces a plain-text answer with no further tool calls -- it does NOT keep
 * calling itself. Control then returns to a human at a prompt, who can ask a
 * follow-up about the same report, start a new comparison, or indicate (in
 * whatever language or phrasing) that they're done. This mirrors how the
 * skill is actually used (one request -> one report -> the user reacts),
 * rather than an unattended loop.
 *
 * Uses OpenRouter's OpenAI-compatible /chat/completions endpoint. Defaults to
 * free model variants (https://openrouter.ai/docs/guides/routing/model-variants/free)
 * so this costs nothing to run; set OPENROUTER_MODEL to use a specific (paid
 * or free) model instead, e.g. "anthropic/claude-haiku-4.5". Free models are
 * smaller and less reliable at tool use than frontier models -- don't be
 * surprised if a run needs a retry or two.
 */

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const MAX_TURNS = 8;

// OpenRouter's free catalog rotates as providers add/pull capacity -- a slug
// that works today can 404 next week ("this model is unavailable for free"),
// or get 429'd under shared-pool load. "openrouter/free" is OpenRouter's own
// auto-router across whatever free models are currently healthy, so it's the
// most robust first choice; the named slugs below are extra fallbacks if even
// that is unavailable. Verified live against GET /api/v1/models (filtered to
// `supported_parameters` containing "tools") at the time this was written;
// override with OPENROUTER_MODEL (e.g. a paid model like
// "anthropic/claude-haiku-4.5") to bypass this list entirely.
const FALLBACK_MODELS = [
  "openrouter/free",
  "qwen/qwen3.8-27b:free",
  "google/gemma-4-26b-a4b-it:free",
  "nvidia/nemotron-3-super-120b-a12b:free",
];

interface OpenAIMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
}

// Both are "this model, right now, isn't usable" -- worth moving to the next
// candidate for -- as opposed to a genuine request/auth error, which should
// fail loudly instead of being silently swallowed by the fallback loop.
class SkippableModelError extends Error {}

const FALLBACK_ROUNDS = 3; // full passes over the candidate list before giving up
const FALLBACK_ROUND_DELAY_MS = 4000; // free-tier shared-pool 429s are often transient

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Re-prompts on a blank Enter instead of sending an empty message. */
async function nextUserInput(rl: ReturnType<typeof createInterface>): Promise<string> {
  while (true) {
    const input = (await rl.question(promptGlyph)).trim();
    if (input) return input;
  }
}

async function callOpenRouter(messages: OpenAIMessage[], model: string, apiKey: string) {
  const response = await fetch(OPENROUTER_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      // Optional but recommended by OpenRouter for attribution/analytics.
      "HTTP-Referer": "https://github.com/aunth/wikipedia-trends-skill",
      "X-Title": "Wikipedia Trends Skill - test harness",
    },
    body: JSON.stringify({
      model,
      messages,
      tools: [...getOpenAIToolDefinitions(), END_SESSION_TOOL],
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    if (response.status === 404 && body.includes("unavailable for free")) {
      throw new SkippableModelError(`"${model}" is no longer available for free: ${body}`);
    }
    if (response.status === 429) {
      throw new SkippableModelError(`"${model}" is rate-limited right now: ${body}`);
    }
    throw new Error(`OpenRouter request failed: HTTP ${response.status} -- ${body}`);
  }

  const data = (await response.json()) as {
    choices: Array<{ message: OpenAIMessage; finish_reason: string }>;
  };
  return data.choices[0]!.message;
}

/**
 * Tries each candidate model in order, moving to the next on a 404 (pulled
 * from the free tier) or 429 (rate-limited). If an entire pass finds nothing
 * usable, waits and retries the whole list a few times -- free-tier 429s are
 * usually a shared-pool blip, not a permanent state.
 */
async function callOpenRouterWithFallback(
  messages: OpenAIMessage[],
  candidates: string[],
  apiKey: string
): Promise<{ message: OpenAIMessage; modelUsed: string }> {
  let lastError: unknown;

  for (let round = 1; round <= FALLBACK_ROUNDS; round++) {
    for (const model of candidates) {
      try {
        const message = await callOpenRouter(messages, model, apiKey);
        return { message, modelUsed: model };
      } catch (error) {
        if (!(error instanceof SkippableModelError)) throw error;
        console.warn(`${error.message}\nTrying next fallback model...`);
        lastError = error;
      }
    }
    if (round < FALLBACK_ROUNDS) {
      console.warn(`All candidates unavailable/rate-limited on pass ${round} -- waiting ${FALLBACK_ROUND_DELAY_MS}ms before retrying the list...`);
      await sleep(FALLBACK_ROUND_DELAY_MS);
    }
  }

  throw lastError instanceof Error ? lastError : new Error("All fallback models are unavailable.");
}

/**
 * Runs the tool-calling loop for ONE user message: keeps calling the model
 * and executing whatever tools it requests, appending results back into
 * `messages`, until the model responds with plain text and no tool calls.
 * That plain text is returned and the function stops -- it never keeps going
 * on its own past that point.
 *
 * `candidates` is mutated in place: once a model succeeds, the list collapses
 * to just that one, so later turns in the same session don't re-probe the
 * whole fallback list every time.
 *
 * `exit` in the return value is true if the model called end_session, meaning
 * the CLI session should stop after showing this answer.
 */
async function runAgentTurn(
  messages: OpenAIMessage[],
  candidates: string[],
  apiKey: string
): Promise<{ text: string; exit: boolean }> {
  let modelLogged = candidates.length === 1;
  const progress = new ToolProgress();
  let exit = false;

  for (let step = 1; step <= MAX_TURNS; step++) {
    const { message: assistantMessage, modelUsed } = await callOpenRouterWithFallback(messages, candidates, apiKey);
    candidates.length = 0;
    candidates.push(modelUsed);
    if (!modelLogged) {
      console.log(dim(`Model: ${modelUsed}\n`));
      modelLogged = true;
    }
    messages.push(assistantMessage);

    const toolCalls = assistantMessage.tool_calls ?? [];
    if (toolCalls.length === 0) {
      progress.flush();
      return { text: assistantMessage.content ?? "(empty response)", exit };
    }

    for (const call of toolCalls) {
      if (call.function.name === "end_session") {
        exit = true;
        messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify({ ok: true }) });
        continue;
      }

      let args: unknown;
      try {
        args = JSON.parse(call.function.arguments);
      } catch {
        args = {};
      }

      progress.start(call.function.name, args);

      let resultText: string;
      let parsedResult: unknown;
      try {
        parsedResult = await runTool(call.function.name, args);
        resultText = JSON.stringify(parsedResult);
      } catch (error) {
        parsedResult = { error: error instanceof Error ? error.message : String(error) };
        resultText = JSON.stringify(parsedResult);
      }
      progress.finish(call.function.name, parsedResult);

      messages.push({ role: "tool", tool_call_id: call.id, content: resultText });
    }
  }

  progress.flush();
  throw new Error(`Stopped after ${MAX_TURNS} tool-call steps without a final answer -- the model may be stuck in a loop.`);
}

async function main() {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    console.error(
      "Missing OPENROUTER_API_KEY. Get a free key at https://openrouter.ai/keys and run:\n" +
        "  OPENROUTER_API_KEY=sk-or-... npm run test:openrouter -- \"<your prompt>\""
    );
    process.exit(1);
  }

  // An explicit OPENROUTER_MODEL means "use exactly this" -- no silent
  // fallback, so a bad override fails loudly instead of masking itself.
  const candidates = process.env.OPENROUTER_MODEL ? [process.env.OPENROUTER_MODEL] : [...FALLBACK_MODELS];

  const messages: OpenAIMessage[] = [{ role: "system", content: SYSTEM_PROMPT }];

  const rl = createInterface({ input: process.stdin, output: process.stdout });

  // Only the very first prompt needs to be echoed -- it comes from argv/the
  // default, so it was never actually typed into this terminal. Every prompt
  // after that comes back from rl.question(), which readline already echoed
  // as the user typed it; logging it again would just double it up.
  let nextPrompt =
    process.argv.slice(2).join(" ") ||
    'Compare interest in "Intermittent fasting" between Ukrainian, Polish, and German Wikipedia over the last 24 months, then generate a report.';

  console.log(dim("Say you're done (in any language) to end the session.\n"));
  console.log(`${youLabel} ${nextPrompt}\n`);

  try {
    while (true) {
      messages.push({ role: "user", content: nextPrompt });

      let exit = false;
      try {
        const result = await runAgentTurn(messages, candidates, apiKey);
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
