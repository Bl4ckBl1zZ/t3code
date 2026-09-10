import Foundation

/// Matches the web's deterministic name classifier, including UTF-16 hashing.
enum ProjectIconDefaults {
    private static let classes: [(String, String, [String])] = [
        ("bot", "violet", ["ai", "agent", "bot", "gpt", "llm", "ml", "model", "neural"]),
        ("smartphone", "lime", ["android", "expo", "ios", "mobile", "native", "reactnative", "swift"]),
        ("monitor", "indigo", ["desktop", "electron", "linux", "mac", "macos", "tauri", "windows"]),
        ("book-open", "amber", ["book", "docs", "documentation", "guide", "handbook", "manual", "wiki"]),
        ("shield-check", "teal", ["auth", "identity", "oauth", "security", "sso", "vault"]),
        ("database", "cyan", ["analytics", "data", "database", "db", "mongo", "mysql", "postgres", "redis", "sql", "storage"]),
        ("cloud-cog", "sky", ["aws", "azure", "cloud", "deploy", "devops", "docker", "gcp", "infra", "kubernetes", "terraform"]),
        ("server", "blue", ["api", "backend", "gateway", "server", "service", "worker"]),
        ("terminal", "green", ["automation", "bash", "cli", "command", "script", "shell", "terminal"]),
        ("package", "orange", ["component", "kit", "lib", "library", "package", "plugin", "sdk", "toolkit"]),
        ("flask-conical", "yellow", ["benchmark", "e2e", "fixture", "spec", "test", "testing"]),
        ("shopping-bag", "rose", ["cart", "commerce", "market", "shop", "store"]),
        ("gamepad-2", "emerald", ["game", "gaming", "play"]),
        ("music", "fuchsia", ["audio", "music", "podcast", "radio", "sound"]),
        ("video", "red", ["film", "movie", "stream", "video"]),
        ("image", "pink", ["camera", "gallery", "image", "photo", "picture"]),
        ("globe-2", "sky", ["browser", "frontend", "nextjs", "react", "site", "svelte", "ui", "vue", "web", "website"]),
    ]
    private static let generic = [("code-2", "blue"), ("braces", "purple"), ("circuit-board", "teal"), ("folder-code", "orange"), ("layers-3", "fuchsia")]

    static func select(title: String, workspaceRoot: String) -> ProjectIconOverride {
        let trimmed = title.trimmingCharacters(in: .whitespacesAndNewlines)
        let name = trimmed.isEmpty ? (workspaceRoot.components(separatedBy: CharacterSet(charactersIn: "/\\")).last(where: { !$0.isEmpty }) ?? "project") : trimmed
        let tokens = name.replacingOccurrences(of: "([a-z\\d])([A-Z])", with: "$1 $2", options: .regularExpression)
            .lowercased().components(separatedBy: CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyz0123456789").inverted).filter { !$0.isEmpty }
        var best: (String, String)?
        var bestScore = 0
        for (icon, color, terms) in classes {
            let score = tokens.reduce(0) { total, token in
                total + (terms.map { term in token == term ? 3 : (term.count >= 4 && (token.hasPrefix(term) || token.hasSuffix(term)) ? 1 : 0) }.max() ?? 0)
            }
            if score > bestScore { bestScore = score; best = (icon, color) }
        }
        let hash = name.lowercased().utf16.reduce(UInt32(2_166_136_261)) { ($0 ^ UInt32($1)) &* 16_777_619 }
        let selected = best ?? generic[Int(hash % UInt32(generic.count))]
        return ProjectIconOverride(kind: "lucide", name: selected.0, color: selected.1)
    }
}
