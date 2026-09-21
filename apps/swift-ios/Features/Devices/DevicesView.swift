import SwiftUI

public struct DevicesView: View {
    private let manager: any FeatureDeviceManaging

    @State private var sessions: [FeatureDeviceSession] = []
    @State private var isLoading = true
    @State private var revokingIDs = Set<String>()
    @State private var errorMessage: String?
    @State private var revokeTarget: FeatureDeviceSession?
    @State private var showingRevokeOthers = false

    public init(manager: any FeatureDeviceManaging) {
        self.manager = manager
    }

    public var body: some View {
        Group {
            if isLoading, sessions.isEmpty {
                ProgressView("Loading Devices…")
                    .foregroundStyle(T3Colors.textSecondary)
            } else if let errorMessage, sessions.isEmpty {
                if DeviceManagementErrorCopy.isPermissionDenied(errorMessage) {
                    ContentUnavailableView {
                        Label("No Access to Devices", systemImage: "lock")
                    } description: {
                        Text(errorMessage)
                    }
                } else {
                    ContentUnavailableView {
                        Label("Couldn’t Load Devices", systemImage: "exclamationmark.circle")
                    } description: {
                        Text(errorMessage)
                    } actions: {
                        Button("Try Again") {
                            Task { await reload() }
                        }
                        .t3ProminentButtonStyle()
                    }
                }
            } else if sessions.isEmpty {
                ContentUnavailableView {
                    Label("No Devices Found", systemImage: "laptopcomputer.and.iphone")
                } description: {
                    Text("Device sessions will appear here when this server supports access management.")
                }
            } else {
                deviceList
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(T3Colors.background)
        .navigationTitle("Devices")
        .navigationBarTitleDisplayMode(.large)
        .t3NavigationChrome()
        .toolbar {
            if !otherSessions.isEmpty {
                ToolbarItem(placement: .primaryAction) {
                    Menu {
                        Button(role: .destructive) {
                            showingRevokeOthers = true
                        } label: {
                            Label("Remove All Other Devices", systemImage: "rectangle.stack.badge.minus")
                        }
                    } label: {
                        Label("Device Actions", systemImage: Self.menuSymbol)
                    }
                    .disabled(!revokingIDs.isEmpty)
                    .confirmationDialog(
                        "Remove all other devices?",
                        isPresented: $showingRevokeOthers,
                        titleVisibility: .visible
                    ) {
                        Button("Remove \(otherSessions.count) Devices", role: .destructive) {
                            Task { await revokeOthers() }
                        }
                        Button("Cancel", role: .cancel) {}
                    } message: {
                        Text("Every other phone, tablet, browser, and desktop will be signed out.")
                    }
                }
            }
        }
        .task {
            await reload()
        }
    }

    private var deviceList: some View {
        List {
            if let errorMessage {
                Section {
                    ConnectionProblemRow(
                        title: "Couldn’t Update Devices",
                        message: errorMessage,
                        systemImage: "exclamationmark.triangle.fill"
                    )
                    Button("Try Again") {
                        Task { await reload() }
                    }
                    .tint(T3Colors.accent)
                    .disabled(isLoading)
                }
                .t3GroupedRow()
            }

            if let currentSession {
                Section("This Device") {
                    DeviceSessionRow(session: currentSession, isRevoking: false)
                }
                .t3GroupedRow()
            }

            if !otherSessions.isEmpty {
                Section {
                    ForEach(otherSessions) { session in
                        DeviceSessionRow(session: session, isRevoking: revokingIDs.contains(session.id))
                            .contentShape(Rectangle())
                            .swipeActions {
                                Button("Remove", role: .destructive) {
                                    revokeTarget = session
                                }
                            }
                            .contextMenu {
                                Button(role: .destructive) {
                                    revokeTarget = session
                                } label: {
                                    Label("Remove Access", systemImage: "trash")
                                }
                            }
                            .confirmationDialog(
                                "Remove “\(session.displayName)”?",
                                isPresented: Binding(
                                    get: { revokeTarget?.id == session.id },
                                    set: { if !$0 { revokeTarget = nil } }
                                ),
                                titleVisibility: .visible
                            ) {
                                Button("Remove Access", role: .destructive) {
                                    Task { await revoke(session) }
                                }
                                Button("Cancel", role: .cancel) {}
                            } message: {
                                Text("It will need a new pairing code to reconnect.")
                            }
                    }
                } header: {
                    Text("Other Devices")
                } footer: {
                    Text("Swipe or touch and hold a device to remove its access.")
                }
                .t3GroupedRow()
            }
        }
        .listStyle(.insetGrouped)
        .t3GroupedListBackground()
        .refreshable {
            await reload()
        }
    }

    /// iOS 26 glass toolbars use the bare ellipsis; the circled one belongs to
    /// the older opaque bars.
    private static var menuSymbol: String {
        if #available(iOS 26, *) { "ellipsis" } else { "ellipsis.circle" }
    }

    private var currentSession: FeatureDeviceSession? {
        sessions.first(where: \.isCurrent)
    }

    private var otherSessions: [FeatureDeviceSession] {
        sessions.filter { !$0.isCurrent }
    }

    @MainActor
    private func reload() async {
        isLoading = true
        defer { isLoading = false }
        do {
            sessions = FeatureDeviceSession.sortedForDisplay(
                try await manager.loadDeviceSessions()
            )
            errorMessage = nil
        } catch {
            errorMessage = DeviceManagementErrorCopy.message(for: error)
        }
    }

    @MainActor
    private func revoke(_ session: FeatureDeviceSession) async {
        revokingIDs.insert(session.id)
        revokeTarget = nil
        defer { revokingIDs.remove(session.id) }
        do {
            try await manager.revokeDeviceSession(id: session.id)
            sessions.removeAll { $0.id == session.id }
            errorMessage = nil
        } catch {
            errorMessage = DeviceManagementErrorCopy.message(for: error)
        }
    }

    @MainActor
    private func revokeOthers() async {
        let others = Set(otherSessions.map(\.id))
        revokingIDs.formUnion(others)
        defer { revokingIDs.subtract(others) }
        do {
            try await manager.revokeOtherDeviceSessions()
            sessions.removeAll { !$0.isCurrent }
            errorMessage = nil
        } catch {
            errorMessage = DeviceManagementErrorCopy.message(for: error)
        }
    }
}

private struct DeviceSessionRow: View {
    let session: FeatureDeviceSession
    let isRevoking: Bool

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: session.deviceType.systemImage)
                .font(.title3)
                .foregroundStyle(T3Colors.textSecondary)
                .frame(width: 28)

            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 8) {
                    Text(session.displayName)
                        .foregroundStyle(T3Colors.textPrimary)
                    if session.isCurrent {
                        Text("This Device")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(T3Colors.success)
                            .padding(.horizontal, 7)
                            .padding(.vertical, 2)
                            .background(T3Colors.success.opacity(0.14), in: Capsule())
                    }
                }

