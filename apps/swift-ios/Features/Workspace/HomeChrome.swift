import SwiftUI

// The Home shell's decisions, kept apart from the views that draw them so each
// one is testable without a TabView or a collection view: which tab is showing,
// what the connection banner says, what the subtitle counts, what an empty list
// offers, and how row dates read.

// MARK: - Tabs

/// A Home tab. The three workspaces are real destinations; `.new` never is.
/// Selecting it presents the composer for the tab the user came from and the
/// selection snaps back, so compose sits where the thumb is without becoming a
/// page of its own.
enum HomeTab: Hashable {
    case workspace(MobileWorkspace)
    case new
}

extension MobileWorkspace {
    /// The tab bar symbol.
    var tabSymbol: String {
        switch self {
        case .code: "terminal"
        case .work: "tray"
        case .chat: "bubble.left.and.bubble.right"
        }
    }

    /// Code starts tasks against a project; Work and Chat start Hermes
    /// conversations. Every "new …" label and empty state follows this noun.
    var itemNoun: String {
        self == .code ? "Task" : "Conversation"
    }

    var newItemTitle: String { "New \(itemNoun)" }

    var searchPrompt: String {
        switch self {
        case .code: "Search tasks"
        case .work: "Search work"
        case .chat: "Search conversations"
        }
    }
}

// MARK: - Tab bar

/// Whether a Home tab draws the tab bar.
///
/// A collapsed split view keeps both of its columns alive, so a list and a
/// thread each answering on their own raced: the thread's hidden bar outlived
/// the pop back, and answering that with a list that always asked for the bar
/// left it sitting over the composer. One answer per tab settles it.
enum HomeTabBar {
    /// `showsThread` is the tab's own detail column standing in front of its
    /// list, which only happens at compact width.
    static func visibility(isCompact: Bool, showsThread: Bool, isSelecting: Bool) -> Visibility {
        // Batch selection puts its own actions along the bottom, and the
        // composer owns the bottom of a thread on iPhone.
        if isSelecting || (isCompact && showsThread) { return .hidden }
        // Named rather than `.automatic`, which leaves a hidden bar hidden.
        return isCompact ? .visible : .automatic
    }
}

// MARK: - Connection banner

/// The connection problem a Home list leads with.
///
/// The tabs never give way to connection status: one sleeping laptop used to
/// take the whole switcher with it. The problem is a row at the top of the
/// list instead, and the account button's dot repeats it once that row has
/// scrolled away.
struct HomeConnectionBanner: Hashable {
    enum Tone: Hashable {
        /// An environment is unreachable; rows from it show last known state.
        case error
        /// Connecting or reconnecting. Static: no spinner, no shimmer.
        case warning
    }

    let tone: Tone
    let title: String
    let message: String
    /// Whether the row offers Reconnect. Waiting states have nothing to press.
    let offersReconnect: Bool
    /// Several environments are down: tapping the row opens Settings, where
    /// each one can be reconnected or removed on its own.
    var opensConnections = false

    /// `isReconnecting` is the user's own Reconnect in flight, which turns the
    /// error into a wait instead of leaving a button that looks ignored.
    static func resolve(snapshot: FeatureSnapshot, isReconnecting: Bool) -> HomeConnectionBanner? {
        let unreachable = snapshot.environments.filter { $0.connectionState == .disconnected }
        if let first = unreachable.first {
            if unreachable.count > 1 {
                return HomeConnectionBanner(
                    tone: .error,
                    title: "\(unreachable.count) environments unreachable",
                    message: "Showing last known state. Tap to manage connections.",
                    offersReconnect: false,
                    opensConnections: true
                )
            }
            if isReconnecting {
                return HomeConnectionBanner(
                    tone: .warning,
                    title: "Reconnecting to \(first.name)…",
                    message: "Showing last known state.",
                    offersReconnect: false
                )
            }
            return HomeConnectionBanner(
                tone: .error,
                title: "\(first.name) unreachable",
                message: "Showing last known state.",
                offersReconnect: true
            )
        }
        if let waiting = snapshot.environments.first(where: {
            $0.connectionState == .connecting || $0.connectionState == .reconnecting
        }) {
            return waitingBanner(
                name: waiting.name,
                isFirstConnect: waiting.connectionState == .connecting
            )
        }
        switch snapshot.connection.state {
        case .reconnecting:
            return waitingBanner(name: environmentName(in: snapshot), isFirstConnect: false)
        case .disconnected:
            let name = environmentName(in: snapshot)
            if isReconnecting {
                return HomeConnectionBanner(
                    tone: .warning,
                    title: "Reconnecting to \(name)…",
                    message: "Showing last known state.",
                    offersReconnect: false
                )
            }
            return HomeConnectionBanner(
                tone: .error,
                title: "\(name) unreachable",
                message: "Showing last known state.",
                offersReconnect: true
            )
        // A first connect reads as the list's subtitle (or its placeholder
        // rows), not as a problem.
        case .connecting, .connected:
            return nil
        }
    }

