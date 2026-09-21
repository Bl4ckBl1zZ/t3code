import SwiftUI

// The thread screen's own chrome: what the navigation bar says under the
// title, the connection and archive states that replace or sit beside the
// composer, the jump back to the latest turn, and the caption under a user
// bubble. Kept out of ThreadDetailView so the transcript file stays about the
// transcript.

// MARK: - Subtitle

/// The line under the thread title: state first, so truncation drops the
/// environment rather than the thing the reader opened the thread to check.
struct ThreadHeaderSubtitle: Equatable {
    enum Tone: Equatable {
        case running, background, warning, input, danger, success, secondary
    }

    struct Status: Equatable {
        let label: String
        let tone: Tone
        /// Only the pre-iOS 26 header draws it; the system subtitle is text.
        var systemImage: String?
    }

    let status: Status?
    /// Branch (or "Chat") and environment, in that order.
    let details: [String]

    var isEmpty: Bool { status == nil && details.isEmpty }

    /// The plain form, for VoiceOver and the back-history menu.
    var plainText: String {
        ([status?.label].compactMap { $0 } + details).joined(separator: " · ")
    }

    /// Minutes are the finest grain the subtitle reports. The composer band
    /// owns the live stopwatch; this only has to stay roughly current.
    static func workingDuration(since start: Date?, now: Date) -> String? {
        guard let start else { return nil }
        let seconds = now.timeIntervalSince(start)
        guard seconds >= 60 else { return nil }
        return HomeWorkingDuration.compact(since: start, now: now)
    }

    static func resolve(
        thread: FeatureThread,
        environmentName: String?,
        connection: FeatureConnection.State?,
        now: Date
    ) -> ThreadHeaderSubtitle {
        var details: [String] = []
        if thread.workInboxRole == "chat" {
            details.append("Chat")
        } else if let branch = branchLabel(thread) {
            details.append(branch)
        }
        if let environmentName, !environmentName.isEmpty {
            details.append(environmentName)
        }
        return ThreadHeaderSubtitle(
            status: status(thread: thread, connection: connection, now: now),
            details: details
        )
    }

    private static func status(
        thread: FeatureThread,
        connection: FeatureConnection.State?,
        now: Date
    ) -> Status? {
        // An unreachable environment makes every other state stale, so it wins.
        switch connection {
        case .disconnected:
            return Status(label: "Offline", tone: .warning, systemImage: "wifi.slash")
        case .connecting, .reconnecting:
            return Status(label: "Reconnecting…", tone: .secondary, systemImage: "wifi")
        case .connected, nil:
            break
        }
        switch thread.homeStatus {
        case .working:
            let duration = workingDuration(since: thread.workingStartedAt, now: now)
            return Status(
                label: duration.map { "Working \($0)" } ?? "Working",
                tone: .running,
                systemImage: "circle.dotted"
            )
        case .approval:
            return Status(label: "Needs approval", tone: .warning)
        case .input:
            return Status(label: "Needs input", tone: .input)
        case .background:
            return Status(label: "Background", tone: .background, systemImage: "circle.dotted")
        case .failed, .done, .ready:
            break
        }
        if thread.isArchived {
            return Status(label: "Archived", tone: .secondary, systemImage: "archivebox")
        }
        if let until = thread.snoozedUntil, until > now {
            let day = until.formatted(.dateTime.weekday(.abbreviated).hour().minute())
            return Status(label: "Snoozed until \(day)", tone: .secondary, systemImage: "moon.zzz")
        }
        switch thread.homeStatus {
        case .failed:
            return Status(label: "Failed", tone: .danger, systemImage: "exclamationmark.circle")
        case .done:
            return Status(label: "Done", tone: .success, systemImage: "checkmark.circle")
        default:
            // Idle says nothing: "Ready" on every quiet thread is noise.
            return nil
        }
    }

