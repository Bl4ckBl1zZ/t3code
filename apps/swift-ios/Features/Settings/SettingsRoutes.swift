import Foundation

/// A page Settings can push. Rows and search results push the same values, so a
/// result lands on exactly the page its row would have opened.
enum SettingsRoute: String, Hashable, CaseIterable, Sendable {
    case servers
    case agents
    case appearance
    case threads
    case notifications
    case sharedPreferences
    case projectDefaults
    case automations
    case work
    case usage
    case loadBalancing
    case integrations
    case voiceInput
    case devices
    case desktopUpdates
    case environmentIcons
    case t3Connect
    /// Pairing a new server. Pushed rather than presented, and pops itself once
    /// the server connects.
    case addServer

    var title: String {
        switch self {
        case .servers: "Servers"
        case .agents: "Agents"
        case .appearance: "Appearance"
        case .threads: "Threads"
        case .notifications: "Notifications"
        case .sharedPreferences: "Shared Preferences"
        case .projectDefaults: "Project Defaults"
        case .automations: "Automations"
        case .work: "Work"
        case .usage: "Usage"
        case .loadBalancing: "Load Balancing"
        case .integrations: "Integrations"
        case .voiceInput: "Voice Input"
        case .devices: "Devices & Sessions"
        case .desktopUpdates: "Desktop Updates"
        case .environmentIcons: "Environment Icon"
        case .t3Connect: "T3 Connect"
        case .addServer: "Add Server"
        }
    }

    var systemImage: String {
        switch self {
        case .servers: "server.rack"
        case .agents: "sparkles"
        case .appearance: "paintbrush"
        case .threads: "list.bullet"
        case .notifications: "bell.badge"
        case .sharedPreferences: "tray.full"
        case .projectDefaults: "folder"
        case .automations: "calendar.badge.clock"
        case .work: "briefcase"
        case .usage: "chart.bar.xaxis"
        case .loadBalancing: "scalemass"
        case .integrations: "point.3.connected.trianglepath.dotted"
        case .voiceInput: "mic"
        case .devices: "laptopcomputer.and.iphone"
        case .desktopUpdates: "arrow.down.circle"
        case .environmentIcons: "desktopcomputer"
        case .t3Connect: "cloud"
        case .addServer: "plus"
        }
    }

    var tint: T3SettingsTile.Tint {
        switch self {
        case .servers, .sharedPreferences, .desktopUpdates, .addServer: .gray
        case .agents: .purple
        case .appearance, .projectDefaults, .devices: .blue
        case .threads, .loadBalancing, .environmentIcons: .indigo
        case .notifications, .voiceInput: .red
        case .automations: .orange
        case .work, .integrations, .t3Connect: .teal
        case .usage: .green
        }
    }

    /// Pages that only mean something once a server is paired. Settings hides
    /// them, and search skips them, until one is.
    var requiresServer: Bool {
        switch self {
        case .appearance, .threads, .notifications, .addServer: false
        default: true
        }
    }
}

/// One thing a reader might search Settings for: a page, or a setting on one.
struct SettingsSearchEntry: Identifiable, Hashable, Sendable {
    let title: String
    let route: SettingsRoute
    /// Extra words that should find this entry: synonyms, and the names of the
    /// controls on its page that are not entries of their own.
    let keywords: [String]

    var id: String { "\(route.rawValue)/\(title)" }

    /// The page an entry lives on, shown under its title. Nil for the page
    /// itself, whose title already says where it goes.
    var breadcrumb: String? {
        title == route.title ? nil : route.title
    }
}

