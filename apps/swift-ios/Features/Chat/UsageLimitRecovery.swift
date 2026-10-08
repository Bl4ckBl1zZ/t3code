import SwiftUI

// A thread the provider stopped on a usage limit: the warning row in the work
// log and the recovery banner above the composer. Ports
// apps/web/src/components/chat/UsageLimitRecoveryBanner.tsx, the usage-limit
// heading in MessagesTimeline.tsx, and the run selection in
// packages/client-runtime/src/state/threadExecution.ts (`deriveThreadRuntime`)
// with packages/shared/src/orchestrationV2ThreadError.ts.

/// The open thread stopped on a usage limit, with what recovery can act on.
public struct ThreadUsageLimit: Equatable, Sendable {
    /// The run the limit stopped. A recovery choice belongs to it.
    public let runID: String
    /// Verbatim from the failure: the server matches a choice on this string.
    public let resetAt: OrchestrationV2Timestamp?
    public let stoppedAt: OrchestrationV2Timestamp
    public let recovery: OrchestrationV2LimitRecovery?
    public let snoozedUntil: OrchestrationV2Timestamp?

    public var resetDate: Date? { resetAt.flatMap(ThreadTimelineDay.date(fromISO8601:)) }

    /// Only a reset after the stop can be waited for; an already-expired window
    /// reported with the failure is retried by hand.
    public var canSchedule: Bool {
        guard let reset = resetDate, let stopped = ThreadTimelineDay.date(fromISO8601: stoppedAt) else {
            return false
        }
        return reset > stopped
    }

    private var recoveryMatches: Bool {
        recovery?.runId == runID && recovery?.resetAt == resetAt
    }

    public var autoResumeScheduled: Bool {
        recoveryMatches && recovery?.autoResume == true
    }

    /// Snoozed by this recovery choice, not by a snooze the user set by hand.
    public var isSnoozed: Bool {
        guard recoveryMatches, recovery?.snooze == true, let reset = resetDate,
              let until = snoozedUntil.flatMap(ThreadTimelineDay.date(fromISO8601:)) else { return false }
        return until == reset
    }
}

enum ThreadUsageLimits {
    private static let activityStatuses: Set<String> = ["preparing", "starting", "running", "waiting"]

    /// The limit the thread is stopped on, or nil when it is not stopped on one.
    static func resolve(_ projection: OrchestrationV2ThreadProjection) -> ThreadUsageLimit? {
        let sessionError = projection.providerSessions
            .last { $0.providerInstanceId == projection.thread.providerInstanceId }?
            .lastError
        let items = projection.turnItems.isEmpty
            ? projection.visibleTurnItems.map(\.item)
            : projection.turnItems
        guard let stop = limitedRun(runs: projection.runs, items: items, sessionError: sessionError) else {
            return nil
        }
        return ThreadUsageLimit(
            runID: stop.run.id,
            resetAt: stop.resetAt,
            stoppedAt: stop.run.completedAt ?? projection.thread.updatedAt,
            recovery: projection.thread.limitRecovery,
            snoozedUntil: projection.thread.snoozedUntil
        )
    }

    /// The run standing for the thread's outcome when that outcome is a usage
    /// limit, and the reset its failure names.
    static func limitedRun(
        runs: [OrchestrationV2Run],
        items: [OrchestrationV2TurnItem],
        sessionError: String?
    ) -> (run: OrchestrationV2Run, resetAt: String?)? {
        // A limited run stays the outcome while newer messages wait behind it.
        let blocked = usageLimitBlockedRun(runs: runs, items: items, sessionError: sessionError)
            .flatMap { blocked in runs.contains { $0.ordinal > blocked.ordinal } ? blocked : nil }
        guard let presented = blocked ?? latestUnheldRun(runs) else { return nil }
        let activity = runs
            .filter { activityStatuses.contains($0.status) }
            .max { $0.ordinal < $1.ordinal }
            ?? presented
        let status = blocked != nil ? "failed" : activity.status
        let summary = errorSummary(
            failure: latestRootFailure(run: presented, items: items),
            sessionError: sessionError
        )
        guard status == "failed", UsageLimitFailure.isUsageLimit(summary.failureClass) else { return nil }
        return (presented, summary.resetAt)
    }

    /// `usageLimitBlockedRun`: the latest run that actually started, when a
    /// usage limit stopped it.
    static func usageLimitBlockedRun(
        runs: [OrchestrationV2Run],
        items: [OrchestrationV2TurnItem],
        sessionError: String?
    ) -> OrchestrationV2Run? {
        guard let executed = latestExecutedRun(runs), executed.status == "failed" else { return nil }
        let summary = errorSummary(failure: latestRootFailure(run: executed, items: items), sessionError: sessionError)
        return UsageLimitFailure.isUsageLimit(summary.failureClass) ? executed : nil
    }

    static func latestExecutedRun(_ runs: [OrchestrationV2Run]) -> OrchestrationV2Run? {
        var latest: OrchestrationV2Run?
        for run in runs {
            if run.status == "queued" { continue }
            if run.status == "cancelled", run.startedAt == nil { continue }
            if let current = latest, !ranAfter(run, current) { continue }
            latest = run
        }
        return latest
    }

