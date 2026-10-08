import Foundation
import XCTest

@testable import T3Code

/// Secret requests, steering, the context meter and usage-limit recovery.
/// Mirrors packages/client-runtime/src/secretRequest.ts,
/// apps/web/src/components/chat/composerDispatch.ts, ContextWindowMeter.logic.ts,
/// and the usage-limit run selection in client-runtime's threadExecution.ts.
final class ComposerRequestsParityTests: XCTestCase {
    // MARK: - Secret requests

    private func secretItem(
        id: String = "secret-1",
        status: String? = "pending",
        placeholder: String? = nil
    ) -> OrchestrationV2TurnItem {
        var extra: [String: JSONValue] = [
            "label": .string("GitHub webhook secret"),
            "reason": .string("  To verify deliveries.  "),
        ]
        if let status { extra["secretStatus"] = .string(status) }
        if let placeholder { extra["placeholder"] = .string(placeholder) }
        return V2Fixture.turnItem(id: id, type: "secret_request", status: "waiting", extra: extra)
    }

    private func projected(
        _ item: OrchestrationV2TurnItem,
        visibility: OrchestrationV2TurnItemVisibility = .local
    ) -> OrchestrationV2ProjectedTurnItem {
        OrchestrationV2ProjectedTurnItem(
            position: 0, visibility: visibility, sourceThreadId: item.base.threadId,
            sourceItemId: item.id, item: item
        )
    }

    func testSecretRequestDecodesAndRoundTrips() throws {
        let item = secretItem(placeholder: "whsec_…")
        guard case let .secretRequest(label, reason, placeholder, status) = item.payload else {
            return XCTFail("Expected a secret request, got \(item.payload)")
        }
        XCTAssertEqual(label, "GitHub webhook secret")
        XCTAssertEqual(reason, "  To verify deliveries.  ")
        XCTAssertEqual(placeholder, "whsec_…")
        XCTAssertEqual(status, .pending)

        let data = try JSONEncoder.t3.encode(item)
        XCTAssertEqual(try JSONDecoder.t3.decode(OrchestrationV2TurnItem.self, from: data), item)
    }

    func testSecretRequestToleratesUnknownAndMissingStatus() {
        guard case let .secretRequest(_, _, _, unknown) = secretItem(status: "expired").payload,
              case let .secretRequest(_, _, _, missing) = secretItem(status: nil).payload else {
            return XCTFail("Expected secret requests")
        }
        XCTAssertEqual(unknown, .unknown)
        XCTAssertEqual(missing, .unknown)
        XCTAssertEqual(SecretRequestPresentation.display(status: .unknown, visibility: .local), .ended)
    }

    func testSecretRequestDisplayFollowsStatusAndVisibility() {
        XCTAssertEqual(SecretRequestPresentation.display(status: .pending, visibility: .local), .pending)
        XCTAssertEqual(SecretRequestPresentation.display(status: .pending, visibility: .inherited), .pendingElsewhere)
        XCTAssertEqual(SecretRequestPresentation.display(status: .saved, visibility: .inherited), .saved)
        XCTAssertEqual(SecretRequestPresentation.display(status: .declined, visibility: .local), .declined)
        XCTAssertEqual(SecretRequestPresentation.display(status: .cancelled, visibility: .local), .ended)
    }

    func testPendingSecretRequestsAreOnlyLocalOpenOnes() {
        let items = [
            projected(secretItem(id: "a")),
            projected(secretItem(id: "b", status: "saved")),
            projected(secretItem(id: "c"), visibility: .inherited),
            projected(secretItem(id: "d", placeholder: "   ")),
        ]
        let pending = SecretRequestPresentation.pending(in: items)
        XCTAssertEqual(pending.map(\.turnItemID), ["a", "d"])
        XCTAssertEqual(pending.first?.sourceThreadID, "thread-v2")
        XCTAssertEqual(pending.first?.reason, "To verify deliveries.")
        XCTAssertNil(pending.last?.placeholder, "A blank placeholder falls back to the default")
    }

