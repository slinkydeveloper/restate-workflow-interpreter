import * as restate from "@restatedev/restate-sdk";
import {
  handlerRequest,
  object,
  Operation,
  sendClient,
  sharedState,
  state,
} from "@restatedev/restate-sdk-gen";
import type {Workflow} from "./dsl.js";
import {workflowInterpreter} from "./workflow-interpreter.js";

type DefinitionState = {
  workflow: Workflow;
  /** invocation ids of the interpreter runs started from this definition. */
  invocations: string[];
};

/**
 * WorkflowDefinition — the task manager.
 */
export const workflowDefinition = object({
  name: "WorkflowDefinition",
  handlers: {
    // Store / replace the workflow representation for this name.
    *set(workflow: Workflow) {
      const name = handlerRequest().key ?? workflow.name;
      state<DefinitionState>().set("workflow", {...workflow, name});
    },

    // Read the stored representation back.
    *get() {
      return (yield* sharedState<DefinitionState>().get("workflow")) ?? null;
    },

    // Start the stored workflow now (fire-and-forget). Returns the interpreter
    // invocation id to attach to / poll for the result.
    *start(input?: unknown) {
      const workflow = yield* loadWorkflow();
      const invocation = yield* sendClient(workflowInterpreter).run({workflow, input});
      yield* trackInvocation(invocation.id);
      return {invocationId: invocation.id};
    },

    // Schedule the stored workflow to run later (durable, fault-tolerant delayed
    // send). Returns the invocation id, same as `start`.
    *schedule(req: { delayMillis: number; input?: unknown }) {
      const workflow = yield* loadWorkflow();
      const invocation = yield* sendClient(workflowInterpreter).run(
          {workflow, input: req.input},
          restate.rpc.sendOpts({delay: req.delayMillis})
      );
      yield* trackInvocation(invocation.id);
      return {invocationId: invocation.id, delayMillis: req.delayMillis};
    },

    // List the interpreter invocation ids started from this definition.
    *invocations() {
      return (yield* sharedState<DefinitionState>().get("invocations")) ?? [];
    },
  },
  options: {
    handlers: {
      get: {shared: true},
      invocations: {shared: true},
    },
  },
});

/** Load the stored workflow or fail with a terminal error. */
function* loadWorkflow(): Operation<Workflow> {
  const workflow = yield* sharedState<DefinitionState>().get("workflow");
  if (!workflow) {
    throw new restate.TerminalError(
        `No workflow defined for '${handlerRequest().key}'. Call 'set' first.`
    );
  }
  return workflow;
}

/** Append an interpreter invocation id to this definition's tracked runs. */
function* trackInvocation(id: string): Operation<void> {
  const definitionState = state<DefinitionState>();
  const invocations = (yield* definitionState.get("invocations")) ?? [];
  definitionState.set("invocations", [...invocations, id]);
}
