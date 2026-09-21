import Observation
import SwiftUI
import UIKit

/// Native Hermes session facts for the Details sheet. The sheet owns the
/// model and runs its loads from the list, so the facts can be ordinary rows
/// in the same list instead of a card of their own.
@MainActor @Observable
final class HermesThreadDetailsModel {
    let manager: any FeatureWorkManaging
    let environmentID: String
    let threadID: String

    private(set) var details: HermesWorkThreadDetails?
    private(set) var diagnostics: [String] = []
    private(set) var loading = true
    private(set) var busy = false
    private(set) var failure: String?
    private(set) var subscriptionFailure: String?
    /// Bumped by a live change, so the next load waits for the burst to land.
    private(set) var changeRevision = 0
    /// Bumped by a pull to refresh, which also reopens a live feed that ended.
    private(set) var updatesRetry = 0

    init(manager: any FeatureWorkManaging, environmentID: String, threadID: String) {
        self.manager = manager
        self.environmentID = environmentID
        self.threadID = threadID
    }

    func retry() {
        updatesRetry += 1
        changeRevision += 1
    }

    func load(afterChange: Bool) async {
        if afterChange {
            do { try await Task.sleep(for: .milliseconds(150)) } catch { return }
        }
        loading = true; failure = nil
        defer { if !Task.isCancelled { loading = false } }
        do {
            let result = try await manager.workQuery(environmentID: environmentID, input: .object([
                "providerInstanceId": .string(""), "profile": .string("default"), "section": .string("thread"), "id": .string(threadID)
            ]))
            try Task.checkCancellation()
            details = result.threadDetails
            diagnostics = result.diagnostics
            if result.threadDetails == nil { failure = "This environment does not report native thread details. Update its T3 server." }
        } catch { if !Task.isCancelled { failure = error.localizedDescription } }
    }

    func observeChanges() async {
        guard let instanceID = details?.providerInstanceId else { return }
        subscriptionFailure = nil
        do {
            for try await change in try await manager.workChanges(environmentID: environmentID, instanceID: instanceID) {
                try Task.checkCancellation()
                guard change.providerInstanceId == instanceID else { continue }
                changeRevision += 1
            }
            if !Task.isCancelled { subscriptionFailure = "Live updates ended. Pull to refresh to reconnect." }
        } catch { if !Task.isCancelled { subscriptionFailure = "Live updates unavailable: \(error.localizedDescription)" } }
    }

    /// Runs a schedule command and reports the host's receipt in a HUD; a
    /// failure stays in the list as a red row.
    func manage(_ schedule: HermesWorkThreadDetails.LinkedSchedule, action: String) async {
        guard let instanceID = details?.providerInstanceId, !busy else { return }
        busy = true; failure = nil
        defer { busy = false }
        do {
            let result = try await manager.workMutate(environmentID: environmentID, input: .object([
                "providerInstanceId": .string(instanceID), "profile": .string(schedule.profile),
                "command": .object(["type": .string(action), "id": .string(schedule.id)])
            ]))
            T3HUD.show(result.message.isEmpty ? "Done" : result.message)
            await load(afterChange: false)
        } catch {
            failure = error.localizedDescription
            PlatformHapticEngine.shared.play(.error)
        }
    }
}

/// The Hermes sections of the Details list: the session's facts as rows, and
/// the scheduled tasks linked to it.
struct HermesThreadDetailsSections: View {
    let model: HermesThreadDetailsModel