    func testSecretAnswerPayloadTrimsAndRejectsBlank() {
        XCTAssertEqual(
            SecretRequestAnswer.save("  sk-123 \n").jsonValue,
            .object(["type": .string("save"), "secret": .string("sk-123")])
        )
        XCTAssertNil(SecretRequestAnswer.save(" \n ").jsonValue)
        XCTAssertEqual(SecretRequestAnswer.decline.jsonValue, .object(["type": .string("decline")]))
        XCTAssertFalse(SecretRequestPresentation.canSave("   "))
        XCTAssertTrue(SecretRequestPresentation.canSave(" x "))
    }

    func testSecretFailureCopyNeverPassesUnknownServerText() {
        let known = SecretRequestFailure.message(for: "already_answered")
        XCTAssertEqual(known, "This secret request was already answered.")
        XCTAssertEqual(SecretRequestFailure.userMessage(for: RPCError.remote(known)), known)
        XCTAssertEqual(
            SecretRequestFailure.userMessage(for: RPCError.remote("Expected string, got \"sk-live-123\"")),
            SecretRequestFailure.generic
        )
        XCTAssertEqual(SecretRequestFailure.userMessage(for: RPCError.disconnected), SecretRequestFailure.generic)
        XCTAssertEqual(
            SecretRequestFailure.userMessage(for: SecretRequestPermissionMissing()),
            SecretRequestPermissionMissing.message
        )
        XCTAssertEqual(SecretRequestFailure.message(for: "something_new"), SecretRequestFailure.generic)
    }

    // MARK: - Steering

    func testSteerGoesOutOnlyWhileItsRunIsActive() {
        let steer = FeatureSteerTarget(runID: "run-1", restartsTurn: false)
        XCTAssertEqual(
            ComposerFollowUp.dispatchMode(steer: steer, liveActiveRunID: "run-1"),
            .steerActive(runID: "run-1")
        )
        XCTAssertEqual(
            ComposerFollowUp.dispatchMode(
                steer: FeatureSteerTarget(runID: "run-1", restartsTurn: true),
                liveActiveRunID: "run-1"
            ),
            .restartActive(runID: "run-1")
        )
        // The run ended between typing and sending: an ordinary send.
        XCTAssertEqual(ComposerFollowUp.dispatchMode(steer: steer, liveActiveRunID: nil), .startImmediately)
        XCTAssertEqual(ComposerFollowUp.dispatchMode(steer: steer, liveActiveRunID: "run-2"), .startImmediately)
        XCTAssertEqual(ComposerFollowUp.dispatchMode(steer: nil, liveActiveRunID: "run-1"), .startImmediately)
    }

    func testAlternateSendPicksTheOtherAction() {
        XCTAssertFalse(ComposerFollowUp.steers(defaultSteers: false, alternate: false))
        XCTAssertTrue(ComposerFollowUp.steers(defaultSteers: false, alternate: true))
        XCTAssertTrue(ComposerFollowUp.steers(defaultSteers: true, alternate: false))
        XCTAssertFalse(ComposerFollowUp.steers(defaultSteers: true, alternate: true))
        XCTAssertEqual(ComposerFollowUp.placeholder(isWorking: false, defaultSteers: true), "Ask anything…")
        XCTAssertEqual(ComposerFollowUp.placeholder(isWorking: true, defaultSteers: true), "Message to steer…")
        XCTAssertEqual(ComposerFollowUp.placeholder(isWorking: true, defaultSteers: false), "Message to queue…")
    }

