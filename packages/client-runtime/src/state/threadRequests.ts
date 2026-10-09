import type {
  OrchestrationV2RuntimeRequest,
  OrchestrationV2ThreadProjection,
  OrchestrationV2UserInputQuestion,
  ProviderRequestKind,
  ProviderApprovalOption,
  RuntimeRequestId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

export interface ThreadPendingApproval {
  readonly requestId: RuntimeRequestId;
  readonly requestKind: ProviderRequestKind;
  readonly createdAt: string;
  readonly detail?: string;
  readonly title?: string;
  /** App requesting access for mcp-elicitation approvals (#8058). */
  readonly appName?: string;
  readonly options?: ReadonlyArray<ProviderApprovalOption>;
  readonly responseCapability: "live" | "not_resumable";
}

export interface ThreadUserInputQuestion {
  readonly allowCustomAnswer?: boolean | undefined;
  /** Editable initial text; answers keep it verbatim, including an empty string. */
  readonly initialAnswer?: string | undefined;
  readonly required?: boolean | undefined;
  readonly id: string;
  readonly header: string;
  readonly question: string;
  readonly options: ReadonlyArray<{
    readonly value?: string | undefined;
    readonly label: string;
    readonly description: string;
  }>;
  readonly multiSelect: boolean;
}

export interface ThreadPendingUserInput {
  readonly requestId: RuntimeRequestId;
  readonly createdAt: string;
  readonly questions: ReadonlyArray<ThreadUserInputQuestion>;
  readonly responseCapability: OrchestrationV2RuntimeRequest["responseCapability"]["type"];
  readonly responseMode?: "message";
  /** A question answerable by a plain message can be dismissed instead. */
  readonly dismissible: boolean;
}

export interface PendingThreadRequests {
  readonly approvals: ReadonlyArray<ThreadPendingApproval>;
  readonly userInputs: ReadonlyArray<ThreadPendingUserInput>;
}

/** Seed each question once. Existing edits, cleared answers, and option selections win. */
export function seedUserInputDraftAnswers<Draft extends { readonly customAnswer?: string }>(
  questions: ReadonlyArray<
    Pick<OrchestrationV2UserInputQuestion, "id" | "allowCustomAnswer" | "initialAnswer">
  >,
  drafts: Record<string, Draft>,
): Record<string, Draft | { customAnswer: string }> {
  let seeded: Record<string, Draft | { customAnswer: string }> = drafts;
  for (const question of questions) {
    if (
      question.initialAnswer === undefined ||
      question.allowCustomAnswer === false ||
      seeded[question.id] !== undefined
    )
      continue;
    if (seeded === drafts) seeded = { ...drafts };
    seeded[question.id] = { customAnswer: question.initialAnswer };
  }
  return seeded;
}

/** Joins pending request entities to the request items that carry display data. */
export function derivePendingThreadRequests(
  projection: Pick<OrchestrationV2ThreadProjection, "runtimeRequests" | "turnItems">,
): PendingThreadRequests {
  const approvals: ThreadPendingApproval[] = [];
  const userInputs: ThreadPendingUserInput[] = [];

  for (const request of projection.runtimeRequests) {
    if (request.status !== "pending") continue;
    const responseCapability = request.responseCapability.type;
    if (request.kind === "user_input") {
      const item = projection.turnItems.findLast(
        (candidate) =>
          candidate.type === "user_input_request" && candidate.requestId === request.id,
      );
      if (item === undefined || item.type !== "user_input_request") continue;
      // "message" arrives as the capability on newer servers, and as the
      // request's or item's responseMode elsewhere; all mean the same here.
      const byMessage =
        responseCapability === "message" ||
        request.responseMode === "message" ||
        item.responseMode === "message";
      userInputs.push({
        requestId: request.id,
        createdAt: DateTime.formatIso(request.createdAt),
        questions: item.questions.map((question) => ({
          ...question,
          multiSelect: question.multiSelect ?? false,
        })),
        responseCapability,
        ...(byMessage ? { responseMode: "message" as const } : {}),
        dismissible: byMessage,
      });
      continue;
    }

    if (request.kind === "auth_refresh" || request.kind === "dynamic_tool_call") continue;
    const item = projection.turnItems.findLast(
      (candidate) => candidate.type === "approval_request" && candidate.requestId === request.id,
    );
    approvals.push({
      requestId: request.id,
      requestKind: request.kind,
      createdAt: DateTime.formatIso(request.createdAt),
      ...(item?.type === "approval_request" && item.prompt ? { detail: item.prompt } : {}),
      ...(item?.type === "approval_request" && item.title ? { title: item.title } : {}),
      ...(item?.type === "approval_request" && item.appName ? { appName: item.appName } : {}),
      ...(item?.type === "approval_request" && item.options ? { options: item.options } : {}),
      responseCapability: responseCapability === "live" ? "live" : "not_resumable",
    });
  }

  return { approvals, userInputs };
}