    /// Whether started `run` ran after `other`; an unfinished run is the latest.
    static func ranAfter(_ run: OrchestrationV2Run, _ other: OrchestrationV2Run) -> Bool {
        func end(_ candidate: OrchestrationV2Run) -> Date {
            candidate.completedAt.flatMap(ThreadTimelineDay.date(fromISO8601:)) ?? .distantFuture
        }
        let left = end(run)
        let right = end(other)
        return left == right ? run.ordinal > other.ordinal : left > right
    }

    /// The newest run not waiting in a held queue.
    static func latestUnheldRun(_ runs: [OrchestrationV2Run]) -> OrchestrationV2Run? {
        runs
            .filter { !($0.status == "queued" && $0.queueHeld == true) }
            .max { $0.ordinal < $1.ordinal }
    }

    /// The run's own failure: a failed error item on its root node, newest
    /// first. A run decoded from a server without `rootNodeId` matches any node.
    static func latestRootFailure(
        run: OrchestrationV2Run,
        items: [OrchestrationV2TurnItem]
    ) -> OrchestrationV2ProviderFailure? {
        guard run.status == "failed" else { return nil }
        var latest: (item: OrchestrationV2TurnItem, failure: OrchestrationV2ProviderFailure, date: Date)?
        for item in items {
            guard case let .error(failure, _) = item.payload,
                  item.status == .failed,
                  item.base.runId == run.id,
                  run.rootNodeId == nil || item.base.nodeId == run.rootNodeId else { continue }
            let date = ThreadTimelineDay.date(fromISO8601: item.base.updatedAt) ?? .distantPast
            if let current = latest {
                let newer = date > current.date
                    || (date == current.date
                        && (item.ordinal > current.item.ordinal
                            || (item.ordinal == current.item.ordinal && item.id > current.item.id)))
                guard newer else { continue }
            }
            latest = (item, failure, date)
        }
        return latest?.failure
    }

    /// A distinct session failure supersedes the turn's classification.
    static func errorSummary(
        failure: OrchestrationV2ProviderFailure?,
        sessionError: String?
    ) -> (failureClass: String?, resetAt: String?) {
        if let sessionError, sessionError != failure?.message { return (nil, nil) }
        guard let failure else { return (nil, nil) }
        return (failure.failureClass, UsageLimitFailure.isUsageLimit(failure.failureClass) ? failure.resetAt : nil)
    }
}

enum UsageLimitTime {
    /// "3:40 PM" today, "tomorrow at 3:40 PM", otherwise "Oct 9, 3:40 PM".
    /// Mirrors web's `formatUpcomingTimestamp`.
    static func label(
        for date: Date,
        now: Date = .now,
        calendar: Calendar = .current,
        locale: Locale = .current
    ) -> String {
        var time = Date.FormatStyle(date: .omitted, time: .shortened)
        time.calendar = calendar
        time.timeZone = calendar.timeZone
        time.locale = locale
        let clock = date.formatted(time)
        let days = calendar.dateComponents(
            [.day],
            from: calendar.startOfDay(for: now),
            to: calendar.startOfDay(for: date)
        ).day ?? 0
        if days == 0 { return clock }
        if days == 1 { return "tomorrow at \(clock)" }
        var day = Date.FormatStyle.dateTime.month(.abbreviated).day()
        if calendar.component(.year, from: date) != calendar.component(.year, from: now) {
            day = day.year()
        }
        day.calendar = calendar
        day.timeZone = calendar.timeZone
        day.locale = locale
        return "\(date.formatted(day)), \(clock)"
    }

    /// The work log heading for a failed turn: when to try again, if known.
    static func heading(resetAt: String?, now: Date = .now) -> String {
        guard let date = resetAt.flatMap(ThreadTimelineDay.date(fromISO8601:)) else {
            return "Usage limit reached."
        }
        return "Usage limit reached. Retry after \(label(for: date, now: now))."
    }
}

/// Above the composer while the thread is stopped on a usage limit: when the
/// limit resets, and the choice to resume or snooze until then. Static; the
/// one scheduled refresh is at the reset itself, which retires Snooze.
struct UsageLimitRecoveryBanner: View {
    let limit: ThreadUsageLimit
    let onUpdate: (_ autoResume: Bool?, _ snooze: Bool?) async throws -> Void

    private enum Action: Equatable { case resume, snooze }

    @State private var pendingAction: Action?
    @State private var errorMessage: String?

    var body: some View {
        TimelineView(.explicit(limit.resetDate.map { [$0] } ?? [])) { context in
            content(now: context.date)
        }
        .onChange(of: limit) {
            errorMessage = nil
        }
    }

