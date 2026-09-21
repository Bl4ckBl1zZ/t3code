import SwiftUI

private enum TerminalFontSize {
    static let minimum = 6.0
    static let maximum = 14.0
    static let step = 0.5
    static let defaultValue = 10.5

    static func normalized(_ value: Double) -> Double {
        min(maximum, max(minimum, value))
    }
}

enum TerminalSessionList {
    static func initialID(in sessions: [FeatureTerminalSnapshot]) -> String {
        let running = sessions.filter { $0.state == .running || $0.state == .starting }
        return running.first(where: { $0.terminalID == "default" })?.terminalID
            ?? running.first?.terminalID
            ?? "default"
    }

    static func nextID(occupiedIDs: [String]) -> String {
        let occupied = Set(occupiedIDs)
        guard occupied.contains("default") else { return "default" }
        var index = 2
        while occupied.contains("term-\(index)") { index += 1 }
        return "term-\(index)"
    }

    static func fallbackID(
        in sessions: [FeatureTerminalSnapshot],
        excluding terminalID: String
    ) -> String? {
        sessions.first {
            $0.terminalID != terminalID && ($0.state == .running || $0.state == .starting)
        }?.terminalID
    }

    static func displayTitle(for session: FeatureTerminalSnapshot) -> String {
        let number: Int
        if session.terminalID == "default" {
            number = 1
        } else if session.terminalID.hasPrefix("term-"),
                  let parsed = Int(session.terminalID.dropFirst("term-".count)) {
            number = parsed
        } else {
            return session.title
        }

        let shell = session.title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !shell.isEmpty, shell.caseInsensitiveCompare("Terminal") != .orderedSame else {
            return "Terminal \(number)"
        }
        return "Terminal \(number) · \(shell)"
    }

    /// The navigation title: plain "Terminal" while there is only one session,
    /// the session's number once there are several to tell apart.
    static func navigationTitle(terminalID: String, sessionCount: Int) -> String {
        guard sessionCount > 1 else { return "Terminal" }
        if terminalID == "default" { return "Terminal 1" }
        return TerminalCloseConfirm.label(terminalID: terminalID)
    }
}

/// The thread's terminal. Pushed inside Thread Details and also presented as a
/// sheet root, so it carries no close button of its own: the session is the
/// title (its menu switches sessions), actions live in ⋯, and what happened to
/// the shell shows in a bar along the bottom.
public struct FeatureTerminalView: View {
    let client: any FeatureClient
    let threadID: String
    /// A command to run once, as soon as the terminal is open — how a project
    /// action from the details sheet gets somewhere its output is visible.
    ///
    /// Sent from here rather than by the caller because this view owns which
    /// terminal is active: `TerminalSessionList.initialID` may resolve to a
    /// running session other than `default`, and a caller writing to a guessed
    /// id would run the command in a terminal the reader never sees.
    let initialCommand: String?
    let initialTerminalID: String?

    @AppStorage("terminalFontSize") private var storedFontSize = TerminalFontSize.defaultValue
    @State private var terminal: FeatureTerminalSnapshot?
    @State private var sessions = [FeatureTerminalSnapshot]()
    @State private var activeTerminalID = "default"
    @State private var sessionsResolved = false
    @State private var columns = 80
    @State private var rows = 24
    @State private var focusRequest = 0
    @State private var surfaceGeneration = 0
    /// Bumped by Retry to open and attach again from scratch.
    @State private var attachGeneration = 0
    @State private var isLoading = true
    @State private var isOpening = false
    @State private var errorMessage: String?
    /// The environment has no terminals at all, so retrying cannot help.
    @State private var isUnsupported = false
    /// The attach stream ended and the view is attaching again.
    @State private var isReconnecting = false
    @State private var isTerminalFocused = false
    /// Stopping kills the process and drops the scrollback, and the menu offers
    /// it as one tap with no undo — same confirmation the web clients show.
    @State private var isConfirmingStop = false
    /// Set when the reader closed the session, so the bottom bar says so
    /// rather than reporting an exit.
    @State private var didCloseTerminal = false
    /// `initialCommand` is run once per presentation. Switching terminals
    /// re-runs `loadAndOpen`, and re-sending the command there would replay it
    /// into a terminal the reader deliberately switched to.
    @State private var didSendInitialCommand = false