/// The static index `.searchable` filters on the Settings root.
enum SettingsSearchIndex {
    static let entries: [SettingsSearchEntry] = [
        .init(title: "Servers", route: .servers, keywords: ["server", "connection", "environment", "switch", "disconnect", "remove"]),
        .init(title: "Add Server", route: .addServer, keywords: ["pair", "connect", "new server", "qr", "code", "link"]),
        .init(title: "Devices & Sessions", route: .devices, keywords: ["device", "session", "revoke", "sign out", "access"]),
        .init(title: "Desktop Updates", route: .desktopUpdates, keywords: ["update", "version", "relaunch", "desktop app"]),
        .init(title: "Environment Icon", route: .environmentIcons, keywords: ["icon", "machine", "laptop", "server"]),
        .init(title: "T3 Connect", route: .t3Connect, keywords: ["cloud", "account", "relay", "sign in", "sync"]),
        .init(title: "Agents", route: .agents, keywords: ["provider", "account", "codex", "claude", "cursor", "opencode", "grok", "models"]),
        .init(title: "Auto-Compact", route: .agents, keywords: ["claude", "compact", "tokens", "context"]),
        .init(title: "Custom Models", route: .agents, keywords: ["model id", "options", "reasoning"]),
        .init(title: "Appearance", route: .appearance, keywords: ["theme", "palette", "dark", "light", "mode", "color"]),
        .init(title: "Threads", route: .threads, keywords: ["transcript"]),
        .init(title: "Diff Colors", route: .threads, keywords: ["diff", "red", "green", "blue", "orange", "colorblind"]),
        .init(title: "Activity Detail", route: .threads, keywords: ["tool calls", "reasoning", "expand"]),
        .init(title: "Skills in Slash Menu", route: .threads, keywords: ["slash", "skills", "commands"]),
        .init(title: "Confirm Before Unpinning", route: .threads, keywords: ["pin", "unpin"]),
        .init(title: "Notifications", route: .notifications, keywords: ["alerts", "push"]),
        .init(title: "Live Activities", route: .notifications, keywords: ["lock screen", "dynamic island"]),
        .init(title: "Shared Preferences", route: .sharedPreferences, keywords: ["settle", "organize"]),
        .init(title: "Automatic Settlement", route: .sharedPreferences, keywords: ["settle", "merged", "inactive", "archive"]),
        .init(title: "Restart Recovery", route: .sharedPreferences, keywords: ["restart", "resume", "continue"]),
        .init(title: "Git and Generated Text", route: .sharedPreferences, keywords: ["worktree", "origin", "commit", "writing style", "pull request template", "titles"]),
        .init(title: "Project Defaults", route: .projectDefaults, keywords: ["project", "new threads", "workspace", "worktree", "local"]),
        .init(title: "Automatic Pull", route: .projectDefaults, keywords: ["pull", "fast-forward", "branch"]),
        .init(title: "Agent Browser Access", route: .projectDefaults, keywords: ["browser", "preview"]),
        .init(title: "Actions", route: .projectDefaults, keywords: ["scripts", "setup", "teardown", "commands"]),
        .init(title: "Automations", route: .automations, keywords: ["schedule", "scheduled tasks", "recurring", "cron"]),
        .init(title: "Work", route: .work, keywords: ["hermes", "assistant", "memory", "skills", "messaging"]),
        .init(title: "Usage", route: .usage, keywords: ["cost", "tokens", "spend", "chart"]),
        .init(title: "Limits", route: .usage, keywords: ["quota", "rate limit", "subscription", "reset credits"]),
        .init(title: "Model Prices", route: .usage, keywords: ["price", "pricing"]),
        .init(title: "Quota Hubs", route: .usage, keywords: ["cliproxy", "hub"]),
        .init(title: "Load Balancing", route: .loadBalancing, keywords: ["machine", "cpu", "memory", "balance"]),
        .init(title: "Integrations", route: .integrations, keywords: []),
        .init(title: "OpenRouter", route: .integrations, keywords: ["api key", "voice", "transcription"]),
        .init(title: "Voice Input", route: .voiceInput, keywords: ["dictation", "speech", "transcription", "microphone"]),
        .init(title: "Voice Model", route: .voiceInput, keywords: ["model", "audio"]),
        .init(title: "Improve Transcripts", route: .voiceInput, keywords: ["cleanup"]),
        .init(title: "Spoken Language", route: .voiceInput, keywords: ["language"]),
        .init(title: "Personal Dictionary", route: .voiceInput, keywords: ["words", "spelling"]),
    ]

    /// Entries matching every word of `query` in their title, page or keywords,
    /// among the pages this client can open. Case- and diacritic-insensitive.
    static func results(for query: String, available: Set<SettingsRoute>) -> [SettingsSearchEntry] {
        let terms = query
            .split(whereSeparator: \.isWhitespace)
            .map { $0.folding(options: [.caseInsensitive, .diacriticInsensitive], locale: nil) }
        guard !terms.isEmpty else { return [] }
        return entries.filter { entry in
            guard available.contains(entry.route) else { return false }
            let haystack = ([entry.title, entry.route.title] + entry.keywords)
                .joined(separator: " ")
                .folding(options: [.caseInsensitive, .diacriticInsensitive], locale: nil)
            return terms.allSatisfy { haystack.contains($0) }
        }
    }
}
