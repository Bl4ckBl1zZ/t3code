import Foundation

public enum AgentSetupCommand {
    public static func resolve(driver: String, installed: Bool, binaryPath: String?, platform: String) -> String? {
        guard driver == "codex" || driver == "claudeAgent" else { return nil }
        if !installed {
            if driver == "claudeAgent" {
                return platform == "windows" ? "irm https://claude.ai/install.ps1 | iex" : "curl -fsSL https://claude.ai/install.sh | bash"
            }
            return platform == "windows" ? "irm https://chatgpt.com/codex/install.ps1 | iex" : "curl -fsSL https://chatgpt.com/codex/install.sh | sh"
        }
        let fallback = driver == "codex" ? "codex" : "claude"
        let binary = binaryPath.flatMap { $0.isEmpty ? nil : $0 } ?? fallback
        let quoted: String
        if binary.range(of: #"^[A-Za-z0-9_./:\\-]+$"#, options: .regularExpression) != nil && (platform == "windows" || !binary.contains("\\")) { quoted = binary }
        else if platform == "windows" { quoted = "& '" + binary.replacingOccurrences(of: "'", with: "''") + "'" }
        else if platform == "darwin" || platform == "linux" {
            let homeRelative = binary.hasPrefix("~/") || binary.hasPrefix("~\\")
            let value = homeRelative ? String(binary.dropFirst(2)) : binary
            quoted = (homeRelative ? "~/" : "") + "'" + value.replacingOccurrences(of: "'", with: "'\"'\"'") + "'"
        } else { quoted = fallback }
        return quoted + (driver == "codex" ? " login" : " auth login")
    }
}
