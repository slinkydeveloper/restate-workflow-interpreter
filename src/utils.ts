import {run as jqRun} from "@gabrielbryk/jq-ts";
import type {Memory} from "./workflow-interpreter.js";

/**
 * Run a jq program against the current memory and return all of its outputs.
 * The program's input is `{ results, input, item, index }`, so a program reads
 * prior step results as `.results.<stepId>`, the workflow input as `.input`,
 * and (inside a `parallel` body) the current element as `.item` / `.index`.
 */
export function evalJq(program: string, memory: Memory): unknown[] {
  const input = {
    results: memory.results,
    input: memory.input ?? null,
    item: memory.item ?? null,
    index: memory.index ?? null,
  };
  return jqRun(program, input as Parameters<typeof jqRun>[1]) as unknown[];
}

/** jq truthiness of a program's first output: everything except `null`/`false` is true. */
export function jqCondition(program: string, memory: Memory): boolean {
  const [first] = evalJq(program, memory);
  return first !== null && first !== undefined && first !== false;
}

/** A jq program's first output as a string (for LLM prompts). */
export function jqString(program: string, memory: Memory): string {
  const [first] = evalJq(program, memory);
  if (typeof first === "string") return first;
  return first === undefined ? "" : JSON.stringify(first);
}

/**
 * A jq program's outputs as the list to iterate over: a stream (e.g. `.xs[]`)
 * yields one item per output, while a single array output is iterated.
 */
export function jqItems(program: string, memory: Memory): unknown[] {
  const outputs = evalJq(program, memory);
  return outputs.length === 1 ? asItems(outputs[0]) : outputs;
}

/** Normalize a single value into an array to iterate. */
export function asItems(value: unknown): unknown[] {
  if (value === null || value === undefined) return [];
  // A string is iterable, but we treat it as a single item, not per-character.
  if (typeof value === "string") return [value];
  const iterable = value as { [Symbol.iterator]?: unknown };
  if (typeof iterable[Symbol.iterator] === "function") {
    return [...(value as Iterable<unknown>)];
  }
  return [value];
}
