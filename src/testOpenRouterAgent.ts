import { createInterface } from "node:readline/promises";
import { getOpenAIToolDefinitions, runTool } from "./tools";
import { SYSTEM_PROMPT } from "./agentSystemPrompt";

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
 * follow-up about the same report, start a new comparison, or type "exit" to
 * quit. This mirrors how the skill is actually used (one request -> one
 * report -> the user reacts), rather than an unattended loop.
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
      tools: getOpenAIToolDefinitions(),
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
 */
async function runAgentTurn(messages: OpenAIMessage[], candidates: string[], apiKey: string): Promise<string> {
  let modelLogged = candidates.length === 1;

  for (let step = 1; step <= MAX_TURNS; step++) {
    const { message: assistantMessage, modelUsed } = await callOpenRouterWithFallback(messages, candidates, apiKey);
    candidates.length = 0;
    candidates.push(modelUsed);
    if (!modelLogged) {
      console.log(`Model: ${modelUsed}\n`);
      modelLogged = true;
    }
    messages.push(assistantMessage);

    const toolCalls = assistantMessage.tool_calls ?? [];
    if (toolCalls.length === 0) {
      return assistantMessage.content ?? "(empty response)";
    }

    for (const call of toolCalls) {
      let args: unknown;
      try {
        args = JSON.parse(call.function.arguments);
      } catch {
        args = {};
      }

      console.log(`  [tool call] ${call.function.name}(${JSON.stringify(args)})`);

      let resultText: string;
      try {
        const result = await runTool(call.function.name, args);
        resultText = JSON.stringify(result);
      } catch (error) {
        resultText = JSON.stringify({ error: error instanceof Error ? error.message : String(error) });
      }
      console.log(`  [tool result] ${resultText}`);

      messages.push({ role: "tool", tool_call_id: call.id, content: resultText });
    }
  }

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

  let nextPrompt =
    process.argv.slice(2).join(" ") ||
    'Compare interest in "Intermittent fasting" between Ukrainian, Polish, and German Wikipedia over the last 24 months, then generate a report.';

  console.log("Type 'exit' or 'quit' at any prompt to stop.\n");

  try {
    while (true) {
      console.log(`You: ${nextPrompt}\n`);
      messages.push({ role: "user", content: nextPrompt });

      try {
        const answer = await runAgentTurn(messages, candidates, apiKey);
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
