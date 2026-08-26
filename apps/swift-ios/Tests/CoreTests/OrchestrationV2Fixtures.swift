import Foundation

@testable import T3Code

// Shared builders for orchestration V2 wire values.
//
// The V2 thread and shell types carry ~40 fields each, most of them nullable
// bookkeeping. Spelling them out per test buries the one field a test actually
// cares about, so these builders default everything and take overrides for the
// parts under test.

enum V2Fixture {
    static let timestamp = "2026-07-31T12:00:00.000Z"

    static func appThread(
        id: String = "thread-v2",
        projectID: String = "project-1",
        title: String? = nil,
        branch: String? = nil,
        worktreePath: String? = nil,
        archivedAt: String? = nil,
        settledOverride: String? = nil,
        settledAt: String? = nil,
        unsettledAt: String? = nil,
        deletedAt: String? = nil
    ) -> OrchestrationV2AppThread {
        OrchestrationV2AppThread(
            id: id,
            projectId: projectID,
            createdBy: "user",
            creationSource: "mobile",
            title: title ?? id,
            titleRevision: nil,
            titleOrigin: nil,
            providerInstanceId: "codex",
            modelSelection: ModelSelection(instanceId: "codex", model: "gpt-5.6-sol"),
            runtimeMode: .fullAccess,
            interactionMode: .default,
            branch: branch,
            worktreePath: worktreePath,
            linkedPullRequest: nil,
            activeProviderThreadId: nil,
            historyOrigin: nil,
            lineage: OrchestrationV2AppThreadLineage(
                parentThreadId: nil,
                relationshipToParent: nil,
                rootThreadId: id
            ),
            forkedFrom: nil,
            createdAt: timestamp,
            updatedAt: timestamp,
            archivedAt: archivedAt,
            settledOverride: settledOverride,
            settledAt: settledAt,
            unsettledAt: unsettledAt,
            pinnedAt: nil,
            workInboxRole: nil,
            timelineClearedAt: nil,
            snoozedUntil: nil,
            snoozedAt: nil,
            lastVisitedAt: nil,
            titleRegeneration: nil,
            deletedAt: deletedAt
        )
    }

    static func threadShell(
        id: String = "thread-v2",
        projectID: String = "project-1",
        title: String? = nil,
        branch: String? = nil,
        worktreePath: String? = nil,
        status: String = "idle",
        activeRunID: String? = nil,
        pendingRuntimeRequest: OrchestrationV2PendingRuntimeRequestSummary? = nil,
        latestVisibleMessage: OrchestrationV2LatestVisibleMessageSummary? = nil,
        latestUserMessageAt: String? = nil,
        archivedAt: String? = nil,
        settledOverride: String? = nil,
        settledAt: String? = nil,
        unsettledAt: String? = nil,
        updatedAt: String = timestamp
    ) -> OrchestrationV2ThreadShell {
        OrchestrationV2ThreadShell(
            id: id,
            projectId: projectID,
            createdBy: "user",
            creationSource: "mobile",
            title: title ?? id,
            titleRevision: nil,
            titleOrigin: nil,
            providerInstanceId: "codex",
            modelSelection: ModelSelection(instanceId: "codex", model: "gpt-5.6-sol"),
            runtimeMode: .fullAccess,
            interactionMode: .default,
            branch: branch,
            worktreePath: worktreePath,
            lineage: OrchestrationV2AppThreadLineage(
                parentThreadId: nil,
                relationshipToParent: nil,
                rootThreadId: id
            ),
            forkedFrom: nil,
            activeProviderThreadId: nil,
            historyOrigin: nil,
            latestRunId: activeRunID,
            latestRunRequestedAt: nil,
            latestRunStartedAt: nil,
            latestRunCompletedAt: nil,
            activeRunId: activeRunID,
            status: status,
            lastError: nil,
            pendingRuntimeRequest: pendingRuntimeRequest,
            latestVisibleMessage: latestVisibleMessage,
            latestUserMessageAt: latestUserMessageAt,
            hasActionableProposedPlan: false,
            backgroundProcessCount: nil,
            itemCount: 0,
            visibleItemCount: 0,
            createdAt: timestamp,
            updatedAt: updatedAt,
            archivedAt: archivedAt,
            settledOverride: settledOverride,
            settledAt: settledAt,
            unsettledAt: unsettledAt,
            pinnedAt: nil,
            workInboxRole: nil,
            timelineClearedAt: nil,
            snoozedUntil: nil,
            snoozedAt: nil,
            lastVisitedAt: nil,
            titleRegeneration: nil,
            deletedAt: nil
        )
    }