    public init(client: any FeatureClient, threadID: String, initialCommand: String? = nil, initialTerminalID: String? = nil) {
        self.client = client
        self.threadID = threadID
        self.initialCommand = initialCommand
        self.initialTerminalID = initialTerminalID
    }

    public var body: some View {
        ZStack {
            T3Colors.background.ignoresSafeArea()

            GhosttyTerminalSurface(
                terminalKey: "\(threadID):\(activeTerminalID)",
                buffer: terminal?.buffer ?? "",
                outputCursor: terminal?.outputCursor,
                fontSize: CGFloat(fontSize),
                isRunning: isRunning,
                focusRequest: focusRequest,
                onInput: { data in
                    Task { await write(data) }
                },
                onResize: { nextColumns, nextRows in
                    updateGrid(columns: nextColumns, rows: nextRows)
                },
                onClear: {
                    Task { await clear() }
                },
                onFontSizeStep: { direction in
                    stepFontSize(direction)
                },
                onFocusChange: { isTerminalFocused = $0 }
            )
            .id("\(terminalTaskID):\(fontSize):\(surfaceGeneration)")
            .opacity(isReconnecting ? 0.55 : 1)

            if isLoading, terminal == nil {
                ProgressView("Opening terminal…")
            } else if let errorMessage, terminal == nil {
                unavailable(errorMessage)
            }
        }
        .safeAreaInset(edge: .bottom, spacing: 0) {
            bottomBar
        }
        .navigationTitle(
            TerminalSessionList.navigationTitle(
                terminalID: activeTerminalID,
                sessionCount: menuSessions.count
            )
        )
        .navigationBarTitleDisplayMode(.inline)
        .toolbarTitleMenu { sessionMenu }
        .modifier(TerminalStatusSubtitle(text: statusLine, isWarning: isReconnecting || errorMessage != nil))
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) { actionsMenu }
        }
        .t3NavigationChrome()
        // A history scroll is a vertical pan, which would otherwise drag the
        // sheet away while someone is working in the shell.
        .interactiveDismissDisabled(isTerminalFocused)
        .task {
            var attempt = 0
            while !Task.isCancelled {
                let attachedAt = ContinuousClock.now
                for await updates in client.terminalSessions(threadID: threadID) {
                    sessions = updates
                    if !sessionsResolved {
                        activeTerminalID = initialTerminalID ?? TerminalSessionList.initialID(in: updates)
                        sessionsResolved = true
                    }
                }
                sessionsResolved = true
                guard !Task.isCancelled else { return }
                // The session list ends the same way the attach does when the
                // environment reconnects; follow it onto the new connection.
                attempt = TerminalReattach.nextAttempt(after: attempt, attachedFor: attachedAt.duration(to: .now))
                try? await Task.sleep(for: TerminalReattach.delay(attempt: attempt))
            }
        }
        .task(id: terminalTaskID) {
            guard sessionsResolved else { return }
            await loadAndOpen()
            await sendInitialCommandIfNeeded()
        }
        .task(id: terminalTaskID) {
            guard sessionsResolved else { return }
            await followOutput(terminalID: activeTerminalID)
        }
        .confirmationDialog(
            TerminalCloseConfirm.title(label: activeTerminalLabel),
            isPresented: $isConfirmingStop,
            titleVisibility: .visible
        ) {
            Button(TerminalCloseConfirm.confirmActionTitle, role: .destructive) {
                Task { await stop() }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text(TerminalCloseConfirm.message)
        }
    }

    /// Streams the active terminal's output, attaching again whenever the
    /// stream ends while the terminal is still on screen.
    private func followOutput(terminalID: String) async {
        var attempt = 0
        while !Task.isCancelled {
            let attachedAt = ContinuousClock.now
            for await update in client.terminalEvents(threadID: threadID, terminalID: terminalID) {
                guard terminalID == activeTerminalID else { return }
                apply(update, terminalID: terminalID)
            }
            guard !Task.isCancelled, terminalID == activeTerminalID else { return }
            attempt = TerminalReattach.nextAttempt(after: attempt, attachedFor: attachedAt.duration(to: .now))
            switch TerminalReattach.decision(state: terminal?.state, attempt: attempt) {
            case .stay:
                isReconnecting = false
                return
            case let .reattach(delay):
                isReconnecting = true
                try? await Task.sleep(for: delay)
            }
        }
    }

    private func apply(_ update: FeatureTerminalSnapshot, terminalID: String) {
        isReconnecting = false
        let shouldSyncGrid = !isRunning
            && (update.state == .running || update.state == .starting)
        if let currentBuffer = terminal?.buffer,
           !update.buffer.hasPrefix(currentBuffer) {
            surfaceGeneration += 1
        }
        terminal = update
        if shouldSyncGrid {
            didCloseTerminal = false
            Task {
                try? await client.resizeTerminal(
                    threadID: threadID,
                    terminalID: terminalID,
                    columns: columns,
                    rows: rows
                )
            }
        }
        if update.state == .running {
            errorMessage = nil
        } else if update.state == .failed, let error = update.error {
            errorMessage = error
        }
    }

    // MARK: - Chrome

    /// The label the confirmation names, resolved the way the tab strip does:
    /// the session's own title when the server gave it one, else the id.
    private var activeTerminalLabel: String {
        TerminalCloseConfirm.label(
            terminalID: activeTerminalID,
            sessionTitle: sessions.first { $0.terminalID == activeTerminalID }?.title
                ?? terminal?.title
        )
    }

    @ViewBuilder
    private var sessionMenu: some View {
        Picker(
            "Terminal",
            selection: Binding(get: { activeTerminalID }, set: { selectTerminal($0) })
        ) {
            ForEach(menuSessions, id: \.terminalID) { session in
                Text(TerminalSessionList.displayTitle(for: session))
                    .tag(session.terminalID)
            }
        }
        .pickerStyle(.inline)

        Button {
            openNewTerminal()
        } label: {
            Label("New Terminal", systemImage: "plus")
        }
        .keyboardShortcut("t", modifiers: .command)
    }

    private var actionsMenu: some View {
        Menu {
            // iOS 26 shows the status as the title's subtitle.
            if #available(iOS 26, *) {} else {
                Section {
                    Label(statusLabel, systemImage: statusSymbol)
                    if let workingDirectory = terminal?.workingDirectory {
                        Text(workingDirectory)
                    }
                }
            }

            ControlGroup {
                Button {
                    stepFontSize(-1)
                } label: {
                    Label("Smaller", systemImage: "textformat.size.smaller")
                }
                .disabled(fontSize <= TerminalFontSize.minimum)
                .keyboardShortcut("-", modifiers: .command)

                Button {
                    stepFontSize(1)
                } label: {
                    Label("Larger", systemImage: "textformat.size.larger")
                }
                .disabled(fontSize >= TerminalFontSize.maximum)
                .keyboardShortcut("+", modifiers: .command)
            } label: {
                Label("Text Size · \(formattedFontSize(fontSize)) pt", systemImage: "textformat.size")
            }

            Button {
                Task { await clear() }
            } label: {
                Label("Clear", systemImage: "eraser")
            }
            .disabled(terminal == nil)
            .keyboardShortcut("k", modifiers: .command)

            Section {
                if isRunning {
                    Button(role: .destructive) {
                        isConfirmingStop = true
                    } label: {
                        Label("Close Terminal…", systemImage: "xmark.circle")
                    }
                } else {
                    Button {
                        Task { await open() }
                    } label: {
                        Label(terminal?.state == .exited ? "Restart Terminal" : "Start Terminal", systemImage: "play")
                    }
                    .disabled(isLoading || isOpening)
                }
            }
        } label: {
            Label("Terminal Options", systemImage: "ellipsis")
        }
    }

    private func unavailable(_ message: String) -> some View {
        ContentUnavailableView {
            Label("Terminal Unavailable", systemImage: "terminal")
        } description: {
            Text(message)
        } actions: {
            if !isUnsupported {
                Button("Try Again", action: retry)
                    .t3SecondaryButtonStyle()
            }
        }
    }

    /// What happened to the shell, and the next step: an error or a lost
    /// connection with Retry, or an exit with Restart.
    @ViewBuilder
    private var bottomBar: some View {
        if let errorMessage, terminal != nil {
            TerminalStatusBar(
                systemImage: "exclamationmark.triangle.fill",
                tint: T3Colors.danger,
                title: "Terminal error",
                message: errorMessage
            ) {
                Button("Retry", action: retry)
                    .t3SecondaryButtonStyle()
            }
        } else if isReconnecting {
            TerminalStatusBar(
                systemImage: "wifi.exclamationmark",
                tint: T3Colors.warning,
                title: "Connection lost",
                message: "Output resumes when it reconnects."
            ) {
                Button("Retry", action: retry)
                    .t3SecondaryButtonStyle()
            }
        } else if let terminal, !isRunning, !isLoading {
            TerminalStatusBar(
                systemImage: "xmark.circle",
                tint: T3Colors.textSecondary,
                title: stoppedTitle(terminal),
                message: nil
            ) {
                Button {
                    Task { await open() }
                } label: {
                    Label(terminal.state == .stopped && !didCloseTerminal ? "Start" : "Restart", systemImage: "arrow.clockwise")
                }
                .t3ProminentButtonStyle()
                .disabled(isOpening)
            }
        }
    }

    private func stoppedTitle(_ terminal: FeatureTerminalSnapshot) -> String {
        if didCloseTerminal { return "Terminal closed" }
        switch terminal.state {
        case .exited: return "Process exited"
        case .failed: return "Terminal stopped"
        default: return "Not started"
        }
    }

    /// The subtitle under the session name on iOS 26.
    private var statusLine: String {
        if isReconnecting { return "Reconnecting…" }
        if errorMessage != nil, terminal != nil { return "Error" }
        guard let terminal else { return isLoading ? "Starting…" : "" }
        switch terminal.state {
        case .starting:
            return "Starting…"
        case .running:
            let place = terminal.workingDirectory.map(Self.abbreviatedPath)
            if terminal.hasRunningSubprocess {
                return ["Running", place].compactMap { $0 }.joined(separator: " · ")
            }
            let shell = terminal.title.trimmingCharacters(in: .whitespacesAndNewlines)
            let name = shell.isEmpty || shell.caseInsensitiveCompare("Terminal") == .orderedSame ? nil : shell
            return [name, place].compactMap { $0 }.joined(separator: " · ")
        case .exited:
            return terminal.exitCode.map { "Exited · code \($0)" } ?? "Exited"
        case .failed:
            return "Error"
        case .stopped:
            return didCloseTerminal ? "Closed" : "Not started"
        }
    }

    /// `/Users/me/code/t3` → `~/code/t3`; the full path stays in the menu.
    private static func abbreviatedPath(_ path: String) -> String {
        let components = path.split(separator: "/", omittingEmptySubsequences: true)
        if components.count >= 2, components[0] == "Users" || components[0] == "home" {
            return (["~"] + components.dropFirst(2).map(String.init)).joined(separator: "/")
        }
        return path
    }

    private var fontSize: Double {
        TerminalFontSize.normalized(storedFontSize)
    }

    private var terminalTaskID: String {
        "\(sessionsResolved):\(activeTerminalID):\(attachGeneration)"
    }

    private var menuSessions: [FeatureTerminalSnapshot] {
        var visible = sessions.filter {
            $0.state == .running || $0.state == .starting || $0.terminalID == activeTerminalID
        }
        if let terminal,
           !visible.contains(where: { $0.terminalID == terminal.terminalID }) {
            visible.append(terminal)
        }
        return visible.sorted {
            $0.terminalID.localizedStandardCompare($1.terminalID) == .orderedAscending
        }
    }

    private var isRunning: Bool {
        terminal?.state == .running || terminal?.state == .starting
    }

    private var statusLabel: String {
        switch terminal?.state {
        case .running: terminal?.hasRunningSubprocess == true ? "Task running" : "Ready"
        case .starting: "Starting"
        case .failed: "Error"
        case .exited: "Exited"
        case .stopped, nil: "Not started"
        }
    }

    private var statusSymbol: String {
        switch terminal?.state {
        case .running: "checkmark.circle.fill"
        case .starting: "clock.fill"
        case .failed: "exclamationmark.triangle.fill"
        case .exited: "xmark.circle.fill"
        case .stopped, nil: "circle"
        }
    }

    private func formattedFontSize(_ value: Double) -> String {
        String(format: "%.1f", TerminalFontSize.normalized(value))
    }

    // MARK: - Actions

    private func stepFontSize(_ direction: Int) {
        storedFontSize = TerminalFontSize.normalized(
            fontSize + Double(direction) * TerminalFontSize.step
        )
    }

    private func selectTerminal(_ terminalID: String) {
        guard terminalID != activeTerminalID else { return }
        PlatformHapticEngine.shared.playSelection()
        terminal = nil
        errorMessage = nil
        isReconnecting = false
        didCloseTerminal = false
        activeTerminalID = terminalID
    }

    private func openNewTerminal() {
        let nextID = TerminalSessionList.nextID(
            occupiedIDs: sessions.map(\.terminalID) + [activeTerminalID]
        )
        terminal = nil
        errorMessage = nil
        isReconnecting = false
        didCloseTerminal = false
        activeTerminalID = nextID
    }

    /// Opens and attaches again from scratch.
    private func retry() {
        errorMessage = nil
        isUnsupported = false
        isReconnecting = false
        attachGeneration += 1
    }

    /// A failed resize is retried by the next layout pass, so it is not worth
    /// interrupting anyone over.
    private func updateGrid(columns nextColumns: Int, rows nextRows: Int) {
        guard nextColumns != columns || nextRows != rows else { return }
        columns = nextColumns
        rows = nextRows
        guard isRunning else { return }
        Task {
            try? await client.resizeTerminal(
                threadID: threadID,
                terminalID: activeTerminalID,
                columns: nextColumns,
                rows: nextRows
            )
        }
    }

    private func loadAndOpen() async {
        let terminalID = activeTerminalID
        isLoading = true
        defer { isLoading = false }
        do {
            let snapshot = try await client.terminalSnapshot(
                threadID: threadID,
                terminalID: terminalID
            )
            guard terminalID == activeTerminalID else { return }
            terminal = snapshot
            if snapshot.state == .stopped || snapshot.state == .exited {
                try await openTerminal(terminalID: terminalID)
            }
            errorMessage = nil
        } catch {
            isUnsupported = error is FeatureCapabilityUnavailable
            errorMessage = error.localizedDescription
        }
    }

    /// Types the caller's command into the resolved terminal, once.
    ///
    /// Skipped when the terminal never came up: writing into a failed session
    /// would report a write error over the open error that actually explains
    /// what went wrong.
    private func sendInitialCommandIfNeeded() async {
        guard !didSendInitialCommand,
              let initialCommand,
              !initialCommand.isEmpty,
              terminal != nil else { return }
        didSendInitialCommand = true
        await write("\(initialCommand)\r")
    }

    private func open() async {
        guard !isOpening else { return }
        isOpening = true
        defer { isOpening = false }
        do {
            try await openTerminal(terminalID: activeTerminalID)
            didCloseTerminal = false
            focusRequest += 1
            errorMessage = nil
        } catch {
            PlatformHapticEngine.shared.play(.error)
            errorMessage = "The terminal couldn't start. \(error.localizedDescription)"
        }
    }

    private func openTerminal(terminalID: String) async throws {
        try await client.openTerminal(
            threadID: threadID,
            terminalID: terminalID,
            columns: columns,
            rows: rows
        )
        guard terminalID == activeTerminalID else { return }
        terminal = try await client.terminalSnapshot(
            threadID: threadID,
            terminalID: terminalID
        )
    }

    private func stop() async {
        let terminalID = activeTerminalID
        let fallbackID = TerminalSessionList.fallbackID(
            in: sessions,
            excluding: terminalID
        )
        do {
            try await client.closeTerminal(threadID: threadID, terminalID: terminalID)
            PlatformHapticEngine.shared.play(.success)
            if let fallbackID {
                selectTerminal(fallbackID)
            } else {
                didCloseTerminal = true
                terminal = try? await client.terminalSnapshot(
                    threadID: threadID,
                    terminalID: terminalID
                )
            }
            errorMessage = nil
        } catch {
            PlatformHapticEngine.shared.play(.error)
            errorMessage = "The terminal couldn't be closed. \(error.localizedDescription)"
        }
    }

    private func clear() async {
        do {
            terminal?.buffer = ""
            surfaceGeneration += 1
            try await client.clearTerminal(
                threadID: threadID,
                terminalID: activeTerminalID
            )
            if isRunning {
                try await client.writeTerminal(
                    threadID: threadID,
                    terminalID: activeTerminalID,
                    data: "\u{0C}"
                )
            }
            errorMessage = nil
        } catch {
            PlatformHapticEngine.shared.play(.error)
            errorMessage = "The terminal couldn't be cleared. \(error.localizedDescription)"
        }
    }

    private func write(_ data: String) async {
        do {
            try await client.writeTerminal(
                threadID: threadID,
                terminalID: activeTerminalID,
                data: data
            )
        } catch {
            PlatformHapticEngine.shared.play(.error)
            errorMessage = "Input didn't reach the terminal. \(error.localizedDescription)"
        }
    }
}