    /// The branch, or the worktree folder when the thread has no branch name.
    /// Nothing at all otherwise: "workspace" told the reader nothing.
    static func branchLabel(_ thread: FeatureThread) -> String? {
        if let branch = thread.branch?.trimmingCharacters(in: .whitespacesAndNewlines), !branch.isEmpty {
            return branch
        }
        if let path = thread.worktreePath?.trimmingCharacters(in: .whitespacesAndNewlines), !path.isEmpty {
            return URL(fileURLWithPath: path).lastPathComponent
        }
        return nil
    }
}

extension ThreadHeaderSubtitle.Tone {
    var color: Color {
        switch self {
        case .running: T3Colors.statusRunning
        // The running hue, dimmed: nothing is generating, something is merely
        // still out there.
        case .background: T3Colors.statusRunning.opacity(0.8)
        case .warning: T3Colors.warning
        case .input: T3Colors.statusInput
        case .danger: T3Colors.danger
        case .success: T3Colors.success
        case .secondary: T3Colors.textSecondary
        }
    }
}

/// Sets the thread title and subtitle the way each system draws them best:
/// the system subtitle under a glass bar on iOS 26, and the two-line principal
/// header in the opaque bar before that.
struct ThreadHeaderModifier: ViewModifier {
    let title: String
    let subtitle: ThreadHeaderSubtitle

    @SwiftUI.Environment(\.horizontalSizeClass) private var horizontalSizeClass

    func body(content: Content) -> some View {
        if #available(iOS 26, *) {
            content.navigationSubtitle(subtitleText)
        } else {
            content.toolbar {
                ToolbarItem(placement: .principal) { legacyHeader }
            }
        }
    }

    private var subtitleText: Text {
        guard let status = subtitle.status else {
            return Text(verbatim: subtitle.details.joined(separator: " · "))
        }
        let rest = subtitle.details.isEmpty ? "" : " · " + subtitle.details.joined(separator: " · ")
        return Text(verbatim: status.label).foregroundStyle(status.tone.color) + Text(verbatim: rest)
    }

    private var legacyHeader: some View {
        VStack(alignment: .leading, spacing: 1) {
            Text(title)
                .font(T3Typography.navigationTitle)
                .foregroundStyle(T3Colors.textPrimary)
                .lineLimit(1)
                .layoutPriority(1)
            if !subtitle.isEmpty {
                HStack(spacing: 5) {
                    if let status = subtitle.status {
                        HStack(spacing: 4) {
                            if let symbol = status.systemImage { Image(systemName: symbol) }
                            Text(status.label)
                        }
                        .font(T3Typography.status)
                        .foregroundStyle(status.tone.color)
                        .fixedSize(horizontal: true, vertical: false)
                    }
                    if !subtitle.details.isEmpty {
                        Text((subtitle.status == nil ? "" : "· ") + subtitle.details.joined(separator: " · "))
                            .lineLimit(1)
                            .truncationMode(.tail)
                    }
                }
                .font(T3Typography.navigationMetadata)
                .foregroundStyle(T3Colors.textTertiary)
            }
        }
        .frame(maxWidth: horizontalSizeClass == .compact ? 260 : 460, alignment: .leading)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(title)
        .accessibilityValue(subtitle.plainText)
        .accessibilityAddTraits(.isHeader)
    }
}

// MARK: - Jump to latest

/// Appears only while the reader is scrolled into history. A dot says that
/// something landed below since they left the bottom.
struct ThreadJumpToLatestButton: View {
    let hasNewContent: Bool
    let action: () -> Void

    @ScaledMetric(relativeTo: .body) private var diameter: CGFloat = 44

