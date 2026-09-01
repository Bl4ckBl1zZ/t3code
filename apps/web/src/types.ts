import type {
  ChatAttachment as ContractChatAttachment,
  ChatImageAttachment as ContractChatImageAttachment,
  MessageId,
  OrchestrationV2Actor,
  OrchestrationV2CreationSource,
  OrchestrationV2PlanArtifact,
  OrchestrationV2UserMessageInputIntent,
  PlanId,
  ProjectScript as ContractProjectScript,
  ProviderInteractionMode,
  RunId,
  RuntimeMode,
} from "@t3tools/contracts";
import type {
  EnvironmentProject,
  EnvironmentThreadShell,
  ThreadRunSummary,
  ThreadRuntimeSummary,
} from "@t3tools/client-runtime/state/shell";
import type { ThreadCheckpointSummary } from "@t3tools/client-runtime/state/thread-checkpoints";
import { videoMimeType } from "@t3tools/shared/video";

export { videoMimeType } from "@t3tools/shared/video";

export type SessionPhase = "disconnected" | "connecting" | "ready" | "running";
export const DEFAULT_RUNTIME_MODE: RuntimeMode = "full-access";

export const DEFAULT_INTERACTION_MODE: ProviderInteractionMode = "default";
export const DEFAULT_THREAD_TERMINAL_HEIGHT = 280;
export const DEFAULT_THREAD_TERMINAL_ID = "term-1";
export const MAX_TERMINALS_PER_GROUP = 4;
export type ProjectScript = ContractProjectScript;

export interface ThreadTerminalGroup {
  id: string;
  terminalIds: string[];
  splitDirection?: "horizontal" | "vertical";
}

export interface ChatImageAttachment extends ContractChatImageAttachment {
  readonly previewUrl?: string;
}

export type ChatAttachment = ContractChatAttachment extends infer Attachment
  ? Attachment extends ContractChatImageAttachment
    ? ChatImageAttachment
    : Attachment & { readonly previewUrl?: string }
  : never;

/**
 * The attachment kinds this build renders. The wire union additionally carries
 * an open member for kinds a newer server introduces, so decoding a message
 * never fails; anything the UI must switch on narrows to this set first.
 */
export type ChatKnownAttachment = Extract<
  ChatAttachment,
  { readonly type: "image" | "file" | "pdf" | "video" }
>;

// The wire union's open member is typed `type: string`, so a literal
// comparison does not narrow. Use these guards wherever type-specific fields
// are read.
export function isKnownAttachment(attachment: ChatAttachment): attachment is ChatKnownAttachment {
  return (
    attachment.type === "image" ||
    attachment.type === "file" ||
    attachment.type === "pdf" ||
    attachment.type === "video"
  );
}

export function isImageAttachment(
  attachment: ChatAttachment,
): attachment is Extract<ChatAttachment, { readonly type: "image" }> {
  return attachment.type === "image";
}

export function isFileAttachment(
  attachment: ChatAttachment,
): attachment is Extract<ChatAttachment, { readonly type: "file" | "pdf" | "video" }> {
  return attachment.type === "file" || attachment.type === "pdf" || attachment.type === "video";
}

export function isVideoAttachment(attachment: ChatAttachment): boolean {
  return videoMimeType(attachment) !== null;
}

export interface ChatMessage {
  readonly id: MessageId;
  readonly role: "user" | "assistant" | "system";
  readonly text: string;
  readonly attachments?: ReadonlyArray<ChatAttachment> | undefined;
  readonly runId: RunId | null;
  readonly streaming: boolean;
  readonly createdBy?: OrchestrationV2Actor;
  readonly creationSource?: OrchestrationV2CreationSource;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly inputIntent?: OrchestrationV2UserMessageInputIntent | undefined;
}

export interface ProposedPlan {
  readonly id: PlanId;
  readonly runId: RunId | null;
  readonly planMarkdown: string;
  readonly status: OrchestrationV2PlanArtifact["status"];
  readonly createdAt: string;
  readonly updatedAt: string;
}
export type TurnDiffFileChange = ThreadCheckpointSummary["files"][number];
export type TurnDiffSummary = ThreadCheckpointSummary;

export type Project = EnvironmentProject;
export type Thread = EnvironmentThreadShell;
export type ThreadShell = EnvironmentThreadShell;

export interface ThreadTurnState {
  latestRun: ThreadRunSummary | null;
}

export type SidebarThreadSummary = EnvironmentThreadShell;
export type ThreadSession = ThreadRuntimeSummary;