    func testSteerTargetNeedsASteerableRun() {
        let run = ThreadWorkflowRun(id: "run-1", ordinal: 1, status: "running", activeAttemptID: "attempt-1")
        let running = ThreadWorkflows.deriveQueueWorkflowState(
            runs: [run],
            providerTurns: [ThreadWorkflowProviderTurn(id: "turn-1", runAttemptID: "attempt-1", status: "running")],
            session: ThreadWorkflowSession(
                id: "session-1",
                status: "running",
                turns: ThreadTurnCapabilities(
                    supportsActiveSteering: false,
                    supportsSteeringByInterruptRestart: true,
                    supportsQueuedMessages: true
                )
            )
        )
        let target = ComposerFollowUp.steerTarget(
            queueState: running,
            capabilities: ThreadTurnCapabilities(
                supportsActiveSteering: false,
                supportsSteeringByInterruptRestart: true,
                supportsQueuedMessages: true
            )
        )
        XCTAssertEqual(target, FeatureSteerTarget(runID: "run-1", restartsTurn: true))

        let noTurn = ThreadWorkflows.deriveQueueWorkflowState(runs: [run])
        XCTAssertNil(ComposerFollowUp.steerTarget(queueState: noTurn, capabilities: nil))
    }

    // MARK: - Context meter

    func testContextWindowCarriesSizeAndCompactionPolicy() {
        let thread = OrchestrationV2ProviderThread(
            id: "pt-1", providerInstanceId: "claude", providerSessionId: nil, appThreadId: "thread-v2",
            status: "active",
            contextUsage: OrchestrationV2ContextUsage(
                usedTokens: 84_000, maxTokens: 200_000, autoCompactThreshold: 180_000,
                totalProcessedTokens: 1_200_000, compactsAutomatically: true
            ),
            updatedAt: V2Fixture.timestamp
        )
        let window = ThreadContextWindow.latest(
            providerTurns: [], providerThread: thread, items: [], parseDate: ThreadTimelineDay.date(fromISO8601:)
        )
        XCTAssertEqual(window?.maxTokens, 200_000)
        XCTAssertEqual(window?.autoCompactThreshold, 180_000)
        XCTAssertEqual(window?.compactsAutomatically, true)
        XCTAssertEqual(window.flatMap(ContextWindowFormat.usedPercentage), 42)
        XCTAssertEqual(window.map { ContextWindowFormat.isNearlyFull($0) }, false)
    }

    func testContextWindowFormatting() {
        XCTAssertEqual(ContextWindowFormat.tokens(950), "950")
        XCTAssertEqual(ContextWindowFormat.tokens(4_200), "4.2k")
        XCTAssertEqual(ContextWindowFormat.tokens(4_000), "4k")
        XCTAssertEqual(ContextWindowFormat.tokens(84_400), "84k")
        XCTAssertEqual(ContextWindowFormat.tokens(1_250_000), "1.3m")
        XCTAssertEqual(ContextWindowFormat.percentage(4.24), "4.2%")
        XCTAssertEqual(ContextWindowFormat.percentage(4.0), "4%")
        XCTAssertEqual(ContextWindowFormat.percentage(42.4), "42%")
        XCTAssertEqual(
            ContextWindowFormat.compactionNote(modelName: "Opus", threshold: 180_000),
            "Compacts automatically at 180,000 tokens."
        )
        XCTAssertEqual(
            ContextWindowFormat.compactionNote(modelName: "Opus", threshold: nil),
            "Context for Opus compacts automatically when needed."
        )
        XCTAssertNil(ContextWindowFormat.usedPercentage(ThreadContextWindow(usedTokens: 10, updatedAt: nil)))
    }

    // MARK: - Usage limits

    private func run(
        _ id: String,
        ordinal: Int,
        status: String,
        completedAt: String? = V2Fixture.timestamp,
        queueHeld: Bool = false
    ) -> OrchestrationV2Run {
        var object: [String: JSONValue] = [
            "id": .string(id),
            "ordinal": .number(Double(ordinal)),
            "status": .string(status),
            "providerInstanceId": .string("codex"),
            "userMessageId": .string("message-\(id)"),
            "requestedAt": .string(V2Fixture.timestamp),
            "startedAt": status == "queued" ? .null : .string(V2Fixture.timestamp),
            "completedAt": completedAt.map(JSONValue.string) ?? .null,
            "rootNodeId": .string("node-\(id)"),
        ]
        if queueHeld { object["queueHeld"] = .bool(true) }
        let data = try! JSONEncoder.t3.encode(JSONValue.object(object))
        return try! JSONDecoder.t3.decode(OrchestrationV2Run.self, from: data)
    }