    /// The name the active connection answers to.
    static func environmentName(in snapshot: FeatureSnapshot) -> String {
        snapshot.connection.environmentName
            ?? snapshot.environments.first(where: \.isActive)?.name
            ?? snapshot.environments.first?.name
            ?? "Server"
    }

    private static func waitingBanner(name: String, isFirstConnect: Bool) -> HomeConnectionBanner {
        HomeConnectionBanner(
            tone: .warning,
            title: isFirstConnect ? "Connecting to \(name)…" : "Reconnecting to \(name)…",
            message: "Changes you make are queued.",
            offersReconnect: false
        )
    }
}

// MARK: - Subtitle

enum HomeListSubtitle {
    /// "All projects · 3 working · 1 needs you". `threads` are the list's
    /// pinned and active rows; parked shelves are not what anyone is waiting on.
    /// Nil when there is nothing worth a line.
    static func text(
        workspace: MobileWorkspace,
        projectName: String?,
        threads: [FeatureThread],
        connection: FeatureConnection,
        environmentName: String
    ) -> String? {
        if connection.state == .connecting {
            return "Connecting to \(environmentName)…"
        }
        var parts: [String] = []
        if WorkspaceSwitcher.showsProjectFilter(workspace) {
            parts.append(projectName ?? "All projects")
        }
        let working = threads.filter { $0.homeStatus == .working }.count
        if working > 0 {
            parts.append("\(working) working")
        }
        let needsYou = threads.filter { $0.homeStatus == .approval || $0.homeStatus == .input }.count
        if needsYou > 0 {
            parts.append(needsYou == 1 ? "1 needs you" : "\(needsYou) need you")
        }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }
}

// MARK: - Loading and empty states

enum HomeLoadingState {
    /// Placeholder rows stand in for the list until something real arrives.
    ///
    /// Only an empty snapshot qualifies: a cached list, or a connected server
    /// that genuinely has no threads, is shown as itself. Without this a cold
    /// connect claimed "No active tasks" before the first snapshot landed.
    static func showsPlaceholders(isLoading: Bool, snapshot: FeatureSnapshot) -> Bool {
        guard snapshot.threads.isEmpty, snapshot.projects.isEmpty else { return false }
        return isLoading
            || snapshot.connection.state == .connecting
            || snapshot.connection.state == .reconnecting
    }
}

/// What an empty Home list says, and the one next step it offers.
struct HomeEmptyState: Hashable {
    enum Action: Hashable {
        case addProject
        case newItem
        case showAllProjects
        case setUpHermes
    }

    let title: String
    let systemImage: String
    let message: String
    let actionTitle: String
    let action: Action

    static func resolve(
        workspace: MobileWorkspace,
        hasCreationProjects: Bool,
        filteredProjectName: String?,
        hermesReady: Bool
    ) -> HomeEmptyState {
        switch workspace {
        case .code:
            if !hasCreationProjects {
                return HomeEmptyState(
                    title: "No Projects Yet",
                    systemImage: "folder.badge.plus",
                    message: "Add a folder or clone a repository to start your first task.",
                    actionTitle: "Add Project",
                    action: .addProject
                )
            }
            if let filteredProjectName {
                return HomeEmptyState(
                    title: "No Tasks in \(filteredProjectName)",
                    systemImage: "tray",
                    message: "Start a task here, or show every project.",
                    actionTitle: "Show All Projects",
                    action: .showAllProjects
                )
            }
            return HomeEmptyState(
                title: "No Tasks",
                systemImage: "square.and.pencil",
                message: "Start a task in one of your projects.",
                actionTitle: "New Task",
                action: .newItem
            )
        case .work, .chat:
            let title = workspace == .work ? "No Work Yet" : "No Conversations"
            if !hermesReady {
                return HomeEmptyState(
                    title: title,
                    systemImage: workspace.tabSymbol,
                    message: WorkspaceSwitcher.hermesUnavailableMessage,
                    actionTitle: "Set Up Hermes",
                    action: .setUpHermes
                )
            }
            return HomeEmptyState(
                title: title,
                systemImage: workspace.tabSymbol,
                message: workspace == .work
                    ? "Hand Hermes something to work on."
                    : "Start a conversation with Hermes.",
                actionTitle: "New Conversation",
                action: .newItem
            )
        }
    }
}