    var body: some View {
        Button(action: action) {
            Image(systemName: "arrow.down")
                .font(.body.weight(.semibold))
                .foregroundStyle(T3Colors.textPrimary)
                .frame(width: diameter, height: diameter)
                .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .t3GlassEffect(interactive: true, in: Circle())
        .t3GlassRim(in: Circle())
        .overlay(alignment: .topTrailing) {
            if hasNewContent {
                Circle()
                    .fill(T3Colors.accent)
                    .frame(width: 10, height: 10)
                    .offset(x: -2, y: 2)
                    .accessibilityHidden(true)
            }
        }
        .accessibilityLabel("Jump to latest")
        .accessibilityValue(hasNewContent ? "New activity" : "")
        .accessibilityIdentifier("thread-jump-to-latest")
    }
}

// MARK: - Connection

/// Under the bar while the thread's environment cannot be reached. Messages
/// sent meanwhile wait in the outbox with their own caption; this is the way
/// back.
struct ThreadConnectionBanner: View {
    let environmentName: String
    let onReconnect: () async -> Void

    @State private var isReconnecting = false

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: "wifi.slash")
                .foregroundStyle(T3Colors.warning)
                .accessibilityHidden(true)
            Text("\(environmentName) is offline")
                .font(T3Typography.supportingStrong)
                .foregroundStyle(T3Colors.textPrimary)
                .lineLimit(2)
                .frame(maxWidth: .infinity, alignment: .leading)
            Button {
                Task {
                    isReconnecting = true
                    await onReconnect()
                    isReconnecting = false
                }
            } label: {
                if isReconnecting {
                    ProgressView().accessibilityLabel("Reconnecting")
                } else {
                    Text("Reconnect")
                }
            }
            .t3SecondaryButtonStyle()
            .controlSize(.small)
            .disabled(isReconnecting)
        }
        .padding(.leading, 16)
        .padding(.trailing, 8)
        .padding(.vertical, 8)
        .frame(minHeight: T3Metrics.minimumTapTarget)
        .t3GlassEffect(in: RoundedRectangle(cornerRadius: 22, style: .continuous))
        .t3GlassRim(in: RoundedRectangle(cornerRadius: 22, style: .continuous))
        .padding(.horizontal, 16)
        .padding(.top, 8)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("thread-connection-banner")
    }
}

// MARK: - Archived

/// Stands in for the composer on an archived thread: the way back out, where
/// the reader would otherwise start typing.
struct ThreadArchivedBar: View {
    let onUnarchive: () async -> Void

    @State private var isWorking = false

    var body: some View {
        HStack(spacing: 12) {
            Label("This thread is archived", systemImage: "archivebox")
                .font(T3Typography.supporting)
                .foregroundStyle(T3Colors.textSecondary)
                .lineLimit(2)
                .frame(maxWidth: .infinity, alignment: .leading)
            Button {
                Task {
                    isWorking = true
                    await onUnarchive()
                    isWorking = false
                }
            } label: {
                if isWorking {
                    ProgressView().accessibilityLabel("Unarchiving")
                } else {
                    Text("Unarchive")
                }
            }
            .t3ProminentButtonStyle()
            .disabled(isWorking)
        }
        .padding(.leading, 18)
        .padding(.trailing, 8)
        .padding(.vertical, 8)
        .frame(minHeight: 56)
        .t3GlassEffect(in: Capsule())
        .t3GlassRim(in: Capsule())
        .padding(.horizontal, 16)
        .padding(.bottom, 8)
        .accessibilityIdentifier("thread-archived-bar")
    }
}

// MARK: - Message captions

/// The quiet line under a user bubble, like Messages' "Delivered": where its
/// delivery stands, or how it entered the run.
enum ThreadMessageCaption: Equatable, Sendable {
    case sending(uploading: Bool)
    case waitingForConnection
    case failed
    case intent(UserMessageIntentBadge)
    case scheduled

    /// The caption for a submission still in this device's outbox.
    static func outbox(_ delivery: FeatureOutboxDelivery, hasAttachments: Bool) -> ThreadMessageCaption {
        switch delivery {
        case .waiting: .waitingForConnection
        case .sending: .sending(uploading: hasAttachments)
        case .failed: .failed
        }
    }

