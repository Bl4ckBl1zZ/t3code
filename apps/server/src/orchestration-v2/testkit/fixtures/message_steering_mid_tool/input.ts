import {
  MESSAGE_STEERING_MID_TOOL_INITIAL_PROMPT,
  MESSAGE_STEERING_MID_TOOL_STEER_PROMPT,
  type OrchestratorFixtureInput,
} from "../shared.ts";

export function messageSteeringMidToolInput(): OrchestratorFixtureInput {
  return {
    steps: [
      { type: "message", text: MESSAGE_STEERING_MID_TOOL_INITIAL_PROMPT },
      {
        // The steer has to land while the Bash tool is still running, which is
        // where the SDK aborts with terminal_reason "aborted_tools".
        type: "steer",
        text: MESSAGE_STEERING_MID_TOOL_STEER_PROMPT,
        targetRunIndex: 1,
        waitForTurnItemType: "command_execution",
      },
    ],
  };
}