    private func error(
        runID: String = "run-1",
        nodeID: String? = "node-run-1",
        failureClass: String = "usage_limit",
        message: String = "You've hit your usage limit.",
        resetAt: String? = "2026-07-31T15:00:00.000Z"
    ) -> OrchestrationV2TurnItem {
        var failure: [String: JSONValue] = [
            "class": .string(failureClass),
            "message": .string(message),
            "code": .null,
            "retryable": .null,
        ]
        if let resetAt { failure["resetAt"] = .string(resetAt) }
        var extra: [String: JSONValue] = [
            "runId": .string(runID),
            "failure": .object(failure),
        ]
        extra["nodeId"] = nodeID.map(JSONValue.string) ?? .null
        return V2Fixture.turnItem(id: "error-\(runID)-\(nodeID ?? "none")", type: "error", status: "failed", extra: extra)
    }

    func testProviderFailureDecodesResetAt() {
        guard case let .error(failure, _) = error().payload,
              case let .error(noReset, _) = error(resetAt: nil).payload else {
            return XCTFail("Expected errors")
        }
        XCTAssertEqual(failure.resetAt, "2026-07-31T15:00:00.000Z")
        XCTAssertNil(noReset.resetAt)
    }

    func testLimitedRunIsTheFailedRunsUsageLimit() {
        let result = ThreadUsageLimits.limitedRun(
            runs: [run("run-1", ordinal: 1, status: "failed")],
            items: [error()],
            sessionError: nil
        )
        XCTAssertEqual(result?.run.id, "run-1")
        XCTAssertEqual(result?.resetAt, "2026-07-31T15:00:00.000Z")
    }

    func testLimitedRunStaysTheOutcomeBehindQueuedMessages() {
        let result = ThreadUsageLimits.limitedRun(
            runs: [run("run-1", ordinal: 1, status: "failed"), run("run-2", ordinal: 2, status: "queued", completedAt: nil)],
            items: [error()],
            sessionError: nil
        )
        XCTAssertEqual(result?.run.id, "run-1")
    }

    func testOtherFailuresAndLaterRunsAreNotLimits() {
        XCTAssertNil(ThreadUsageLimits.limitedRun(
            runs: [run("run-1", ordinal: 1, status: "failed")],
            items: [error(failureClass: "provider_error")],
            sessionError: nil
        ))
        // A subagent's limit is not the run's own.
        XCTAssertNil(ThreadUsageLimits.limitedRun(
            runs: [run("run-1", ordinal: 1, status: "failed")],
            items: [error(nodeID: "node-subagent")],
            sessionError: nil
        ))
        // A distinct session failure supersedes the turn's classification.
        XCTAssertNil(ThreadUsageLimits.limitedRun(
            runs: [run("run-1", ordinal: 1, status: "failed")],
            items: [error()],
            sessionError: "The provider process exited."
        ))
        // A later run started and finished: the limit is history.
        XCTAssertNil(ThreadUsageLimits.limitedRun(
            runs: [
                run("run-1", ordinal: 1, status: "failed", completedAt: "2026-07-31T12:00:00.000Z"),
                run("run-2", ordinal: 2, status: "completed", completedAt: "2026-07-31T16:00:00.000Z"),
            ],
            items: [error()],
            sessionError: nil
        ))
        // A run working now replaces the failed outcome.
        XCTAssertNil(ThreadUsageLimits.limitedRun(
            runs: [run("run-1", ordinal: 1, status: "failed"), run("run-2", ordinal: 2, status: "running", completedAt: nil)],
            items: [error()],
            sessionError: nil
        ))
    }

