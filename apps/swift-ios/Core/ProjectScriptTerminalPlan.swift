import Foundation

/// Uses authoritative script attribution; an unrelated busy shell is never reused.
public enum ProjectScriptTerminalPlan: Equatable, Sendable {
    case launch(terminalID: String)
    case interrupt(terminalID: String)

    public static func resolve(script: ProjectScript, sessions: [TerminalSummary], pendingTerminalID: String? = nil) -> Self {
        if script.singleRun == true {
            if let running = sessions.first(where: { $0.hasRunningSubprocess && $0.activeScriptId == script.id }) {
                return .interrupt(terminalID: running.terminalId)
            }
            if let pendingTerminalID { return .interrupt(terminalID: pendingTerminalID) }
        }
        if let idle = sessions.first(where: { !$0.hasRunningSubprocess && $0.status == .running }) {
            return .launch(terminalID: idle.terminalId)
        }
        let occupied = Set(sessions.map(\.terminalId))
        var number = 1
        while occupied.contains("term-\(number)") { number += 1 }
        return .launch(terminalID: "term-\(number)")
    }
}
