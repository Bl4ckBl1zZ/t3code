import SwiftUI

/// Assistant groups: rooms where several Hermes assistants talk. The list
/// pushes each room; a new group is composed in a sheet.
struct WorkGroupsView: View {
    let manager: any FeatureWorkManaging
    let environmentID: String
    let connectionID: String
    let profile: String
    let profiles: [HermesWorkProfile]
    @State private var groups: [HermesWorkGroup] = []
    @State private var failure: String?
    @State private var loaded = false
    @State private var nextOffset: Double?
    @State private var creating = false

    private var scope: WorkGroupScope {
        WorkGroupScope(manager: manager, environmentID: environmentID, connectionID: connectionID, profile: profile)
    }

    var body: some View {
        List {
            if let failure {
                Section {
                    HStack(alignment: .firstTextBaseline, spacing: 10) {
                        Image(systemName: "exclamationmark.triangle.fill")
                            .foregroundStyle(T3Colors.danger)
                            .accessibilityHidden(true)
                        Text(failure)
                            .frame(maxWidth: .infinity, alignment: .leading)
                        Button("Retry") { Task { await load() } }
                            .buttonStyle(.bordered)
                            .controlSize(.small)
                    }
                }
                .t3GroupedRow()
            }
            if !loaded && failure == nil {
                Section {
                    ForEach(0..<3, id: \.self) { _ in
                        Text("Assistant group name")
                            .redacted(reason: .placeholder)
                            .accessibilityHidden(true)
                    }
                }
                .t3GroupedRow()
            } else if !groups.isEmpty {
                Section {
                    ForEach(groups) { group in
                        NavigationLink {
                            WorkGroupRoomView(scope: scope, group: group) {
                                Task { await load() }
                            }
                        } label: {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(group.name)
                                    .foregroundStyle(T3Colors.textPrimary)
                                Text(group.members.map(\.name).joined(separator: ", "))
                                    .font(.caption)
                                    .foregroundStyle(T3Colors.textSecondary)
                                    .lineLimit(1)
                            }
                        }
                    }
                    if let nextOffset {
                        Button("Load More Groups") { Task { await load(offset: nextOffset) } }
                    }
                }
                .t3GroupedRow()
            }
        }
        .listStyle(.insetGrouped)
        .t3GroupedListBackground()
        .overlay {
            if loaded, groups.isEmpty, failure == nil {
                ContentUnavailableView {
                    Label("No Groups", systemImage: "person.3")
                } description: {
                    Text("A group lets two to six assistants work on something together.")
                } actions: {
                    Button("New Group") { creating = true }
                        .t3ProminentButtonStyle()
                }
            }
        }
        .navigationTitle("Assistant Groups")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button("New Group", systemImage: "plus") { creating = true }
            }
        }
        .t3NavigationChrome()
        .task { await load() }
        .refreshable { await load() }
        .sheet(isPresented: $creating) {
            NewWorkGroupSheet(scope: scope, profiles: profiles) {
                Task { await load() }
            }
        }
    }

    private func load(offset: Double? = nil) async {
        do {
            var input = scope.input; if let offset { input["offset"] = .number(offset) }
            let data = try await manager.workGroupsQuery(environmentID: environmentID, input: .object(input))
            if offset == nil { groups = data.groups } else { let seen = Set(groups.map(\.id)); groups += data.groups.filter { !seen.contains($0.id) } }
            nextOffset = data.nextOffset; failure = nil
        } catch { failure = error.localizedDescription }
        loaded = true
    }
}

/// Where group queries and commands go.
private struct WorkGroupScope {
    let manager: any FeatureWorkManaging
    let environmentID: String
    let connectionID: String
    let profile: String

    var input: [String: JSONValue] { ["providerInstanceId": .string(connectionID), "profile": .string(profile)] }

    @MainActor
    func mutate(_ command: [String: JSONValue]) async throws {
        var input = input; input["operationId"] = .string(UUID().uuidString); input["command"] = .object(command)
        _ = try await manager.workGroupsMutate(environmentID: environmentID, input: .object(input))
    }
}

/// One group's transcript, newest at the bottom, with a composer pinned
/// under it like Chat.
private struct WorkGroupRoomView: View {
    let scope: WorkGroupScope
    @State var group: HermesWorkGroup
    let onChange: () -> Void