// MARK: - Row text

enum HomeRowDate {
    /// When a snoozed thread wakes: "6:00 PM" today, "Mon 9:00 AM" within the
    /// week, "Sep 30" beyond it.
    static func wake(_ date: Date, now: Date, calendar: Calendar = .current) -> String {
        if calendar.isDate(date, inSameDayAs: now) {
            return time(date, calendar: calendar)
        }
        let days = calendar.dateComponents(
            [.day],
            from: calendar.startOfDay(for: now),
            to: calendar.startOfDay(for: date)
        ).day ?? 0
        if days > 0, days < 7 {
            return "\(weekday(date, calendar: calendar)) \(time(date, calendar: calendar))"
        }
        return shortDate(date, calendar: calendar)
    }

    /// Messages-style: the time today, "Yesterday", the weekday within the
    /// last week, a short date beyond it.
    static func conversation(_ date: Date, now: Date, calendar: Calendar = .current) -> String {
        if calendar.isDate(date, inSameDayAs: now) {
            return time(date, calendar: calendar)
        }
        let days = calendar.dateComponents(
            [.day],
            from: calendar.startOfDay(for: date),
            to: calendar.startOfDay(for: now)
        ).day ?? 0
        if days == 1 { return "Yesterday" }
        if days > 1, days < 7 {
            return date.formatted(style(calendar: calendar).weekday(.wide))
        }
        return shortDate(date, calendar: calendar)
    }

    private static func style(calendar: Calendar) -> Date.FormatStyle {
        Date.FormatStyle(locale: calendar.locale ?? .autoupdatingCurrent, calendar: calendar, timeZone: calendar.timeZone)
    }

    private static func time(_ date: Date, calendar: Calendar) -> String {
        date.formatted(style(calendar: calendar).hour().minute())
    }

    private static func weekday(_ date: Date, calendar: Calendar) -> String {
        date.formatted(style(calendar: calendar).weekday(.abbreviated))
    }

    private static func shortDate(_ date: Date, calendar: Calendar) -> String {
        date.formatted(style(calendar: calendar).month(.abbreviated).day())
    }
}

enum HomeBranchLabel {
    /// The branch a Code row names. A t3-generated worktree branch
    /// ("t3code/9f2c41aa") says nothing a person would recognise, so it reads
    /// as "Worktree".
    static func display(branch: String?, worktreePath: String?) -> String {
        if let branch = branch?.trimmingCharacters(in: .whitespacesAndNewlines), !branch.isEmpty {
            return isGenerated(branch) ? "Worktree" : branch
        }
        if let worktreePath = worktreePath?.trimmingCharacters(in: .whitespacesAndNewlines),
           !worktreePath.isEmpty {
            let name = URL(fileURLWithPath: worktreePath).lastPathComponent
            return isHexSuffix(name) ? "Worktree" : name
        }
        return "workspace"
    }

    /// `<prefix>/<8 hex digits>`, the shape the server names worktrees with.
    static func isGenerated(_ branch: String) -> Bool {
        let parts = branch.split(separator: "/", omittingEmptySubsequences: false)
        guard parts.count == 2, !parts[0].isEmpty else { return false }
        return isHexSuffix(parts[1])
    }

    private static func isHexSuffix(_ value: some StringProtocol) -> Bool {
        value.count == 8 && value.allSatisfy { $0.isHexDigit && !$0.isUppercase }
    }
}

// MARK: - Views

