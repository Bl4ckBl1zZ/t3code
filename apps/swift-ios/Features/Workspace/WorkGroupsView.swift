import SwiftUI

struct WorkGroupsView: View {
    let manager: any FeatureWorkManaging
    let environmentID: String
    let connectionID: String
    let profile: String
    let profiles: [HermesWorkProfile]
    @State private var groups: [HermesWorkGroup] = []
    @State private var room: HermesWorkGroup?
    @State private var events: [HermesWorkGroupEvent] = []
    @State private var selected: Set<String> = []
    @State private var name = ""
    @State private var message = ""
    @State private var failure: String?
    @State private var busy = false
    @State private var creating = false
    @State private var removing = false
    @State private var nextOffset: Double?
    @State private var cursor: Double = 0
    @State private var hasMore = false

    var body: some View {
        Form {
            if let failure { Text(failure).foregroundStyle(.red) }
            if let room {
                Section(room.name) {
                    Text(room.members.map(\.name).joined(separator: ", ")).font(.caption)
                    ForEach(events) { event in
                        VStack(alignment: .leading) {
                            Text(event.actor).font(.caption).foregroundStyle(.secondary)
                            Text(event.text.isEmpty ? event.kind : event.text).textSelection(.enabled)
                        }
                    }
                    if hasMore { Button("Load more activity") { Task { await loadRoom(room, append: true) } } }
                }
                if room.disbandedAt == nil {
                    Section("Message assistants") {
                        TextField("Message (use @handle to mention an assistant)", text: $message, axis: .vertical)
                        Button("Send") { act(["type": .string("send"), "roomId": .string(room.id), "eventId": .string(UUID().uuidString), "threadId": .string(UUID().uuidString), "text": .string(message)], clearMessage: true) }
                            .disabled(message.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    }
                    Section("Manage group") {
                        TextField("Group name", text: $name)
                        Button("Rename") { act(["type": .string("rename"), "roomId": .string(room.id), "eventId": .string(UUID().uuidString), "name": .string(name)]) }.disabled(name.isEmpty)
                        Button("Stop active work") { act(["type": .string("stop"), "roomId": .string(room.id)]) }
                        Button("Remove group", role: .destructive) { removing = true }
                    }
                }
                Button("Back to groups") { self.room = nil; Task { await load() } }
            } else {
                Section("Groups") {
                    ForEach(groups) { group in
                        Button(group.name) { room = group; name = group.name; Task { await loadRoom(group) } }
                    }
                    if let nextOffset { Button("More groups") { Task { await load(offset: nextOffset) } } }
                    Button("New group") { creating.toggle() }
                }
                if creating {
                    Section("New group") {
                        TextField("Name", text: $name)
                        Text("Choose two to six assistants. Group membership is fixed when created.").font(.caption)
                        ForEach(profiles) { assistant in
                            Toggle(assistant.name, isOn: Binding(get: { selected.contains(assistant.name) }, set: { if $0 { selected.insert(assistant.name) } else { selected.remove(assistant.name) } }))
                        }
                        Button("Create group") { create() }.disabled(name.isEmpty || !(2...6).contains(selected.count))
                    }
                }
            }
        }
        .navigationTitle("Assistant groups")
        .disabled(busy)
        .task { await load() }
        .refreshable { if let room { await loadRoom(room) } else { await load() } }
        .confirmationDialog("Remove this group?", isPresented: $removing) {
            Button("Remove", role: .destructive) { if let room { act(["type": .string("remove"), "roomId": .string(room.id)]) } }
        }
    }
    private var scope: [String: JSONValue] { ["providerInstanceId": .string(connectionID), "profile": .string(profile)] }
    private func load(offset: Double? = nil) async {
        do {
            var input = scope; if let offset { input["offset"] = .number(offset) }
            let data = try await manager.workGroupsQuery(environmentID: environmentID, input: .object(input))
            if offset == nil { groups = data.groups } else { let seen = Set(groups.map(\.id)); groups += data.groups.filter { !seen.contains($0.id) } }
            nextOffset = data.nextOffset; failure = nil
        } catch { failure = error.localizedDescription }
    }
    private func loadRoom(_ target: HermesWorkGroup, append: Bool = false) async {
        do {
            var input = scope; input["roomId"] = .string(target.id); input["cursor"] = .number(append ? cursor : 0)
            let data = try await manager.workGroupsQuery(environmentID: environmentID, input: .object(input))
            if append { let seen = Set(events.map(\.id)); events += data.events.filter { !seen.contains($0.id) } } else { events = data.events }
            cursor = data.cursor; hasMore = data.hasMore; failure = nil
        } catch { failure = error.localizedDescription }
    }
    private func act(_ command: [String: JSONValue], clearMessage: Bool = false) {
        busy = true
        Task {
            defer { busy = false }
            do {
                var input = scope; input["operationId"] = .string(UUID().uuidString); input["command"] = .object(command)
                _ = try await manager.workGroupsMutate(environmentID: environmentID, input: .object(input))
                if clearMessage { message = "" }
                if command["type"]?.stringValue == "remove" { room = nil }
                await load()
                if let room { await loadRoom(room) }
            } catch { failure = error.localizedDescription }
        }
    }
    private func create() {
        let members: [JSONValue] = selected.sorted().map { name in .object(["id": .string(UUID().uuidString), "profile": .string(name), "handle": .string(name), "name": .string(name)]) }
        act(["type": .string("create"), "roomId": .string(UUID().uuidString), "name": .string(name), "members": .array(members)])
    }
}
