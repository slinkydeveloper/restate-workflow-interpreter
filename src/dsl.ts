/**
 * A tiny JSON workflow language.
 *
 * A workflow is a named, ordered list of steps. Every step carries an `id`;
 * its output is accumulated into a `results` map keyed by that id, so later
 * steps can read the outputs of earlier ones. Expressions (parallel `items`,
 * branch `condition`, llm `prompt`) are jq programs over `{ results, input }`.
 */

/** Durable HTTP call. */
export type HttpStep = {
  id: string;
  type: "http";
  method?: string;
  url: string;
  headers?: Record<string, string>;
  body?: unknown;
};

/** Durable timer. */
export type SleepStep = {
  id: string;
  type: "sleep";
  durationMillis: number;
};

/** Run `body` for every element of a collection, all in parallel. */
export type ParallelStep = {
  id: string;
  type: "parallel";
  /**
   * A jq program (input `{ results, input, item, index }`) that produces the
   * items to iterate over: a stream (e.g. `.results.todo.body.tags[]`) yields
   * one item per output, while a single array output is iterated. E.g.
   * `"[1, 2, 3]"` or `".results.todo.body.tags"`.
   */
  items: string;
  body: Step[];
};

/** Call an LLM (Vercel AI SDK + OpenAI) and return structured output. */
export type LlmStep = {
  id: string;
  type: "llm";
  /** OpenAI model id; defaults to "gpt-4o-mini". */
  model?: string;
  /** jq program (input `{ results, input }`) that produces the prompt string. */
  prompt: string;
  /** Optional system prompt. */
  system?: string;
  /** JSON Schema describing the structured object the model must return. */
  schema: Record<string, unknown>;
};

/** Run the steps of the first branch whose condition holds; otherwise the default. */
export type BranchStep = {
  id: string;
  type: "branch";
  /** Evaluated in order; each `condition` is a jq program (truthy output = run this branch). */
  branches: { condition: string; steps: Step[] }[];
  /** Steps to run when no branch condition holds. */
  default?: Step[];
};

export type Step = HttpStep | SleepStep | ParallelStep | LlmStep | BranchStep;

export interface Workflow {
  name: string;
  steps: Step[];
}
