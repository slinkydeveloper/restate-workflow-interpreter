import "dotenv/config";
import * as restate from "@restatedev/restate-sdk";
import {workflowDefinition} from "./workflow-definition.js";
import {workflowInterpreter} from "./workflow-interpreter.js";
import {workflowEvents} from "./notifications.js";

// Serve the task-manager object, the stateless interpreter service, and the
// per-run progress stream (port 9080).
restate.serve({
  services: [workflowDefinition, workflowInterpreter, workflowEvents],
  port: 9080,
});
