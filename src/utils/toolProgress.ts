import ora, { Ora } from "ora";
import { describeToolStart, describeToolResult } from "./toolLog";
import { dim, toolStepDone } from "./cliRender";

/**
 * Coalesces consecutive tool calls of the SAME name into a single spinner
 * line instead of printing every attempt. Without this, a model that retries
 * resolve_topic_languages with an alternate phrasing after a miss prints a
 * standalone "✗ No article found..." right above the "✓ Resolved 3
 * language(s)" that immediately supersedes it -- reads as an error, when it's
 * really just an intermediate step of a fallback that went on to succeed.
 *
 * A failed attempt is only shown to the user once it's final: either a
 * *different* tool gets called next, or the turn ends without a same-name
 * retry ever coming back with `ok: true`.
 */
export class ToolProgress {
  private pending: { toolName: string; spinner: Ora; lastResult: { symbol: string; text: string } | null } | null = null;

  private finalizePending(): void {
    if (!this.pending) return;
    if (this.pending.lastResult) {
      this.pending.spinner.stopAndPersist(this.pending.lastResult);
    } else {
      this.pending.spinner.stop();
    }
    this.pending = null;
  }

  /** Call right before executing a tool. */
  start(toolName: string, input: unknown): void {
    if (this.pending && this.pending.toolName === toolName) {
      this.pending.spinner.text = dim(describeToolStart(toolName, input));
      return;
    }
    this.finalizePending();
    this.pending = {
      toolName,
      // discardStdin:false -- see testAnthropicAgent.ts's original note: ora's
      // default mutes stdin via its own internal readline interface, which
      // conflicts with this app's own readline prompt once the spinner stops.
      spinner: ora({ text: dim(describeToolStart(toolName, input)), color: "cyan", discardStdin: false }).start(),
      lastResult: null,
    };
  }

  /** Call right after executing a tool, with its parsed (non-throwing) result. */
  finish(toolName: string, parsedResult: unknown): void {
    if (!this.pending) return;
    const { ok, text } = describeToolResult(toolName, parsedResult);
    this.pending.lastResult = toolStepDone(ok, text);
    if (ok) this.finalizePending();
  }

  /** Call once the agent turn ends (success, error, or max-turns) to flush any still-pending line. */
  flush(): void {
    this.finalizePending();
  }
}
