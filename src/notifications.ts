import * as restate from "@restatedev/restate-sdk";
import {
  awakeable,
  client,
  handlerRequest,
  object,
  Operation,
  resolveAwakeable,
  select,
  sendClient,
  sharedState,
  sleep,
  state,
} from "@restatedev/restate-sdk-gen";

/** A single workflow progress event. */
export type ProgressEvent = {
  /** step id ("$workflow" for the run itself) */
  step: string;
  /** step type */
  type: string;
  status: "started" | "completed";
  /** scope path, e.g. "fanout[0]." for a step inside a parallel branch */
  path?: string;
  /** step result, on completion */
  result?: unknown;
  /** sequence number, assigned on publish (index in the log) */
  seq: number;
};

type Subscription = { afterIndex: number; awakeableId: string };

type EventsState = {
  events: ProgressEvent[];
  subscriptions: Subscription[];
};

const EVENTS = "events";
const SUBS = "subscriptions";

/**
 * WorkflowEvents — a durable per-run progress stream, keyed by the interpreter's
 * invocation id (the same id `WorkflowDefinition.start` returns). The interpreter
 * `publish`es an event as each step starts/completes; a UI streams them by
 * long-polling `watch(afterIndex)` in a loop, or reads the whole log via `list`.
 *
 * Modeled on restatedev/agent's notifications service: a *shared* `watch` handler
 * parks a caller-owned awakeable — so many watchers run concurrently and never
 * block `publish` — while the exclusive `publish`/`subscribe`/`unsubscribe`
 * handlers own the state. Events are durable, so a late or reconnecting watcher
 * still receives everything from its `afterIndex`.
 */
export const workflowEvents = object({
  name: "WorkflowEvents",
  handlers: {
    // Append an event and wake every eligible watcher.
    *publish(event: Omit<ProgressEvent, "seq">): Operation<void> {
      const events = (yield* state<EventsState>().get(EVENTS)) ?? [];
      events.push({...event, seq: events.length});
      state<EventsState>().set(EVENTS, events);

      const subs = (yield* state<EventsState>().get(SUBS)) ?? [];
      const ready = subs.filter((s) => s.afterIndex < events.length);
      if (ready.length === 0) return;
      state<EventsState>().set(
        SUBS,
        subs.filter((s) => s.afterIndex >= events.length)
      );
      for (const s of ready) {
        resolveAwakeable(s.awakeableId, events.slice(s.afterIndex));
      }
    },

    // Long-poll: return events after `afterIndex`, waiting up to `timeoutSeconds`
    // for new ones. Call in a loop with the returned `nextIndex` to stream.
    *watch(req: {
      afterIndex: number;
      timeoutSeconds: number;
    }): Operation<{ events: ProgressEvent[]; nextIndex: number }> {
      const changed = awakeable<ProgressEvent[]>();
      const available = yield* client(workflowEvents, key()).subscribe({
        afterIndex: req.afterIndex,
        awakeableId: changed.id,
      });
      if (available) {
        return {events: available, nextIndex: req.afterIndex + available.length};
      }

      const selected = yield* select({
        events: changed.promise,
        timeout: sleep(req.timeoutSeconds * 1000, "watch window"),
      });
      if (selected.tag === "events") {
        const events = yield* selected.future;
        return {events, nextIndex: req.afterIndex + events.length};
      }
      // Timed out: drop our parked awakeable and report no new events.
      sendClient(workflowEvents, key()).unsubscribe({awakeableId: changed.id});
      return {events: [], nextIndex: req.afterIndex};
    },

    // Register a caller-owned awakeable unless events are already available.
    *subscribe(sub: Subscription): Operation<ProgressEvent[] | null> {
      const events = (yield* state<EventsState>().get(EVENTS)) ?? [];
      if (sub.afterIndex < events.length) {
        return events.slice(sub.afterIndex);
      }
      const subs = (yield* state<EventsState>().get(SUBS)) ?? [];
      if (!subs.some((s) => s.awakeableId === sub.awakeableId)) {
        subs.push(sub);
        state<EventsState>().set(SUBS, subs);
      }
      return null;
    },

    // Remove an abandoned subscription. Safe to repeat.
    *unsubscribe(req: { awakeableId: string }): Operation<void> {
      const subs = (yield* state<EventsState>().get(SUBS)) ?? [];
      const remaining = subs.filter((s) => s.awakeableId !== req.awakeableId);
      if (remaining.length === subs.length) return;
      if (remaining.length === 0) state<EventsState>().clear(SUBS);
      else state<EventsState>().set(SUBS, remaining);
    },

    // The whole event log so far.
    *list(): Operation<ProgressEvent[]> {
      return (yield* sharedState<EventsState>().get(EVENTS)) ?? [];
    },
  },
  options: {
    enableLazyState: true,
    handlers: {
      watch: {shared: true, inactivityTimeout: {seconds: 1}},
      list: {shared: true},
    },
  },
});

function key(): string {
  const k = handlerRequest().key;
  if (!k) {
    throw new restate.TerminalError("WorkflowEvents handlers require a run key");
  }
  return k;
}
