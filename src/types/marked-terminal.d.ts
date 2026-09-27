declare module "marked-terminal" {
  import type { Renderer as MarkedRenderer } from "marked";

  export default class TerminalRenderer extends MarkedRenderer {
    constructor(options?: Record<string, unknown>);
  }
}