                Text(summary)
                    .font(T3Typography.supporting)
                    .foregroundStyle(T3Colors.textTertiary)

                if let ipAddress = session.ipAddress, !ipAddress.isEmpty {
                    Text(ipAddress)
                        .font(.caption.monospaced())
                        .foregroundStyle(T3Colors.textTertiary)
                }
            }
            Spacer(minLength: 8)
            if isRevoking {
                ProgressView()
                    .accessibilityLabel("Removing access")
            }
        }
        .padding(.vertical, 2)
        .opacity(isRevoking ? 0.6 : 1)
        .accessibilityElement(children: .combine)
    }

    /// "Online · macOS · Chrome", or the platform then when it was last seen.
    private var summary: AttributedString {
        var parts: [AttributedString] = []
        if session.isConnected, !session.isCurrent {
            var online = AttributedString("Online")
            online.foregroundColor = T3Colors.success
            parts.append(online)
        }
        if !session.platformDescription.isEmpty {
            parts.append(AttributedString(session.platformDescription))
        }
        if session.isConnected {
            if session.isCurrent { parts.append(AttributedString("Active now")) }
        } else {
            parts.append(AttributedString(session.lastSeenAt.formatted(.relative(presentation: .named))))
        }
        return parts.enumerated().reduce(into: AttributedString()) { result, part in
            if part.offset > 0 { result += AttributedString(" · ") }
            result += part.element
        }
    }
}
