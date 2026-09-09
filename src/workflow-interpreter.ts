import {all, gen, handlerRequest, Operation, run, sendClient, service, sleep, spawn} from "@restatedev/restate-sdk-gen";
import type {BranchStep, HttpStep, LlmStep, ParallelStep, SleepStep, Step, Workflow} from "./dsl.js";
import {jqCondition, jqItems, jqString} from "./utils.js";
import {workflowEvents, type ProgressEvent} from "./notifications.js";
import {generateText, jsonSchema, Output} from "ai";
import {openai} from "@ai-sdk/openai";

// --- WorkflowInterpreter --

export const workflowInterpreter = service({
  name: "WorkflowInterpreter",
  handlers: {
    * run(req: { workflow: Workflow; input?: unknown }) {
      // Progress streams to WorkflowEvents keyed by this invocation's id — the
      // same id WorkflowDefinition.start returns to the caller.
      const memory: Memory = {results: {}, input: req.input, notifyKey: handlerRequest().id};
      notify(memory, {step: "$workflow", type: "workflow", status: "started"});
      yield* interpret(req.workflow.steps, memory);
      notify(memory, {step: "$workflow", type: "workflow", status: "completed", result: memory.results});
      return memory.results;
    },
  },
});

/** Execution memory threaded through the interpreter. */
export type Memory = {
  results: Record<string, unknown>;
  input?: unknown;
  // journal-name prefix identifying the enclosing scope, e.g. "fanout[0]."
  path?: string;
  // WorkflowEvents key (the run's invocation id) to stream progress to
  notifyKey?: string;
  // only in parallel step context
  item?: unknown;
  index?: number;
};

/** Prefix a step's journal-entry name with its scope path (e.g. "fanout[0].http:todo"). */
function stepName(memory: Memory, name: string): string {
  return `${memory.path ?? ""}${name}`;
}

/** Fire-and-forget a progress event to this run's WorkflowEvents stream. */
function notify(memory: Memory, event: Omit<ProgressEvent, "seq">): void {
  if (!memory.notifyKey) return;
  sendClient(workflowEvents, memory.notifyKey).publish(event);
}

/** Interpret steps  */
export function* interpret(steps: Step[], memory: Memory): Operation<void> {
  for (const step of steps) {
    notify(memory, {step: step.id, type: step.type, status: "started", path: memory.path});
    switch (step.type) {
      case "http": {
        memory.results[step.id] = yield* doHttp(step, memory);
        break;
      }
      case "sleep": {
        memory.results[step.id] = yield* doSleep(step, memory);
        break;
      }
      case "parallel": {
        memory.results[step.id] = yield* doParallel(step, memory);
        break;
      }
      case "llm": {
        memory.results[step.id] = yield* doLlm(step, memory);
        break;
      }
      case "branch": {
        memory.results[step.id] = yield* doBranch(step, memory);
        break;
      }
    }
    notify(memory, {step: step.id, type: step.type, status: "completed", path: memory.path, result: memory.results[step.id]});
  }
}

function* doHttp(step: HttpStep, memory: Memory): Operation<unknown> {
  return yield* run(
      async ({signal}) => {
        const res = await fetch(step.url, {
          method: step.method ?? "GET",
          headers: step.headers,
          body: step.body === undefined ? undefined : JSON.stringify(step.body),
          signal,
        });
        const text = await res.text();
        let body: unknown = text;
        try {
          body = JSON.parse(text);
        } catch {
          // not JSON — keep the raw text
        }
        return {status: res.status, body};
      },
      {name: stepName(memory, `http:${step.id}`)}
  );
}

function* doSleep(step: SleepStep, memory: Memory): Operation<unknown> {
  yield* sleep(step.durationMillis, stepName(memory, `sleep:${step.id}`));
  return {sleptMillis: step.durationMillis};
}

function* doLlm(step: LlmStep, memory: Memory): Operation<unknown> {
  return yield* run(
      async ({signal}) => {
        // The prompt is a jq program (over { results, input }) that returns a string.
        const prompt = jqString(step.prompt, memory);
        const {output} = await generateText({
          model: openai(step.model ?? "gpt-4o-mini"),
          system: step.system,
          prompt,
          abortSignal: signal,
          output: Output.object({
            schema: jsonSchema(step.schema as unknown as Parameters<typeof jsonSchema>[0]),
          }),
        });
        return output;
      },
      {name: stepName(memory, `llm:${step.id}`)}
  );
}

function* doBranch(step: BranchStep, memory: Memory): Operation<unknown> {
  // Evaluate each branch's condition (a jq program) in order; run the steps of
  // the first truthy one. Fall back to `default` if none match. The chosen steps
  // run in the current memory, so their results join the flow.
  for (const [i, branch] of step.branches.entries()) {
    const matched = yield* run(
        async () => jqCondition(branch.condition, memory),
        {name: stepName(memory, `branch:${step.id}[${i}]`)}
    );
    if (matched) {
      yield* interpret(branch.steps, memory);
      return {taken: i};
    }
  }
  if (step.default) {
    yield* interpret(step.default, memory);
    return {taken: "default"};
  }
  return {taken: null};
}

function* doParallel(step: ParallelStep, scope: Memory): Operation<unknown[]> {
  // Compute the items to iterate through (a jq program over { results, input })
  const evaluatedItems = yield* run(async () => jqItems(step.items, scope), {name: stepName(scope, `items:${step.id}`)});

  // Run the body for each item in parallel, collecting each branch's own results.
  const tasks = evaluatedItems.map((item, index) =>
      spawn(
          gen(function* () {
            // Prepare memory for children copying parent results
            const childScope: Memory = {
              results: Object.create(scope.results) as Record<string, unknown>,
              input: scope.input,
              // extend the journal path so nested step names carry this branch's origin
              path: `${scope.path ?? ""}${step.id}[${index}].`,
              notifyKey: scope.notifyKey,
              item,
              index,
            };
            yield* interpret(step.body, childScope);
            // Spread copies only own keys, so we return just what the body produced.
            return {...childScope.results};
          })
      )
  );
  return yield* all(tasks);
}
