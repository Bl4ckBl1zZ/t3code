import Foundation

struct ThreadHistoricalWorkItem: Equatable, Sendable {
    enum Action: String, Sendable { case read, edit, command, codeSearch, webSearch, tool }
    let action: Action
    var files: [String] = []
    var successful = true
    var running = false
    var persistent = false
}

enum ThreadHistoricalWorkSummary {
    static func label(_ items: [ThreadHistoricalWorkItem]) -> String? {
        guard items.count > 1, items.allSatisfy({ $0.successful && !$0.running && !$0.persistent }) else { return nil }
        var order: [ThreadHistoricalWorkItem.Action] = []
        var counts: [ThreadHistoricalWorkItem.Action: Int] = [:]
        var files = Set<String>()
        for item in items {
            if counts[item.action] == nil { order.append(item.action); counts[item.action] = 0 }
            if item.action == .edit, !item.files.isEmpty {
                for file in item.files where files.insert(file).inserted { counts[.edit, default: 0] += 1 }
            } else { counts[item.action, default: 0] += 1 }
        }
        let labels = order.enumerated().map { index, action in
            let count = counts[action, default: 0]
            let label: String
            switch action {
            case .read: label = "Read \(count) \(count == 1 ? "file" : "files")"
            case .edit: label = "Changed \(count) \(count == 1 ? "file" : "files")"
            case .command: label = "Ran \(count) \(count == 1 ? "command" : "commands")"
            case .codeSearch: label = "Searched code \(count) \(count == 1 ? "time" : "times")"
            case .webSearch: label = "Searched the web \(count) \(count == 1 ? "time" : "times")"
            case .tool: label = "Used \(count) \(count == 1 ? "tool" : "tools")"
            }
            return index == 0 ? label : label.prefix(1).lowercased() + label.dropFirst()
        }
        if labels.count == 1 { return labels[0] }
        if labels.count == 2 { return labels.joined(separator: " and ") }
        return labels.dropLast().joined(separator: ", ") + ", and " + (labels.last ?? "")
    }
}
