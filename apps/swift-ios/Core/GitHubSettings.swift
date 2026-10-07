import Foundation

/// The GitHub choices a server keeps per host, matching `GitHubSettings` in
/// `packages/contracts`. A server that never saved any omits the key, and one
/// that predates the setting never sends it, so snapshots carry nil for both.
public struct GitHubSettings: Codable, Equatable, Sendable {
    /// What a server sends in place of a saved token. Saved tokens never leave
    /// its secret store, and sending the marker back keeps what is saved.
    public static let redactedToken = String(repeating: "\u{2022}", count: 6)

    /// One host's choice of `gh` login.
    public struct Host: Codable, Equatable, Sendable {
        /// A pinned `gh` login for the host; nil follows gh's active one.
        public var account: String?
        /// A host turned off gets no credential at all, saved token included.
        public var enabled: Bool

        public init(account: String? = nil, enabled: Bool = true) {
            self.account = account
            self.enabled = enabled
        }

        private enum CodingKeys: String, CodingKey { case account, enabled }

        public init(from decoder: any Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            let account = try container.decodeIfPresent(String.self, forKey: .account)?
                .trimmingCharacters(in: .whitespacesAndNewlines)
            self.account = account?.isEmpty == false ? account : nil
            enabled = try container.decodeIfPresent(Bool.self, forKey: .enabled) ?? true
        }

        public func encode(to encoder: any Encoder) throws {
            var container = encoder.container(keyedBy: CodingKeys.self)
            try container.encodeIfPresent(account, forKey: .account)
            try container.encode(enabled, forKey: .enabled)
        }

        var json: JSONValue {
            var fields: [String: JSONValue] = ["enabled": .bool(enabled)]
            if let account { fields["account"] = .string(account) }
            return .object(fields)
        }
    }

    /// Keyed by lowercased host, such as `github.com`.
    public var hosts: [String: Host]
    /// The redaction marker for each host with a saved token.
    public var tokens: [String: String]

    public init(hosts: [String: Host] = [:], tokens: [String: String] = [:]) {
        self.hosts = hosts
        self.tokens = tokens
    }

    /// Whether the server holds a token for `host`. Any value counts: the
    /// server answers with the marker, never the token.
    public func hasSavedToken(_ host: String) -> Bool {
        !(tokens[Self.normalizedHost(host)] ?? "").isEmpty
    }

    /// Hosts are one entry however they are cased, as the contract decodes them.
    public static func normalizedHost(_ host: String) -> String {
        host.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    }

    /// Why a host typed in by hand cannot be added.
    public enum NewHostError: LocalizedError, Equatable, Sendable {
        case empty
        case notAHost
        case duplicate(String)

        public var errorDescription: String? {
            switch self {
            case .empty: "Enter a host, such as github.example.com."
            case .notAHost: "Enter only the host, such as github.example.com or github.example.com:8443, without https:// or a path."
            case let .duplicate(host): "\(host) is already listed."
            }
        }
    }

    /// A bare `host[:port]` typed in by hand, trimmed and lowercased, or why it
    /// is not one. `existing` holds the hosts already listed.
    public static func validatedNewHost(
        _ input: String,
        existing: Set<String>
    ) -> Result<String, NewHostError> {
        let host = normalizedHost(input)
        guard !host.isEmpty else { return .failure(.empty) }
        let parts = host.split(separator: ":", omittingEmptySubsequences: false)
        guard parts.count <= 2, let name = parts.first else { return .failure(.notAHost) }
        if parts.count == 2 {
            guard parts[1].allSatisfy({ $0.isASCII && $0.isNumber }),
                  let port = Int(parts[1]), (1...65_535).contains(port) else { return .failure(.notAHost) }
        }
        let allowed = Set("abcdefghijklmnopqrstuvwxyz0123456789-")
        let labels = name.split(separator: ".", omittingEmptySubsequences: false)
        let valid = labels.allSatisfy { label in
            !label.isEmpty && label.allSatisfy(allowed.contains)
                && label.first != "-" && label.last != "-"
        }
        guard valid else { return .failure(.notAHost) }
        guard !existing.contains(host) else { return .failure(.duplicate(host)) }
        return .success(host)
    }

