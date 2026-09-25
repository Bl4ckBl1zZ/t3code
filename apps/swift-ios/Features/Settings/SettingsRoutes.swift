import Foundation

/// A page Settings can push. The phone keeps only what belongs to this device
/// or matters away from the desk; server configuration lives in T3 Code on the
/// computer.
enum SettingsRoute: String, Hashable, CaseIterable, Sendable {
    case servers
    case appearance
    case threads
    case notifications
    case voiceInput
    case usage
    case devices
    case loadBalancing
    case t3Connect
    /// Pairing a new server. Pushed rather than presented, and pops itself once
    /// the server connects.
    case addServer

    var title: String {
        switch self {
        case .servers: "Servers"
        case .appearance: "Appearance"
        case .threads: "Chat"
        case .notifications: "Notifications"
        case .voiceInput: "Voice Input"
        case .usage: "Usage Limits"
        case .devices: "Devices & Sessions"
        case .loadBalancing: "Load Balancing"
        case .t3Connect: "T3 Connect"
        case .addServer: "Add Server"
        }
    }

    var systemImage: String {
        switch self {
        case .servers: "server.rack"
        case .appearance: "paintbrush"
        case .threads: "bubble.left.and.bubble.right"
        case .notifications: "bell.badge"
        case .voiceInput: "mic"
        case .usage: "gauge.with.dots.needle.33percent"
        case .devices: "laptopcomputer.and.iphone"
        case .loadBalancing: "scalemass"
        case .t3Connect: "cloud"
        case .addServer: "plus"
        }
    }

    var tint: T3SettingsTile.Tint {
        switch self {
        case .servers, .addServer: .gray
        case .appearance, .devices: .blue
        case .threads, .loadBalancing: .indigo
        case .notifications, .voiceInput: .red
        case .usage: .green
        case .t3Connect: .teal
        }
    }
}