    /// How a delivered message entered its run, read from the projected item.
    static func origin(of item: OrchestrationV2TurnItem) -> ThreadMessageCaption? {
        guard case let .userMessage(messageID, intent, _, _) = item.payload else { return nil }
        if ScheduledTaskMessageBadge.isScheduledTaskMessageID(messageID) { return .scheduled }
        return UserMessageIntentBadge.resolve(intent).map(ThreadMessageCaption.intent)
    }

    /// A delivery caption outranks the message's origin: until it is sent,
    /// how it will enter the run is not the question.
    var isDelivery: Bool {
        switch self {
        case .sending, .waitingForConnection, .failed: true
        case .intent, .scheduled: false
        }
    }

    var label: String {
        switch self {
        case let .sending(uploading): uploading ? "Uploading…" : "Sending…"
        case .waitingForConnection: "Waiting for connection"
        case .failed: "Not sent"
        case let .intent(badge): badge.label
        case .scheduled: "Scheduled task"
        }
    }

    var systemImage: String {
        switch self {
        case .sending: "arrow.up.circle"
        case .waitingForConnection: "wifi.slash"
        case .failed: "exclamationmark.circle"
        case let .intent(badge): badge.systemImage
        case .scheduled: "clock"
        }
    }

    var accessibilityLabel: String {
        switch self {
        case let .intent(badge): badge.accessibilityLabel
        default: label
        }
    }
}

struct ThreadMessageCaptionView: View {
    let caption: ThreadMessageCaption
    let onRetry: () -> Void

    var body: some View {
        if caption == .failed {
            Button(action: onRetry) {
                HStack(spacing: 4) {
                    Image(systemName: caption.systemImage)
                    Text("Not sent ·")
                    Text("Try Again").fontWeight(.semibold)
                }
                .font(T3Typography.supporting)
                .foregroundStyle(T3Colors.danger)
                .padding(.vertical, 6)
                .contentShape(Rectangle().inset(by: -8))
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Not sent")
            .accessibilityHint("Double tap to try sending again.")
            .accessibilityIdentifier("message-retry")
        } else {
            Label(caption.label, systemImage: caption.systemImage)
                .font(T3Typography.supporting)
                .foregroundStyle(T3Colors.textTertiary)
                .labelStyle(ThreadCaptionLabelStyle())
                .accessibilityLabel(caption.accessibilityLabel)
        }
    }
}

private struct ThreadCaptionLabelStyle: LabelStyle {
    func makeBody(configuration: Configuration) -> some View {
        HStack(spacing: 4) {
            configuration.icon
            configuration.title
        }
    }
}

/// A lineage action whose precondition went away between showing the button
/// and tapping it, typically because the run it would merge has changed.
enum ThreadLineageActionUnavailable: LocalizedError {
    case nothingToMerge

    var errorDescription: String? {
        switch self {
        case .nothingToMerge: "There's no finished run to merge back yet."
        }
    }
}

// MARK: - Dock

extension View {
    /// The composer dock. A bar on iOS 26, so the system's scroll edge effect
    /// runs under it; an inset before that, which lays out the same.
    func threadDock(@ViewBuilder _ dock: () -> some View) -> some View {
        modifier(ThreadDockModifier(dock: dock()))
    }
}

private struct ThreadDockModifier<Dock: View>: ViewModifier {
    let dock: Dock

    func body(content: Content) -> some View {
        if #available(iOS 26.0, *) {
            content.safeAreaBar(edge: .bottom, spacing: 0) { dock }
        } else {
            content.safeAreaInset(edge: .bottom, spacing: 0) { dock }
        }
    }
}

// MARK: - Queue

extension ThreadQueueWorkflowState {
    /// The head of the queue once nothing runs ahead of it and nothing holds
    /// it: the server is starting it, so its row locks instead of taking an
    /// edit that can no longer land.
    var dispatchingRunID: String? {
        guard activeRun == nil, !isHeld else { return nil }
        return queuedRuns.first?.run.id
    }
}
