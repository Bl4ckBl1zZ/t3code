import SwiftUI
import UIKit

/// Native session facts belong beside the ordinary thread details, not in a second home screen.
struct HermesThreadDetailsView: View {
    let manager: any FeatureWorkManaging
    let environmentID: String
    let threadID: String
    let refreshID: Int
    @State private var details: HermesWorkThreadDetails?
    @State private var diagnostics: [String] = []
    @State private var loading = true
    @State private var busy = false
    @State private var failure: String?
    @State private var receipt: String?
    @State private var changeRevision = 0
    @State private var updatesRetry = 0
    @State private var subscriptionFailure: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            ThreadDetailsSection(title: "Hermes session") {
                VStack(alignment: .leading, spacing: 12) {
                    if loading { ProgressView("Loading native session…") }
                    if let failure { Text(failure).foregroundStyle(.red) }
                    if let details {
                        if details.status == "unbound" { Text("No native Hermes session is linked to this thread yet.") }
                        else if details.status == "unavailable" { Text("The native session’s current state could not be confirmed.") }
                        fact("Assistant", value: details.profile)
                        fact("Connection", value: details.providerInstanceId)
                        fact("Native session", value: details.sessionId)
                        fact("Workspace", value: details.workspacePath)
                        if let path = details.workspacePath, let instanceID = details.providerInstanceId, let profile = details.profile {
                            NavigationLink("Browse workspace") {
                                HermesThreadWorkspaceView(manager: manager, environmentID: environmentID, instanceID: instanceID, profile: profile, path: path)
                            }
                        }
                        if let running = details.gatewayRunning {
                            LabeledContent("Background service", value: running ? "Running" : "Stopped")
                        }
                        if let state = details.gatewayState { Text(state).font(.caption).foregroundStyle(.secondary) }
                    }
                    ForEach(diagnostics, id: \.self) { Text($0).font(.caption).foregroundStyle(.secondary) }
                    if let subscriptionFailure { Text(subscriptionFailure).font(.caption).foregroundStyle(.secondary) }
                    Button("Refresh native details") { updatesRetry += 1; changeRevision += 1 }.disabled(loading || busy)
                }.padding(12)
            }
            if let details {
                ThreadDetailsSection(title: "Linked scheduled tasks") {
                    VStack(alignment: .leading, spacing: 12) {
                        if details.schedules.isEmpty {
                            Text(details.schedulesAvailable == false || (details.schedulesAvailable == nil && details.status == "unavailable") ? "Linked schedules could not be confirmed." : "No scheduled task is linked to this session.").foregroundStyle(.secondary)
                        }
                        ForEach(details.schedules) { schedule in
                            VStack(alignment: .leading, spacing: 8) {
                                Text(schedule.name).font(.headline)
                                Text(schedule.relationship == .createdHere ? "Created in this conversation." : "This session ran as part of this scheduled task.").font(.caption).foregroundStyle(.secondary)
                                Text(schedule.prompt).font(.callout)
                                LabeledContent("Schedule", value: schedule.schedule)
                                LabeledContent("State", value: schedule.paused ? "Paused" : "Enabled")
                                LabeledContent("Delivery", value: schedule.deliver)
                                if let next = schedule.nextRunAt { LabeledContent("Next run", value: next) }
                                if let status = schedule.lastStatus { LabeledContent("Last result", value: status) }
                                if let error = schedule.lastError { Text(error).foregroundStyle(.red) }
                                if let error = schedule.lastDeliveryError { Text("Delivery: \(error)").foregroundStyle(.red) }
                                HStack {
                                    Button(schedule.paused ? "Resume" : "Pause") { manage(schedule, action: schedule.paused ? "schedule.resume" : "schedule.pause") }
                                    Button("Run now") { manage(schedule, action: "schedule.run") }
                                }.buttonStyle(.borderless).disabled(busy || loading || failure != nil)
                            }
                            if schedule.id != details.schedules.last?.id { Divider() }
                        }
                        if let receipt { Text(receipt).font(.caption).foregroundStyle(.secondary) }
                    }.padding(12)
                }
            }
        }
        .task(id: "\(threadID):\(refreshID):\(changeRevision)") {
            if changeRevision > 0 {
                do { try await Task.sleep(for: .milliseconds(150)) } catch { return }
            }
            await load()
        }
        .task(id: "\(details?.providerInstanceId ?? ""):\(refreshID):\(updatesRetry)") { await observeChanges() }
    }
    @ViewBuilder private func fact(_ title: String, value: String?) -> some View {
        if let value, !value.isEmpty {
            VStack(alignment: .leading, spacing: 3) {
                Text(title).font(.caption).foregroundStyle(.secondary)
                Text(value).font(.callout.monospaced()).textSelection(.enabled)
            }
            .contextMenu { Button("Copy \(title.lowercased())") { UIPasteboard.general.string = value } }
        }
    }
    private func observeChanges() async {
        guard let instanceID = details?.providerInstanceId else { return }
        subscriptionFailure = nil
        do {
            for try await change in try await manager.workChanges(environmentID: environmentID, instanceID: instanceID) {
                try Task.checkCancellation()
                guard change.providerInstanceId == instanceID else { continue }
                changeRevision += 1
            }
            if !Task.isCancelled { subscriptionFailure = "Live updates ended. Refresh to reconnect." }
        } catch { if !Task.isCancelled { subscriptionFailure = "Live updates unavailable: \(error.localizedDescription)" } }
    }
    private func load() async {
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
    private func manage(_ schedule: HermesWorkThreadDetails.LinkedSchedule, action: String) {
        guard let instanceID = details?.providerInstanceId else { return }
        busy = true; failure = nil; receipt = nil
        Task {
            defer { busy = false }
            do {
                let result = try await manager.workMutate(environmentID: environmentID, input: .object([
                    "providerInstanceId": .string(instanceID), "profile": .string(schedule.profile),
                    "command": .object(["type": .string(action), "id": .string(schedule.id)])
                ]))
                receipt = result.message
                await load()
            } catch { failure = error.localizedDescription }
        }
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
            if let failure { Text(failure).foregroundStyle(.red) }
            if let result {
                ForEach(result.diagnostics, id: \.self) { Text($0).font(.caption).foregroundStyle(.secondary) }
                if isDirectory {
                    ForEach(result.files) { file in
                        NavigationLink {
                            HermesThreadWorkspaceView(manager: manager, environmentID: environmentID, instanceID: instanceID, profile: profile, path: file.path, isDirectory: file.directory)
                        } label: { Label(file.name, systemImage: file.directory ? "folder" : "doc") }
                    }
                    if result.files.isEmpty { Text("This folder is empty.").foregroundStyle(.secondary) }
                } else { Text(result.content ?? "No text preview available.").textSelection(.enabled) }
            } else if failure == nil { ProgressView("Loading workspace…") }
        }
        .navigationTitle(URL(fileURLWithPath: path).lastPathComponent)
        .navigationBarTitleDisplayMode(.inline)
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
