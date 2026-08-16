import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import {
  assertAssistantTextIncludes,
  assertBaseProjection,
  assertSemanticProjectionIntegrity,
  assertUserMessageInputIntents,
  assertUserMessagesInclude,
  assertVisibleTurnItemsMirrorLocalTurnItems,
  MESSAGE_STEERING_MID_TOOL_INITIAL_PROMPT,
  MESSAGE_STEERING_MID_TOOL_STEER_PROMPT,
  projectionFor,
} from "../shared.ts";

export function assertClaudeMessageSteeringMidToolOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  assert.equal(transcript.provider, "claudeAgent");
  assertBaseProjection({ result, transcript, runCount: 1, runStatuses: ["completed"] });

  const projection = projectionFor(result, transcript.scenario);
  assertSemanticProjectionIntegrity(projection);
  assertVisibleTurnItemsMirrorLocalTurnItems(projection);
  assertUserMessagesInclude(projection, [
    MESSAGE_STEERING_MID_TOOL_INITIAL_PROMPT,
    MESSAGE_STEERING_MID_TOOL_STEER_PROMPT,
  ]);
  assertUserMessageInputIntents(projection, ["turn_start", "steer"]);
  // The SDK aborts the in-flight tool and resumes the same turn with the
  // steered text, so the steered answer has to land on the original turn.
  assertAssistantTextIncludes(projection, "steering mid tool observed");
  assert.equal(projection.runs.length, 1, "steering must attach to the active run");
  assert.equal(
    projection.providerTurns.length,
    1,
    "an aborted_tools steering abort must not terminalize the provider turn",
  );
}