    private func content(now: Date) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            Image(systemName: "gauge.with.dots.needle.100percent")
                .foregroundStyle(T3Colors.warning)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 8) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Usage limit reached")
                        .font(T3Typography.supportingStrong)
                        .foregroundStyle(T3Colors.textPrimary)
                    Text(verbatim: description(now: now))
                        .font(T3Typography.supporting)
                        .foregroundStyle(T3Colors.textSecondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .accessibilityElement(children: .combine)
                if limit.canSchedule {
                    ViewThatFits(in: .horizontal) {
                        HStack(spacing: 8) { actions(now: now) }
                        VStack(alignment: .leading, spacing: 8) { actions(now: now) }
                    }
                }
                if let errorMessage {
                    Text(errorMessage)
                        .font(T3Typography.supporting)
                        .foregroundStyle(T3Colors.danger)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(14)
        .background(T3Colors.warning.opacity(0.10), in: RoundedRectangle(cornerRadius: 20, style: .continuous))
        .t3GlassRim(in: RoundedRectangle(cornerRadius: 20, style: .continuous))
        .padding(.horizontal, 16)
        .padding(.bottom, 8)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("thread-usage-limit-banner")
    }

    private func description(now: Date) -> String {
        guard let reset = limit.resetDate else { return "Reset time unavailable; retry manually." }
        let when = UsageLimitTime.label(for: reset, now: now)
        if limit.autoResumeScheduled { return "Resets \(when). The thread resumes then." }
        return "Resets \(when)."
    }

    @ViewBuilder
    private func actions(now: Date) -> some View {
        let resetPassed = (limit.resetDate ?? .distantPast) <= now
        actionButton(
            limit.autoResumeScheduled ? "Cancel Auto-Resume" : "Resume at Reset",
            systemImage: limit.autoResumeScheduled ? "xmark" : "play",
            action: .resume
        ) {
            try await onUpdate(!limit.autoResumeScheduled, nil)
        }
        if limit.isSnoozed {
            actionButton("Wake Now", systemImage: "sun.max", action: .snooze) {
                try await onUpdate(nil, false)
            }
        } else {
            actionButton("Snooze Until Reset", systemImage: "moon.zzz", action: .snooze) {
                try await onUpdate(nil, true)
            }
            .disabled(resetPassed)
        }
    }

    private func actionButton(
        _ title: String,
        systemImage: String,
        action: Action,
        perform: @escaping () async throws -> Void
    ) -> some View {
        Button {
            guard pendingAction == nil else { return }
            pendingAction = action
            errorMessage = nil
            Task {
                do {
                    try await perform()
                } catch is CancellationError {
                } catch {
                    errorMessage = error.localizedDescription
                    AccessibilityNotification.Announcement(error.localizedDescription).post()
                }
                pendingAction = nil
            }
        } label: {
            if pendingAction == action {
                HStack(spacing: 6) {
                    ProgressView().controlSize(.mini)
                    Text("Saving…")
                }
            } else {
                Label(title, systemImage: systemImage)
            }
        }
        .buttonStyle(.bordered)
        .buttonBorderShape(.capsule)
        .controlSize(.small)
        .tint(T3Colors.textPrimary)
        .disabled(pendingAction != nil)
    }
}

/// A usage-limit stop in the work log: a warning to wait or switch, not a
/// failed call, and when to try again.
struct UsageLimitTimelineCallout: View {
    let row: ThreadWorkLogRow
    let onRetry: (() -> Void)?

    /// The rows this replaces the red failure callout for.
    static func applies(to item: OrchestrationV2TurnItem) -> Bool {
        guard case let .error(failure, _) = item.payload else { return false }
        return UsageLimitFailure.isUsageLimit(failure.failureClass) && item.status != .completed
    }

    private var failure: OrchestrationV2ProviderFailure? {
        guard case let .error(failure, _) = row.item.payload else { return nil }
        return failure
    }

    private var heading: String {
        guard row.item.status == .failed else {
            return failure.map { ProviderErrorPresentation.present($0.message) } ?? row.summary
        }
        return UsageLimitTime.heading(resetAt: failure?.resetAt)
    }

    /// The provider's own words, under the heading, for a failed turn.
    private var detail: String? {
        guard row.item.status == .failed, let failure else { return nil }
        let message = ProviderErrorPresentation.present(failure.message)
        return message.isEmpty ? nil : message
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Image(systemName: "exclamationmark.circle.fill")
                    .foregroundStyle(T3Colors.warning)
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 4) {
                    Text(verbatim: heading)
                        .font(.footnote.weight(.semibold))
                        .foregroundStyle(T3Colors.textPrimary)
                    if let detail {
                        Text(verbatim: detail)
                            .font(.footnote)
                            .foregroundStyle(T3Colors.textSecondary)
                            .lineLimit(4)
                            .textSelection(.enabled)
                    }
                }
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            if let onRetry, row.item.status == .failed {
                Button("Try Again", systemImage: "arrow.clockwise", action: onRetry)
                    .buttonStyle(.bordered)
                    .buttonBorderShape(.capsule)
                    .controlSize(.small)
                    .tint(T3Colors.textPrimary)
                    .padding(.leading, 24)
            }
        }
        .padding(14)
        .background(T3Colors.warning.opacity(0.10), in: RoundedRectangle(cornerRadius: 18, style: .continuous))
        .padding(.vertical, 4)
        .accessibilityElement(children: .contain)
        .accessibilityLabel([heading, detail].compactMap { $0 }.joined(separator: " "))
    }
}