    var body: some View {
        Section {
            if model.loading, model.details == nil {
                ForEach(["Assistant", "Connection", "Native Session"], id: \.self) { title in
                    LabeledContent(title, value: "Loading")
                        .redacted(reason: .placeholder)
                        .t3GroupedRow()
                }
            }
            if let failure = model.failure {
                HStack {
                    Label(failure, systemImage: "exclamationmark.circle")
                        .foregroundStyle(T3Colors.danger)
                    Spacer(minLength: 8)
                    Button("Retry") { model.retry() }
                        .buttonStyle(.bordered)
                        .disabled(model.loading || model.busy)
                }
                .font(T3Typography.supporting)
                .t3GroupedRow()
            }
            if let details = model.details {
                fact("Assistant", value: details.profile)
                fact("Connection", value: details.providerInstanceId)
                fact("Native Session", value: details.sessionId)
                fact("Workspace", value: details.workspacePath)
                if let running = details.gatewayRunning {
                    LabeledContent("Background Service", value: running ? "Running" : "Stopped")
                        .t3GroupedRow()
                }
                if let path = details.workspacePath, let instanceID = details.providerInstanceId, let profile = details.profile {
                    NavigationLink("Browse Workspace") {
                        HermesThreadWorkspaceView(manager: model.manager, environmentID: model.environmentID, instanceID: instanceID, profile: profile, path: path)
                    }
                    .t3GroupedRow()
                }
            }
        } header: {
            Text("Hermes Session")
        } footer: {
            sessionFooter
        }

        if let details = model.details {
            Section {
                ForEach(details.schedules) { schedule in
                    NavigationLink {
                        HermesScheduleDetailView(model: model, scheduleID: schedule.id)
                    } label: {
                        LabeledContent {
                            Text(schedule.paused ? "Paused" : "Enabled")
                        } label: {
                            Text(schedule.name)
                            Text(schedule.scheduleDisplay ?? schedule.schedule)
                        }
                    }
                    .swipeActions(edge: .trailing) {
                        Button(schedule.paused ? "Resume" : "Pause") {
                            Task { await model.manage(schedule, action: schedule.paused ? "schedule.resume" : "schedule.pause") }
                        }
                        .tint(T3Colors.warning)
                        Button("Run Now") {
                            Task { await model.manage(schedule, action: "schedule.run") }
                        }
                        .tint(T3Colors.accent)
                    }
                    .disabled(model.busy)
                    .t3GroupedRow()
                }
            } header: {
                Text("Linked Scheduled Tasks")
            } footer: {
                if details.schedules.isEmpty {
                    Text(details.schedulesAvailable == false || (details.schedulesAvailable == nil && details.status == "unavailable")
                        ? "Linked schedules could not be confirmed."
                        : "No scheduled task is linked to this session.")
                }
            }
        }
    }

    /// The session's standing, then anything the host added about it.
    @ViewBuilder
    private var sessionFooter: some View {
        let lines = footerLines
        if !lines.isEmpty {
            VStack(alignment: .leading, spacing: 4) {
                ForEach(Array(lines.enumerated()), id: \.offset) { _, line in
                    Text(line.text)
                        .foregroundStyle(line.isWarning ? T3Colors.warning : T3Colors.textSecondary)
                }
            }
        }
    }

    private var footerLines: [(text: String, isWarning: Bool)] {
        var lines: [(String, Bool)] = []
        if let details = model.details {
            if details.status == "unbound" {
                lines.append(("No native Hermes session is linked to this thread yet.", false))
            } else if details.status == "unavailable" {
                lines.append(("The native session’s current state could not be confirmed.", true))
            }
            if let state = details.gatewayState { lines.append((state, false)) }
        }
        lines += model.diagnostics.map { ($0, false) }
        if let subscriptionFailure = model.subscriptionFailure { lines.append((subscriptionFailure, false)) }
        return lines
    }

    @ViewBuilder
    private func fact(_ title: String, value: String?) -> some View {
        if let value, !value.isEmpty {
            LabeledContent(title) {
                Text(value)
                    .font(T3Typography.tool)
                    .textSelection(.enabled)
            }
            .contextMenu {
                Button("Copy \(title)", systemImage: "doc.on.doc") {
                    UIPasteboard.general.string = value
                    T3HUD.show("Copied", systemImage: "doc.on.doc")
                }
            }
            .t3GroupedRow()
        }
    }
}

/// One linked schedule with everything the host reports about it, and its
/// two commands.
private struct HermesScheduleDetailView: View {
    let model: HermesThreadDetailsModel
    let scheduleID: String

    private var schedule: HermesWorkThreadDetails.LinkedSchedule? {
        model.details?.schedules.first { $0.id == scheduleID }
    }