    private enum CodingKeys: String, CodingKey { case hosts, tokens }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let hosts = try container.decodeIfPresent([String: Host].self, forKey: .hosts) ?? [:]
        let tokens = try container.decodeIfPresent([String: String].self, forKey: .tokens) ?? [:]
        self.hosts = Dictionary(
            hosts.map { (Self.normalizedHost($0.key), $0.value) },
            uniquingKeysWith: { _, last in last }
        )
        self.tokens = Dictionary(
            tokens.map { (Self.normalizedHost($0.key), $0.value) },
            uniquingKeysWith: { _, last in last }
        )
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(hosts, forKey: .hosts)
        try container.encode(tokens, forKey: .tokens)
    }
}

/// A write to `github` in a settings patch. The two halves merge differently
/// on the server: `hosts` replaces the whole map, so an omitted host or account
/// is cleared, while `tokens` merges per host. Build one with the helpers
/// below, which never send the redaction marker as a token and always carry
/// every host's choice.
public struct GitHubSettingsPatch: Equatable, Sendable {
    public var hosts: [String: GitHubSettings.Host]?
    /// An empty token removes that host's saved token.
    public var tokens: [String: String]?

    public init(hosts: [String: GitHubSettings.Host]? = nil, tokens: [String: String]? = nil) {
        self.hosts = hosts
        self.tokens = tokens
    }

    var json: JSONValue {
        var fields: [String: JSONValue] = [:]
        if let hosts { fields["hosts"] = .object(hosts.mapValues(\.json)) }
        if let tokens { fields["tokens"] = .object(tokens.mapValues(JSONValue.string)) }
        return .object(fields)
    }

    /// The full `hosts` map after one host changes, starting from every host
    /// the server holds. `account` is outer-nil to keep the pin and a present
    /// nil to follow gh's active login again. A host already in the map stays
    /// there back on gh's defaults (on, nothing pinned), so a host added by
    /// hand stays listed until it is removed; a no-op adds nothing.
    public static func changingHost(
        _ host: String,
        in current: [String: GitHubSettings.Host],
        enabled: Bool? = nil,
        account: String?? = nil
    ) -> GitHubSettingsPatch {
        let host = GitHubSettings.normalizedHost(host)
        let previous = current[host]
        let next = GitHubSettings.Host(
            account: account ?? previous?.account,
            enabled: enabled ?? previous?.enabled ?? true
        )
        var hosts = current
        if previous != nil || next != GitHubSettings.Host() {
            hosts[host] = next
        }
        return GitHubSettingsPatch(hosts: hosts)
    }

    /// Lists a host typed in by hand, such as a GitHub Enterprise Server, and
    /// saves its token in the same write when one was given. `host` is the
    /// output of `GitHubSettings.validatedNewHost`.
    public static func addingHost(
        _ host: String,
        token: String,
        in current: [String: GitHubSettings.Host]
    ) -> GitHubSettingsPatch {
        let host = GitHubSettings.normalizedHost(host)
        var hosts = current
        hosts[host] = current[host] ?? GitHubSettings.Host()
        return GitHubSettingsPatch(hosts: hosts, tokens: savingToken(token, host: host)?.tokens)
    }

    /// Forgets a host: its choice, and its saved token when there is one.
    public static func removingHost(
        _ host: String,
        in current: [String: GitHubSettings.Host],
        hasSavedToken: Bool
    ) -> GitHubSettingsPatch {
        let host = GitHubSettings.normalizedHost(host)
        var hosts = current
        hosts[host] = nil
        return GitHubSettingsPatch(hosts: hosts, tokens: hasSavedToken ? [host: ""] : nil)
    }

    /// Saves a new token for one host, or nil when there is nothing to save:
    /// an empty value would remove the saved token and the marker would keep
    /// it, neither of which is what typing a token means.
    public static func savingToken(_ token: String, host: String) -> GitHubSettingsPatch? {
        let host = GitHubSettings.normalizedHost(host)
        let token = token.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !host.isEmpty, !token.isEmpty, token != GitHubSettings.redactedToken else { return nil }
        return GitHubSettingsPatch(tokens: [host: token])
    }

    public static func removingToken(host: String) -> GitHubSettingsPatch {
        GitHubSettingsPatch(tokens: [GitHubSettings.normalizedHost(host): ""])
    }

    /// This patch with `later` laid over it, the way the server would apply
    /// both: `later`'s hosts map wins whole, tokens merge per host.
    func merged(with later: GitHubSettingsPatch) -> GitHubSettingsPatch {
        GitHubSettingsPatch(
            hosts: later.hosts ?? hosts,
            tokens: later.tokens.map { (tokens ?? [:]).merging($0) { _, newer in newer } } ?? tokens
        )
    }
}