/// The session's status as the navigation subtitle, on systems that have one.
/// Earlier systems keep the title menu instead and list the status in ⋯.
private struct TerminalStatusSubtitle: ViewModifier {
    let text: String
    let isWarning: Bool

    func body(content: Content) -> some View {
        if #available(iOS 26, *), !text.isEmpty {
            content.navigationSubtitle(
                Text(text).foregroundStyle(isWarning ? T3Colors.warning : T3Colors.textSecondary)
            )
        } else {
            content
        }
    }
}

/// A glass bar along the bottom of the terminal: what happened, and one action.
private struct TerminalStatusBar<Action: View>: View {
    let systemImage: String
    let tint: Color
    let title: String
    let message: String?
    @ViewBuilder let action: Action

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: systemImage)
                .font(.title3)
                .foregroundStyle(tint)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(T3Colors.textPrimary)
                if let message {
                    Text(message)
                        .font(.footnote)
                        .foregroundStyle(T3Colors.textSecondary)
                        .lineLimit(3)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            action
        }
        .padding(.leading, 18)
        .padding(.trailing, 10)
        .padding(.vertical, 10)
        .frame(minHeight: 56)
        .t3GlassEffect(in: RoundedRectangle(cornerRadius: 28, style: .continuous))
        .t3GlassRim(in: RoundedRectangle(cornerRadius: 28, style: .continuous))
        .padding(.horizontal, 12)
        .padding(.bottom, 8)
        .accessibilityElement(children: .contain)
    }
}