/// The leading "T3" account button: opens Settings, and carries a dot while an
/// environment is unreachable (red) or reconnecting (amber).
struct HomeAccountButton: View {
    let status: HomeConnectionBanner.Tone?
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Text("T3")
                .font(.headline.weight(.heavy))
                .foregroundStyle(T3Colors.textPrimary)
                .overlay(alignment: .topTrailing) {
                    if let status {
                        Circle()
                            .fill(status == .error ? T3Colors.danger : T3Colors.warning)
                            .frame(width: 8, height: 8)
                            .offset(x: 6, y: -3)
                    }
                }
        }
        .accessibilityLabel("Settings")
        .accessibilityValue(accessibilityValue)
        .accessibilityIdentifier("sidebar-settings-button")
    }

    private var accessibilityValue: String {
        switch status {
        case .error: "An environment is unreachable"
        case .warning: "Reconnecting"
        case nil: ""
        }
    }
}

/// The inline connection row at the top of a Home list.
struct HomeConnectionBannerRow: View {
    let banner: HomeConnectionBanner
    let onReconnect: () -> Void

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: banner.tone == .error ? "wifi.slash" : "wifi")
                .font(.body.weight(.semibold))
                .foregroundStyle(tint)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(banner.title)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(T3Colors.textPrimary)
                Text(banner.message)
                    .font(.footnote)
                    .foregroundStyle(T3Colors.textSecondary)
            }
            .accessibilityElement(children: .combine)
            Spacer(minLength: 8)
            if banner.offersReconnect {
                Button("Reconnect", action: onReconnect)
                    .buttonStyle(.bordered)
                    .controlSize(.small)
                    .tint(tint)
            } else if banner.opensConnections {
                Image(systemName: "chevron.right")
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(T3Colors.textTertiary)
                    .accessibilityHidden(true)
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .frame(minHeight: T3Metrics.minimumTapTarget)
        .background(tint.opacity(0.12), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .padding(.horizontal, 12)
        .padding(.vertical, 4)
    }

    private var tint: Color {
        banner.tone == .error ? T3Colors.danger : T3Colors.warning
    }
}

/// A static stand-in for a Code row while the first snapshot is on its way.
/// Redacted, never animated: waiting states don't shimmer.
struct HomePlaceholderRow: View {
    let index: Int

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text("Project name")
                Spacer()
                Text("2h")
            }
            .font(T3Typography.homeMetadata)
            Text(index.isMultiple(of: 2) ? "A thread title that is loading" : "Another thread title")
                .font(T3Typography.homeTitle)
            Text("feature/branch-name")
                .font(T3Typography.homeMetadata)
        }
        .foregroundStyle(T3Colors.textTertiary)
        .redacted(reason: .placeholder)
        .padding(.horizontal, 18)
        .padding(.vertical, 12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityHidden(true)
    }
}

/// Which batch actions a Home selection offers. Each one is enabled when it
/// applies to at least one selected thread; the others are skipped and stay
/// selected.
struct HomeBatchAvailability: Equatable {
    var canSnooze = false
    var canSettle = false
    var canArchive = false
    var canPin = false
    var canUnpin = false

    /// Same rule as the row menu's Snooze: never hide a row that is asking for
    /// something, and never offer what the server would refuse.
    static func canSnooze(_ thread: FeatureThread, in workspace: MobileWorkspace) -> Bool {
        workspace != .chat
            && !thread.isArchived
            && thread.canShelveSnoozed
            && thread.state != .queued
            && thread.state != .waitingForApproval
            && thread.state != .waitingForInput
    }

    static func canSettle(
        _ thread: FeatureThread,
        in workspace: MobileWorkspace,
        now: Date,
        changeRequest: FeaturePullRequest?
    ) -> Bool {
        workspace != .chat
            && !thread.isArchived
            && thread.canShelveSettled
            && !thread.isEffectivelySettled(at: now, changeRequest: changeRequest)
    }

    static func resolve(
        _ threads: [FeatureThread],
        workspace: MobileWorkspace,
        now: Date,
        changeRequests: [String: FeaturePullRequest]
    ) -> HomeBatchAvailability {
        var result = HomeBatchAvailability()
        for thread in threads {
            if canSnooze(thread, in: workspace) { result.canSnooze = true }
            if canSettle(thread, in: workspace, now: now, changeRequest: changeRequests[thread.id]) {
                result.canSettle = true
            }
            if !thread.isArchived, thread.canArchive { result.canArchive = true }
            if thread.pinnedAt == nil { result.canPin = true } else { result.canUnpin = true }
        }
        return result
    }
}
