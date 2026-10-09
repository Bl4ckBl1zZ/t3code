import {
  orchestrationV2CommandExecutionIsLiveInBackground,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import { backgroundProcessTail } from "@t3tools/shared/backgroundProcess";
import { MCP_APP_OUTPUT_KEY } from "@t3tools/shared/mcpApp";
import { omitLocalVisibleTurnItems } from "@t3tools/shared/orchestrationV2BoundedSnapshot";
import {
  mcpAppFromToolItem,
  omitToolOutputImageData,
  toolOutputImages,
  toolOutputIndicatesFailure,
} from "@t3tools/shared/toolOutput";

const MAX_DETAIL_STRING_BYTES = 32_768;
const MAX_DYNAMIC_VALUE_BYTES = 16_384;
const MAX_ON_DEMAND_BYTES = 256 * 1024;

function encodedBytes(value: unknown): number {
  try {
    const serialized = JSON.stringify(value);
    return Buffer.byteLength(serialized ?? String(value), "utf8");
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function truncateDetail(
  value: string | undefined,
  maxBytes = MAX_DETAIL_STRING_BYTES,
): string | undefined {
  if (
    value === undefined ||
    (value.length <= maxBytes && Buffer.byteLength(value, "utf8") <= maxBytes)
  ) {
    return value;
  }
  // UTF-8 needs at least one byte per UTF-16 code unit. Only encode the prefix
  // that could fit, rather than allocating a buffer for the complete output.
  const prefix = Buffer.from(value.slice(0, maxBytes), "utf8")
    .subarray(0, maxBytes)
    .toString("utf8")
    .replace(/\uFFFD$/u, "");
  return `${prefix}\n… output truncated for transport`;
}

function summarizeDynamicValue(value: unknown): unknown {
  if (encodedBytes(value) <= MAX_DYNAMIC_VALUE_BYTES) {
    return value;
  }
  let serialized: string;
  try {
    serialized = typeof value === "string" ? value : (JSON.stringify(value) ?? String(value));
  } catch {
    serialized = "Unserializable tool output";
  }
  const firstLine =
    serialized
      .split(/\r?\n/u)
      .map((line) => line.replace(/\s+/gu, " ").trim())
      .find((line) => line.length > 0) ?? "Large tool output";
  return {
    summary: firstLine.length <= 160 ? firstLine : `${firstLine.slice(0, 159).trimEnd()}…`,
    truncated: true,
  };
}

export function projectTurnItemForWire(item: OrchestrationV2TurnItem): OrchestrationV2TurnItem {
  switch (item.type) {
    case "command_execution": {
      const { output, ...projected } = item;
      // Clients used to read failure off the output preview. Keep the outcome
      // without shipping or retaining the output that proved it.
      const failed =
        item.outputIndicatesFailure === true ||
        (item.exitCode !== undefined && item.exitCode !== 0) ||
        (output !== undefined && toolOutputIndicatesFailure(output));
      // The one exception: a background command that is still running renders
      // its last printed line above the composer and in thread details. That
      // line is the whole payload of that view, so it is all we send.
      const tail = orchestrationV2CommandExecutionIsLiveInBackground(item)
        ? backgroundProcessTail(output)
        : null;
      return {
        ...projected,
        ...(tail === null ? {} : { output: tail }),
        ...(failed ? { outputIndicatesFailure: true } : {}),
        // Clients fetch withheld output on demand, so they need to know it exists.
        ...(output?.trim() ? { outputOmitted: true } : {}),
      };
    }
    case "file_change":
      return {
        ...item,
        diffStr: truncateDetail(item.diffStr),
        oldStr: truncateDetail(item.oldStr),
        newStr: truncateDetail(item.newStr),
      };
    case "subagent":
      return {
        ...item,
        prompt: truncateDetail(item.prompt) ?? "",
        progress: truncateDetail(item.progress),
        result: item.result === null ? null : (truncateDetail(item.result) ?? null),
      };
    case "dynamic_tool": {
      // A captured MCP App goes out as its reference alone, so it survives a
      // result too large to send; the app fetches the result on demand.
      const app = mcpAppFromToolItem(item);
      const output =
        app !== undefined
          ? { [MCP_APP_OUTPUT_KEY]: app }
          : item.output === undefined
            ? undefined
            : summarizeDynamicValue(item.output);
      return {
        ...item,
        input: summarizeDynamicValue(item.input),
        ...(output === undefined ? {} : { output }),
        // A summarized result stands in for one the client can fetch.
        ...(output !== item.output ? { outputOmitted: true } : {}),
      };
    }
    default:
      return item;
  }
}

function boundDynamicValue(value: unknown): unknown {
  if (value === undefined) return value;
  if (typeof value === "string") return truncateDetail(value, MAX_ON_DEMAND_BYTES);
  let json: string;
  try {
    // Compact, so measuring does not inflate the value; clients indent it.
    json = JSON.stringify(value) ?? String(value);
  } catch {
    return "Unserializable tool value";
  }
  return Buffer.byteLength(json, "utf8") <= MAX_ON_DEMAND_BYTES
    ? value
    : truncateDetail(json, MAX_ON_DEMAND_BYTES);
}

/**
 * A tool output for a detail read, without image bytes. When the rest is too
 * large to send whole, its truncated text still comes with the image markers,
 * in order, so clients can load each image by index.
 */
function boundToolOutput(output: unknown): unknown {
  const omitted = omitToolOutputImageData(output);
  const bounded = boundDynamicValue(omitted);
  if (typeof bounded !== "string" || typeof omitted === "string") return bounded;
  const images = toolOutputImages(omitted);
  return images.length === 0
    ? bounded
    : [
        { type: "text", text: bounded },
        ...images.map((image) => ({ type: "image", mimeType: image.mimeType })),
      ];
}

/**
 * Projects one item for an on-demand detail read: keeps the input and output
 * the timeline withholds, bounded so a huge result cannot stall the socket.
 * Image bytes are left out; clients load them as `tool-output-image` assets.
 */
export function projectTurnItemForDetail(item: OrchestrationV2TurnItem): OrchestrationV2TurnItem {
  switch (item.type) {
    case "command_execution":
      return {
        ...item,
        input: truncateDetail(item.input, MAX_ON_DEMAND_BYTES) ?? "",
        output: truncateDetail(item.output, MAX_ON_DEMAND_BYTES),
      };
    case "dynamic_tool":
      return {
        ...item,
        input: boundDynamicValue(item.input),
        output: boundToolOutput(item.output),
      };
    case "subagent":
      return {
        ...item,
        prompt: truncateDetail(item.prompt, MAX_ON_DEMAND_BYTES) ?? "",
        progress: truncateDetail(item.progress, MAX_ON_DEMAND_BYTES),
        result:
          item.result === null ? null : (truncateDetail(item.result, MAX_ON_DEMAND_BYTES) ?? null),
      };
    case "file_change":
      return projectTurnItemForWire(item);
    default:
      return item;
  }
}

export function projectThreadProjectionForWire(
  projection: OrchestrationV2ThreadProjection,
): OrchestrationV2ThreadProjection {
  const projectedById = new Map<string, OrchestrationV2TurnItem>();
  const project = (item: OrchestrationV2TurnItem) => {
    const key = `${item.threadId}:${item.id}`;
    const existing = projectedById.get(key);
    if (existing !== undefined) return existing;
    const projected = projectTurnItemForWire(item);
    projectedById.set(key, projected);
    return projected;
  };
  return {
    ...projection,
    turnItems: projection.turnItems.map(project),
    visibleTurnItems: projection.visibleTurnItems.map((row) => ({
      ...row,
      item: project(row.item),
    })),
  };
}

/**
 * The wire fields of a thread snapshot, shared by the HTTP route and the socket
 * snapshot frame. Only clients that opted in get compact `turnItems` and the
 * marker; everyone else gets the unchanged representation.
 */
export function threadSnapshotForWire(input: {
  readonly snapshotSequence: number;
  readonly projection: OrchestrationV2ThreadProjection;
  readonly compactTurnItems: boolean;
}) {
  const projection = projectThreadProjectionForWire(input.projection);
  // Relies on the shared item objects `projectThreadProjectionForWire` keeps
  // between `turnItems` and `visibleTurnItems`.
  const compact = input.compactTurnItems ? omitLocalVisibleTurnItems(projection) : null;
  return {
    snapshotSequence: input.snapshotSequence,
    projection: compact ?? projection,
    ...(compact === null ? {} : { turnItemsOmitLocalVisible: true as const }),
  };
}

export function projectDomainEventForWire(
  event: OrchestrationV2DomainEvent,
): OrchestrationV2DomainEvent {
  return event.type === "turn-item.updated"
    ? { ...event, payload: projectTurnItemForWire(event.payload) }
    : event;
}