    static func projection(
        thread: OrchestrationV2AppThread? = nil,
        runs: [OrchestrationV2Run] = [],
        items: [OrchestrationV2TurnItem] = [],
        truncatedVisibleItemCount: Int? = nil
    ) -> OrchestrationV2ThreadProjection {
        OrchestrationV2ThreadProjection(
            thread: thread ?? appThread(),
            runs: runs,
            turnItems: items,
            visibleTurnItems: items.enumerated().map { index, item in
                OrchestrationV2ProjectedTurnItem(
                    position: index,
                    visibility: .local,
                    sourceThreadId: item.base.threadId,
                    sourceItemId: item.id,
                    item: item
                )
            },
            truncatedVisibleItemCount: truncatedVisibleItemCount,
            updatedAt: timestamp
        )
    }

    static func detailSnapshot(
        sequence: Int = 2,
        thread: OrchestrationV2AppThread? = nil,
        items: [OrchestrationV2TurnItem] = [],
        truncatedVisibleItemCount: Int? = nil
    ) -> OrchestrationV2ThreadDetailSnapshot {
        OrchestrationV2ThreadDetailSnapshot(
            snapshotSequence: sequence,
            projection: projection(
                thread: thread,
                items: items,
                truncatedVisibleItemCount: truncatedVisibleItemCount
            )
        )
    }

    /// Turn items are built through their decoder rather than a memberwise
    /// initializer so fixtures exercise the same path production data takes.
    static func turnItem(
        id: String,
        threadID: String = "thread-v2",
        type: String,
        status: String = "completed",
        ordinal: Int = 0,
        extra: [String: JSONValue] = [:]
    ) -> OrchestrationV2TurnItem {
        var object: [String: JSONValue] = [
            "id": .string(id),
            "threadId": .string(threadID),
            "runId": .string("run-1"),
            "nodeId": .null,
            "providerThreadId": .null,
            "providerTurnId": .null,
            "nativeItemRef": .null,
            "parentItemId": .null,
            "ordinal": .number(Double(ordinal)),
            "status": .string(status),
            "title": .null,
            "startedAt": .string(timestamp),
            "completedAt": status == "completed" ? .string(timestamp) : .null,
            "updatedAt": .string(timestamp),
            "type": .string(type),
        ]
        for (key, value) in extra { object[key] = value }
        let data = try! JSONEncoder.t3.encode(JSONValue.object(object))
        return try! JSONDecoder.t3.decode(OrchestrationV2TurnItem.self, from: data)
    }

    static func assistantMessage(
        id: String,
        text: String,
        streaming: Bool = true
    ) -> OrchestrationV2TurnItem {
        turnItem(
            id: id,
            type: "assistant_message",
            status: streaming ? "running" : "completed",
            extra: [
                "messageId": .string("message-" + id),
                "text": .string(text),
                "streaming": .bool(streaming),
            ]
        )
    }

    static func shellSnapshot(
        sequence: Int = 1,
        projects: [OrchestrationProject] = [],
        threads: [OrchestrationV2ThreadShell] = [],
        archivedThreads: [OrchestrationV2ThreadShell] = []
    ) -> OrchestrationV2ShellSnapshot {
        let json = JSONValue.object([
            "schemaVersion": .number(1),
            "snapshotSequence": .number(Double(sequence)),
            "projects": .array(projects.map { encode($0) }),
            "threads": .array(threads.map { encode($0) }),
            "archivedThreads": .array(archivedThreads.map { encode($0) }),
        ])
        let data = try! JSONEncoder.t3.encode(json)
        return try! JSONDecoder.t3.decode(OrchestrationV2ShellSnapshot.self, from: data)
    }

    static func project(
        id: String = "project-1",
        title: String? = nil,
        workspaceRoot: String = "/workspace"
    ) -> OrchestrationProject {
        OrchestrationProject(
            id: id,
            title: title ?? id,
            workspaceRoot: workspaceRoot,
            repositoryIdentity: nil,
            defaultModelSelection: nil,
            faviconPath: nil,
            scripts: [],
            createdAt: timestamp,
            updatedAt: timestamp,
            deletedAt: nil
        )
    }

    private static func encode(_ value: some Encodable) -> JSONValue {
        let data = try! JSONEncoder.t3.encode(value)
        return try! JSONDecoder.t3.decode(JSONValue.self, from: data)
    }
}