    @SwiftUI.Environment(\.dismiss) private var dismiss
    @State private var events: [HermesWorkGroupEvent] = []
    @State private var cursor: Double = 0
    @State private var hasMore = false
    @State private var loaded = false
    @State private var message = ""
    @State private var failure: String?
    @State private var busy = false
    @State private var renaming = false
    @State private var newName = ""
    @State private var removing = false

    private var isOpen: Bool { group.disbandedAt == nil }

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 10) {
                // Messages' group header: who is in the room.
                Text(group.members.map(\.name).joined(separator: ", "))
                    .font(.footnote)
                    .foregroundStyle(T3Colors.textSecondary)
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: .infinity)
                    .accessibilityLabel("Members: \(group.members.map(\.name).joined(separator: ", "))")
                if hasMore {
                    Button("Load Earlier Activity") { Task { await load(append: true) } }
                        .frame(maxWidth: .infinity)
                        .padding(.bottom, 4)
                }
                if let failure {
                    Label(failure, systemImage: "exclamationmark.triangle.fill")
                        .font(.footnote)
                        .foregroundStyle(T3Colors.danger)
                }
                ForEach(events) { event in
                    WorkGroupEventBubble(event: event)
                }
                if !isOpen {
                    Text("This group was removed. Its history stays readable.")
                        .font(.footnote)
                        .foregroundStyle(T3Colors.textSecondary)
                        .frame(maxWidth: .infinity)
                        .padding(.top, 8)
                }
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 12)
        }
        .defaultScrollAnchor(.bottom)
        .scrollDismissesKeyboard(.interactively)
        .background(T3Colors.background)
        .overlay {
            if loaded, events.isEmpty, failure == nil {
                ContentUnavailableView(
                    "No Messages Yet",
                    systemImage: "bubble.left.and.bubble.right",
                    description: Text("Mention an assistant with @handle to bring it in.")
                )
            }
        }
        .safeAreaInset(edge: .bottom) {
            if isOpen { composer }
        }
        .navigationTitle(group.name)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if isOpen {
                ToolbarItem(placement: .primaryAction) {
                    Menu {
                        Button("Rename…", systemImage: "pencil") {
                            newName = group.name
                            renaming = true
                        }
                        Button("Stop Active Work", systemImage: "stop.circle") {
                            act(["type": .string("stop"), "roomId": .string(group.id)])
                        }
                        Divider()
                        Button("Remove Group", systemImage: "trash", role: .destructive) { removing = true }
                    } label: {
                        Label("Group Actions", systemImage: "ellipsis")
                    }
                    .disabled(busy)
                }
            }
        }
        .t3NavigationChrome()
        .task { await load() }
        .refreshable { await load() }
        .alert("Rename Group", isPresented: $renaming) {
            TextField("Group Name", text: $newName)
            Button("Cancel", role: .cancel) {}
            Button("Rename") {
                let name = newName.trimmingCharacters(in: .whitespacesAndNewlines)
                guard !name.isEmpty else { return }
                act(["type": .string("rename"), "roomId": .string(group.id), "eventId": .string(UUID().uuidString), "name": .string(name)])
            }
        }
        .confirmationDialog("Remove “\(group.name)”?", isPresented: $removing, titleVisibility: .visible) {
            Button("Remove Group", role: .destructive) {
                act(["type": .string("remove"), "roomId": .string(group.id)]) {
                    dismiss()
                }
            }
        } message: {
            Text("The assistants stop working together. This changes the Hermes setup on the selected environment.")
        }
    }

    private var composer: some View {
        HStack(alignment: .bottom, spacing: 8) {
            TextField("Message (use @handle to mention)", text: $message, axis: .vertical)
                .lineLimit(1...5)
                .padding(.horizontal, 14)
                .padding(.vertical, 10)
                .t3GlassEffect(interactive: true, in: RoundedRectangle(cornerRadius: 22, style: .continuous))
                .t3GlassRim(in: RoundedRectangle(cornerRadius: 22, style: .continuous))
            Button(action: send) {
                Image(systemName: busy ? "ellipsis" : "arrow.up")
                    .font(.body.weight(.semibold))
                    .frame(width: 22, height: 22)
            }
            .t3ProminentButtonStyle()
            .buttonBorderShape(.circle)
            .disabled(busy || trimmedMessage.isEmpty)
            .accessibilityLabel("Send")
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
    }

    private var trimmedMessage: String {
        message.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private func send() {
        guard !trimmedMessage.isEmpty else { return }
        act([
            "type": .string("send"), "roomId": .string(group.id), "eventId": .string(UUID().uuidString),
            "threadId": .string(UUID().uuidString), "text": .string(message),
        ]) {
            message = ""
        }
    }

    private func load(append: Bool = false) async {
        do {
            var input = scope.input; input["roomId"] = .string(group.id); input["cursor"] = .number(append ? cursor : 0)
            let data = try await scope.manager.workGroupsQuery(environmentID: scope.environmentID, input: .object(input))
            if let updated = data.groups.first(where: { $0.id == group.id }) { group = updated }
            if append { let seen = Set(events.map(\.id)); events += data.events.filter { !seen.contains($0.id) } } else { events = data.events }
            cursor = data.cursor; hasMore = data.hasMore; failure = nil
        } catch { failure = error.localizedDescription }
        loaded = true
    }

    private func act(_ command: [String: JSONValue], then: @escaping () -> Void = {}) {
        busy = true
        Task {
            defer { busy = false }
            do {
                try await scope.mutate(command)
                then()
                onChange()
                if command["type"]?.stringValue != "remove" { await load() }
            } catch {
                PlatformHapticEngine.shared.play(.error)
                failure = error.localizedDescription
            }
        }
    }
}

private struct WorkGroupEventBubble: View {
    let event: HermesWorkGroupEvent

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(event.actor)
                .font(.caption.weight(.semibold))
                .foregroundStyle(T3Colors.textSecondary)
            Text(event.text.isEmpty ? event.kind : event.text)
                .foregroundStyle(event.text.isEmpty ? T3Colors.textSecondary : T3Colors.textPrimary)
                .textSelection(.enabled)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(T3Colors.surface, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
    }
}

/// Names a group and picks its members. Membership is fixed once created.
private struct NewWorkGroupSheet: View {
    let scope: WorkGroupScope
    let profiles: [HermesWorkProfile]
    let onCreated: () -> Void

    @SwiftUI.Environment(\.dismiss) private var dismiss
    @State private var name = ""
    @State private var selected: Set<String> = []
    @State private var creating = false
    @State private var failure: String?

    private var canCreate: Bool {
        !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && (2...6).contains(selected.count)
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Group Name", text: $name)
                }
                .t3GroupedRow()
                Section {
                    ForEach(profiles) { assistant in
                        Toggle(assistant.name, isOn: Binding(
                            get: { selected.contains(assistant.name) },
                            set: { if $0 { selected.insert(assistant.name) } else { selected.remove(assistant.name) } }
                        ))
                    }
                } header: {
                    Text("Members")
                } footer: {
                    if let failure {
                        Label(failure, systemImage: "exclamationmark.triangle.fill")
                            .foregroundStyle(T3Colors.danger)
                    } else {
                        Text("Choose two to six assistants. Membership is fixed once the group is created.")
                    }
                }
                .t3GroupedRow()
            }
            .t3GroupedListBackground()
            .disabled(creating)
            .navigationTitle("New Group")
            .navigationBarTitleDisplayMode(.inline)
            .t3NavigationChrome()
            .t3SheetToolbar(
                .cancel,
                confirm: T3SheetConfirmation(title: "Create", isEnabled: canCreate, isBusy: creating, action: create),
                hasChanges: !name.isEmpty || !selected.isEmpty || creating
            )
        }
    }

    private func create() {
        creating = true
        failure = nil
        let members: [JSONValue] = selected.sorted().map { name in
            .object(["id": .string(UUID().uuidString), "profile": .string(name), "handle": .string(name), "name": .string(name)])
        }
        Task {
            defer { creating = false }
            do {
                try await scope.mutate([
                    "type": .string("create"), "roomId": .string(UUID().uuidString),
                    "name": .string(name.trimmingCharacters(in: .whitespacesAndNewlines)), "members": .array(members),
                ])
                PlatformHapticEngine.shared.play(.success)
                onCreated()
                dismiss()
            } catch {
                PlatformHapticEngine.shared.play(.error)
                failure = error.localizedDescription
            }
        }
    }
}