    var body: some View {
        List {
            if let schedule {
                Section {
                    Text(schedule.prompt)
                        .font(T3Typography.threadBody)
                        .foregroundStyle(T3Colors.textPrimary)
                        .textSelection(.enabled)
                        .t3GroupedRow()
                } header: {
                    Text("Prompt")
                } footer: {
                    Text(schedule.relationship == .createdHere
                        ? "Created in this conversation."
                        : "This session ran as part of this scheduled task.")
                }
                Section {
                    LabeledContent("Schedule", value: schedule.scheduleDisplay ?? schedule.schedule).t3GroupedRow()
                    LabeledContent("State", value: schedule.paused ? "Paused" : "Enabled").t3GroupedRow()
                    LabeledContent("Delivery", value: schedule.deliver).t3GroupedRow()
                    if let next = schedule.nextRunAt { LabeledContent("Next Run", value: next).t3GroupedRow() }
                    if let status = schedule.lastStatus { LabeledContent("Last Result", value: status).t3GroupedRow() }
                    if let error = schedule.lastError {
                        Label(error, systemImage: "exclamationmark.circle").foregroundStyle(T3Colors.danger).t3GroupedRow()
                    }
                    if let error = schedule.lastDeliveryError {
                        Label("Delivery: \(error)", systemImage: "exclamationmark.circle").foregroundStyle(T3Colors.danger).t3GroupedRow()
                    }
                }
                Section {
                    Button(schedule.paused ? "Resume" : "Pause") {
                        Task { await model.manage(schedule, action: schedule.paused ? "schedule.resume" : "schedule.pause") }
                    }
                    .t3GroupedRow()
                    Button("Run Now") {
                        Task { await model.manage(schedule, action: "schedule.run") }
                    }
                    .t3GroupedRow()
                }
                .disabled(model.busy || model.loading)
                .tint(T3Colors.accent)
            } else {
                ContentUnavailableView("Schedule Unavailable", systemImage: "calendar.badge.exclamationmark",
                    description: Text("This scheduled task is no longer linked to the session."))
                    .listRowBackground(Color.clear)
            }
        }
        .t3SheetList()
        .t3GroupedListBackground()
        .navigationTitle(schedule?.name ?? "Scheduled Task")
        .navigationBarTitleDisplayMode(.inline)
        .t3NavigationChrome()
    }
}

private struct HermesThreadWorkspaceView: View {
    let manager: any FeatureWorkManaging
    let environmentID: String
    let instanceID: String
    let profile: String
    let path: String
    var isDirectory = true
    @State private var result: HermesWorkQueryResult?
    @State private var failure: String?
    var body: some View {
        List {
            if let failure {
                Label(failure, systemImage: "exclamationmark.circle").foregroundStyle(T3Colors.danger).t3GroupedRow()
            }
            if let result {
                ForEach(result.diagnostics, id: \.self) { Text($0).font(T3Typography.supporting).foregroundStyle(T3Colors.textSecondary).t3GroupedRow() }
                if isDirectory {
                    ForEach(result.files) { file in
                        NavigationLink {
                            HermesThreadWorkspaceView(manager: manager, environmentID: environmentID, instanceID: instanceID, profile: profile, path: file.path, isDirectory: file.directory)
                        } label: { Label(file.name, systemImage: file.directory ? "folder" : "doc") }
                        .t3GroupedRow()
                    }
                    if result.files.isEmpty {
                        ContentUnavailableView("Empty Folder", systemImage: "folder").listRowBackground(Color.clear)
                    }
                } else {
                    Text(result.content ?? "No text preview available.")
                        .font(T3Typography.code)
                        .textSelection(.enabled)
                        .t3GroupedRow()
                }
            } else if failure == nil {
                ProgressView().frame(maxWidth: .infinity).listRowBackground(Color.clear)
            }
        }
        .t3SheetList()
        .t3GroupedListBackground()
        .navigationTitle(URL(fileURLWithPath: path).lastPathComponent)
        .navigationBarTitleDisplayMode(.inline)
        .t3NavigationChrome()
        .task { await load() }
        .refreshable { await load() }
    }
    private func load() async {
        do {
            result = try await manager.workQuery(environmentID: environmentID, input: .object([
                "providerInstanceId": .string(instanceID), "profile": .string(profile), "section": .string(isDirectory ? "files" : "file"), "path": .string(path)
            ]))
            failure = nil
        } catch { failure = error.localizedDescription }
    }
}
