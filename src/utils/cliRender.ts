/// <reference path="../types/marked-terminal.d.ts" />
import path from "node:path";
import pc from "picocolors";
import { marked } from "marked";
import TerminalRenderer from "marked-terminal";

marked.setOptions({
  // `as any`: marked's Renderer type doesn't model TerminalRenderer's ANSI
  // (string) output, but it satisfies the interface marked actually calls.
  // showSectionPrefix:false -- marked-terminal's default keeps the literal
  // "#"/"##"/"###" characters in front of a heading (just colored/bolded);
  // without this it still reads as raw markdown instead of a real heading.
  renderer: new TerminalRenderer({ showSectionPrefix: false }) as any,
});

// Semantic labels/colors, so the transcript reads as a conversation instead of
// a debug log: user input in cyan, the model's answer in magenta, everything
// else (tool progress) dim gray.
export const youLabel = pc.cyan("You:");
export const promptGlyph = pc.cyan("❯ "); // "❯ "
export const assistantLabel = pc.magenta(pc.bold("Assistant:"));
export const dim = pc.dim;

const CWD = process.cwd();
const ABS_PATH_RE = /(\/[^\s`'"()]+\.(?:pdf|png|jpg|jpeg|csv|json))/g;
const SIGNED_PERCENT_RE = /([+-])(\d+(?:\.\d+)?%)/g;

// OSC 8 hyperlink escape -- terminals that support it (iTerm2, Kitty, modern
// VTE/GNOME Terminal, Windows Terminal, ...) make `label` clickable; terminals
// that don't just render `label` and silently ignore the escape codes.
function hyperlink(label: string, url: string): string {
  return `\u001B]8;;${url}\u0007${label}\u001B]8;;\u0007`;
}

function styleAbsolutePath(absolutePath: string): string {
  const relative = path.relative(CWD, absolutePath);
  const display = relative.startsWith("..") ? absolutePath : `./${relative}`;
  const url = `file://${absolutePath}`;
  return hyperlink(pc.underline(pc.blue(display)), url);
}

function styleSignedPercent(sign: string, rest: string): string {
  const text = `${sign}${rest}`;
  return sign === "-" ? pc.red(text) : pc.green(text);
}

/** Symbol/text pair for an ora spinner's `stopAndPersist`, once a tool step finishes. */
export function toolStepDone(ok: boolean, text: string): { symbol: string; text: string } {
  return { symbol: ok ? dim("✓") : pc.red("✗"), text: dim(text) };
}

// LLM-generated markdown tends to include quirks CommonMark takes literally
// and that break list rendering: a bare "- " or "1. " marker followed by a
// blank line before its own text (splits the marker from its content into a
// separate paragraph), and continuation lines re-indented by 4+ spaces
// (CommonMark reads 4-space indentation as a code block, not "still part of
// this list item"). Both were reproduced 1:1 against marked-terminal and
// produce exactly the "marker, blank line, then text" / drifting-indent
// artifacts this was written to fix.
function normalizeMarkdown(raw: string): string {
  return raw
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/, "")) // trailing whitespace -> accidental CommonMark hard breaks
    .join("\n")
    .replace(/^([ \t]*(?:[-*+]|\d+\.))[ \t]*\n+(?=[ \t]*\S)/gm, "$1 ") // bare marker + blank line(s) -> marker joined to its own text
    .replace(/^[ \t]{3,}(?=\S)/gm, "  "); // de-indent runaway continuation lines below the 4-space code-block threshold
}

// Some models occasionally wrap an entire prose answer in a single fenced
// code block (no real code involved) -- if that happens the whole message
// renders as inert/literal text (headings, lists, everything unparsed), so
// unwrap it rather than have the reply show raw markdown syntax.
function unwrapOuterCodeFence(raw: string): string {
  const match = raw.trim().match(/^```[^\n]*\n([\s\S]*)\n```$/);
  return match ? match[1]! : raw;
}

/**
 * Renders the model's final markdown answer as ANSI for the terminal:
 * headings/bold/tables/etc via marked-terminal, plus passes this repo cares
 * about specifically -- absolute file paths (e.g. the generated PDF) become
 * relative + clickable, and signed trend percentages get colored green/red
 * so a reader can scan the numbers at a glance.
 */
export function renderAssistantMessage(raw: string): string {
  const cleaned = normalizeMarkdown(unwrapOuterCodeFence(raw));
  const rendered = String(marked(cleaned)).trimEnd();
  return rendered.replace(ABS_PATH_RE, styleAbsolutePath).replace(SIGNED_PERCENT_RE, (_m, sign, rest) => styleSignedPercent(sign, rest));
}