    func testRecoveryChoiceMatchesOnlyItsRunAndReset() {
        let reset = "2026-07-31T15:00:00.000Z"
        let limit = ThreadUsageLimit(
            runID: "run-1",
            resetAt: reset,
            stoppedAt: V2Fixture.timestamp,
            recovery: OrchestrationV2LimitRecovery(runId: "run-1", resetAt: reset, autoResume: true, snooze: true),
            snoozedUntil: "2026-07-31T15:00:00Z"
        )
        XCTAssertTrue(limit.canSchedule)
        XCTAssertTrue(limit.autoResumeScheduled)
        XCTAssertTrue(limit.isSnoozed, "Snooze compares instants, not strings")

        let stale = ThreadUsageLimit(
            runID: "run-2",
            resetAt: reset,
            stoppedAt: V2Fixture.timestamp,
            recovery: limit.recovery,
            snoozedUntil: limit.snoozedUntil
        )
        XCTAssertFalse(stale.autoResumeScheduled)
        XCTAssertFalse(stale.isSnoozed)

        let expired = ThreadUsageLimit(
            runID: "run-1", resetAt: "2026-07-31T11:00:00.000Z", stoppedAt: V2Fixture.timestamp,
            recovery: nil, snoozedUntil: nil
        )
        XCTAssertFalse(expired.canSchedule, "A reset before the stop cannot be waited for")
        let unknown = ThreadUsageLimit(
            runID: "run-1", resetAt: nil, stoppedAt: V2Fixture.timestamp, recovery: nil, snoozedUntil: nil
        )
        XCTAssertFalse(unknown.canSchedule)
    }

    func testResolveReadsRecoveryFromTheProjection() throws {
        var threadJSON = try JSONDecoder.t3.decode(
            JSONValue.self, from: JSONEncoder.t3.encode(V2Fixture.appThread())
        )
        if case var .object(fields) = threadJSON {
            fields["limitRecovery"] = .object([
                "runId": .string("run-1"),
                "resetAt": .string("2026-07-31T15:00:00.000Z"),
                "autoResume": .bool(true),
            ])
            threadJSON = .object(fields)
        }
        let thread = try JSONDecoder.t3.decode(OrchestrationV2AppThread.self, from: JSONEncoder.t3.encode(threadJSON))
        let projection = V2Fixture.projection(
            thread: thread,
            runs: [run("run-1", ordinal: 1, status: "failed")],
            items: [error()]
        )
        let limit = ThreadUsageLimits.resolve(projection)
        XCTAssertEqual(limit?.runID, "run-1")
        XCTAssertEqual(limit?.autoResumeScheduled, true)
        XCTAssertNil(ThreadUsageLimits.resolve(V2Fixture.projection(runs: [run("run-1", ordinal: 1, status: "completed")])))
    }

    func testLimitRecoveryCommandSendsOnlyTheToggledOption() {
        let command = OrchestrationCommands.updateLimitRecovery(
            threadID: "thread-v2", runID: "run-1", resetAt: "2026-07-31T15:00:00.000Z", snooze: false
        )
        XCTAssertEqual(command["type"]?.stringValue, "thread.metadata.update")
        XCTAssertEqual(command["limitRecovery"]?["runId"]?.stringValue, "run-1")
        XCTAssertEqual(command["limitRecovery"]?["snooze"], .bool(false))
        XCTAssertNil(command["limitRecovery"]?["autoResume"])
    }

    func testResetLabelReadsLikeWeb() throws {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = try XCTUnwrap(TimeZone(identifier: "UTC"))
        let locale = Locale(identifier: "en_US")
        let now = try XCTUnwrap(ThreadTimelineDay.date(fromISO8601: "2026-07-31T12:00:00Z"))
        func label(_ iso: String) throws -> String {
            UsageLimitTime.label(
                for: try XCTUnwrap(ThreadTimelineDay.date(fromISO8601: iso)),
                now: now, calendar: calendar, locale: locale
            )
        }
        XCTAssertEqual(try label("2026-07-31T15:40:00Z"), "3:40\u{202F}PM")
        XCTAssertEqual(try label("2026-08-01T09:00:00Z"), "tomorrow at 9:00\u{202F}AM")
        XCTAssertEqual(try label("2026-08-04T09:00:00Z"), "Aug 4, 9:00\u{202F}AM")
        XCTAssertEqual(try label("2027-01-04T09:00:00Z"), "Jan 4, 2027, 9:00\u{202F}AM")
    }
}
