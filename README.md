# Restate Workflow Interpreter

A small demo showing how to build a **durable workflow interpreter** on top of the
[Restate](https://restate.dev) **gen SDK** (`@restatedev/restate-sdk-gen`, the
generator / `yield*` DSL).

You `POST` a tiny JSON workflow to a virtual object, which runs it on a stateless
interpreter service; Restate makes every step durable — HTTP calls, timers, parallel
fan-out, and LLM calls all survive crashes and replay deterministically. Expressions
(branch conditions, parallel items, LLM prompts) are [jq](https://jqlang.org) programs
over `{ results, input, item, index }`.

## The workflow language

A workflow is a named, ordered list of steps. Each step has an `id`; its output is
stored under that id so later steps can read it (via `results`).

| `type`     | does                                                    | key fields |
|------------|---------------------------------------------------------|------------|
| `http`     | durable HTTP call (`fetch` inside a journaled `run`)     | `method`, `url`, `headers?`, `body?` |
| `sleep`    | durable timer                                           | `durationMillis` |
| `parallel` | run `body` per item of a collection — all in parallel   | `items` (jq → iterable or single item), `body` |
| `llm`      | call an LLM (Vercel AI SDK + OpenAI) → structured output | `prompt` (jq → string), `schema` (JSON Schema), `model?`, `system?` |
| `branch`   | run the first matching branch's steps, else the default | `branches` (each `condition` jq + `steps`), `default?` |

```json
{
  "name": "demo",
  "steps": [
    { "id": "todo",   "type": "http",  "method": "GET", "url": "https://jsonplaceholder.typicode.com/todos/1" },
    { "id": "wait",   "type": "sleep", "durationMillis": 1000 },
    { "id": "route",  "type": "branch", "branches": [
      { "condition": ".results.todo.body.completed == true", "steps": [ { "id": "quick", "type": "sleep", "durationMillis": 500 } ] }
    ], "default": [ { "id": "review", "type": "sleep", "durationMillis": 1500 } ] },
    { "id": "fanout", "type": "parallel", "items": ".results.todo.body | [.userId, .id]", "body": [
      { "id": "post", "type": "http", "method": "GET", "url": "https://jsonplaceholder.typicode.com/posts/1" }
    ] }
  ]
}
```

See [`workflows/demo.json`](./workflows/demo.json) for the full sample, and
[`workflows/blog-ideas.json`](./workflows/blog-ideas.json) for an LLM-driven pipeline
(topic → generate ideas → draft each in parallel).

## The task manager and the interpreter

- **`WorkflowDefinition`** (virtual object, keyed by workflow name) — the *task manager*.
  Stores the workflow representation and drives runs: `set`, `get`, `start`,
  `schedule` (delayed run), `invocations` (list started run ids).
- **`WorkflowInterpreter`** (stateless service) — the *executor*. Receives the workflow
  plus an optional starting `input`, interprets the steps, and returns the results. It
  keeps no state of its own — durability comes from the steps themselves.
- **`WorkflowEvents`** (virtual object, keyed by the run's invocation id) — the *progress
  stream*. The interpreter `publish`es a `started`/`completed` event as each step runs; a
  UI streams them by long-polling `watch(afterIndex, timeoutSeconds)` in a loop (or reads
  the whole log via `list`). Events are durable, so a late or reconnecting UI still gets
  everything from index 0. Modeled on restatedev/agent's notifications service (a shared
  `watch` that parks a caller-owned awakeable, woken by exclusive `publish`).

`start` / `schedule` hand the workflow — plus an optional starting `input` (the request
body) — to the interpreter as a fire-and-forget invocation, save its Restate **invocation
id**, and return it. The `input` is available in every step's scope, so `eval` code can
build on it. Fetch a run's outcome by that id on the ingress:
`GET /restate/invocation/<id>/status` (poll) or `/restate/invocation/<id>/attach` (block
for the result).

## Run it

```bash
npm install

# `llm` steps need an OpenAI key — export it, or put OPENAI_API_KEY in a .env file
export OPENAI_API_KEY=sk-...

# 1. start a local Restate server (ingress :8080, admin :9070)
npx @restatedev/restate-server

# 2. in another terminal, run this service (serves on :9080)
npm run dev

# 3. register the deployment with Restate
npx @restatedev/restate deployment register http://localhost:9080
```

## Demo it

Open [`requests.http`](./requests.http) in IntelliJ IDEA (or the VS Code REST Client) and
run the requests top to bottom: define the workflow → start it (with an input) → poll the
invocation `status` → `attach` for the result → schedule a delayed run. IntelliJ captures
the returned `invocationId` automatically for the follow-up requests.
