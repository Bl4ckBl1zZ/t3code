import Foundation

/// Prompt links open T3 Code from outside it with a prompt ready to send. They
/// never send it: a link from a stranger fills a draft, and the user reads it
/// and presses Send. A link also cannot pick a runtime mode, branch, or
/// worktree; those stay the user's own defaults.
///
///     https://app.t3.codes/new?prompt=…&repo=owner/name&provider=codex&model=gpt-5
///     https://app.t3.codes/new?pr=owner/name/123&prompt=…
///     https://app.t3.codes/<environmentId>/<threadId>?prompt=…
///     t3code://new?…   t3code://threads/<environmentId>/<threadId>?…
///
/// Ported from packages/shared/src/promptLinks.ts and
/// packages/client-runtime/src/promptLinks.ts; keep the two in step.
public enum PromptLinks {
    /// URLs stay well under the limits browsers and link shorteners apply.
    public static let maxPromptLength = 8_000
    public static let hostedAppOrigin = "https://app.t3.codes"

    public struct Repository: Equatable, Sendable {
        public let owner: String
        public let name: String
        /// `owner/name`, as the user knows the repository.
        public var displayName: String { "\(owner)/\(name)" }
        /// The repository canonical key a project with this repository carries.
        public var canonicalKey: String { "github.com/\(owner)/\(name)".lowercased() }
    }

    public struct PullRequest: Equatable, Sendable {
        public let repository: Repository
        public let number: Int
        /// The pull request's page on GitHub.
        public var url: String {
            "https://github.com/\(repository.owner)/\(repository.name)/pull/\(number)"
        }
    }

    /// A prompt as it arrived, after hidden characters were removed.
    public struct LinkedPrompt: Equatable, Sendable {
        public let text: String
        /// How many invisible characters were removed. Any count above zero is
        /// a warning sign.
        public let hiddenCharacters: Int
    }

    public enum NewThreadLink: Equatable, Sendable {
        /// `provider` is a driver kind such as `codex`, lowercased; `model` is
        /// as written.
        case new(prompt: LinkedPrompt, repository: Repository?, provider: String?, model: String?)
        case pullRequest(PullRequest, prompt: LinkedPrompt?)
    }

    /// What an incoming URL opens in the app.
    public enum Route: Equatable, Sendable {
        /// A `/new` link; `query` is its raw query without the `?`.
        case new(query: String)
        case thread(environmentID: String, threadID: String, query: String)
    }

    public struct Failure: Error, Equatable, Sendable {
        public let message: String
    }

    // MARK: - Sanitizing

    /// Zero-width and bidi controls, tag and variation-selector blocks, and
    /// other characters that render as nothing. A model reads them; the person
    /// checking the draft cannot see them, which makes them the usual way to
    /// hide instructions in a prompt. U+FE0E/U+FE0F stay: emoji use them.
    private static let hiddenRanges: [ClosedRange<UInt32>] = [
        0x0000...0x0008, 0x000B...0x000C, 0x000E...0x001F, 0x007F...0x009F,
        0x00AD...0x00AD, 0x034F...0x034F, 0x061C...0x061C, 0x115F...0x1160,
        0x17B4...0x17B5, 0x180B...0x180F, 0x200B...0x200C, 0x200E...0x200F,
        0x202A...0x202E, 0x2060...0x206F, 0x3164...0x3164, 0xFE00...0xFE0D,
        0xFEFF...0xFEFF, 0xFFA0...0xFFA0, 0xFFF0...0xFFFB, 0x1BCA0...0x1BCA3,
        0x1D173...0x1D17A, 0xE0000...0xE0FFF,
    ]

    private static func isHidden(_ scalar: Unicode.Scalar) -> Bool {
        hiddenRanges.contains { $0.contains(scalar.value) }
    }

    /// Emoji and the pieces emoji sequences are built from: pictographs,
    /// symbols, skin tones, and the emoji presentation selector.
    private static func isEmojiPart(_ scalar: Unicode.Scalar?) -> Bool {
        guard let value = scalar?.value else { return false }
        return (0x1F000...0x1FAFF).contains(value) || (0x2190...0x2BFF).contains(value) || value == 0xFE0F
    }

    /// Removes characters a reader cannot see, and counts them. Line and
    /// paragraph separators become plain newlines, so the draft shows the
    /// break the model reads.
    public static func sanitize(_ raw: String) -> LinkedPrompt {
        var hidden = 0
        var visible: [Unicode.Scalar] = []
        var scalars = raw.unicodeScalars.makeIterator()
        var pending = scalars.next()
        while let scalar = pending {
            pending = scalars.next()
            switch scalar.value {
            case 0x0D:
                visible.append("\n")
                if pending?.value == 0x0A { pending = scalars.next() }
            case 0x2028, 0x2029:
                visible.append("\n")
            default:
                if isHidden(scalar) { hidden += 1 } else { visible.append(scalar) }
            }
        }
        // A zero-width joiner is visible work only inside an emoji sequence,
        // such as a family.
        var text = String.UnicodeScalarView()
        for (index, scalar) in visible.enumerated() {
            guard scalar.value == 0x200D else { text.append(scalar); continue }
            let previous = index > 0 ? visible[index - 1] : nil
            let next = index + 1 < visible.count ? visible[index + 1] : nil
            if isEmojiPart(previous) && isEmojiPart(next) { text.append(scalar) } else { hidden += 1 }
        }
        return LinkedPrompt(text: trimmed(String(text)), hiddenCharacters: hidden)
    }

    // MARK: - Repositories and pull requests

    private static func matches(_ pattern: String, _ value: String, caseInsensitive: Bool = false) -> [String]? {
        guard let regex = try? NSRegularExpression(pattern: pattern, options: caseInsensitive ? [.caseInsensitive] : []) else { return nil }
        let range = NSRange(value.startIndex..., in: value)
        guard let match = regex.firstMatch(in: value, range: range) else { return nil }
        return (1..<match.numberOfRanges).map { index in
            Range(match.range(at: index), in: value).map { String(value[$0]) } ?? ""
        }
    }

    private static func repository(owner: String, name: String) -> Repository? {
        let trimmedName = name.range(of: ".git", options: [.caseInsensitive, .anchored, .backwards])
            .map { String(name[..<$0.lowerBound]) } ?? name
        guard matches(#"^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$"#, owner) != nil,
              matches(#"^[A-Za-z0-9._-]{1,100}$"#, trimmedName) != nil,
              matches(#"^\.+$"#, trimmedName) == nil else { return nil }
        return Repository(owner: owner, name: trimmedName)
    }

    /// `owner/name`, or a GitHub repository URL.
    public static func parseRepository(_ value: String) -> Repository? {
        let value = trimmed(value)
        guard let match = matches(#"^https?://(?:www\.)?github\.com/([^/?#]+)/([^/?#]+)/?$"#, value, caseInsensitive: true)
            ?? matches(#"^([^/\s]+)/([^/\s]+)$"#, value),
              match.count == 2, !match[0].isEmpty, !match[1].isEmpty else { return nil }
        return repository(owner: match[0], name: match[1])
    }

    /// `owner/name/123`, `owner/name#123`, or a GitHub pull request URL.
    public static func parsePullRequest(_ value: String) -> PullRequest? {
        let value = trimmed(value)
        guard let match = matches(#"^https?://(?:www\.)?github\.com/([^/?#]+)/([^/?#]+)/pull/(\d+)(?:[/?#].*)?$"#, value, caseInsensitive: true)
            ?? matches(#"^([^/\s#]+)/([^/\s#]+)(?:/|#)(\d+)$"#, value),
              match.count == 3, !match[0].isEmpty, !match[1].isEmpty,
              let repository = repository(owner: match[0], name: match[1]),
              let number = Int(match[2]), number > 0, number <= 9_007_199_254_740_991 else { return nil }
        return PullRequest(repository: repository, number: number)
    }

    // MARK: - Links

    private static func readPrompt(_ params: QueryParameters) -> Result<LinkedPrompt?, Failure> {
        guard let raw = params["prompt"] else { return .success(nil) }
        // UTF-16 length, as the JavaScript clients count it.
        if raw.utf16.count > maxPromptLength {
            return .failure(Failure(message: "This prompt is longer than 8,000 characters, so T3 Code did not open it."))
        }
        let prompt = sanitize(raw)
        if prompt.text.isEmpty && prompt.hiddenCharacters > 0 {
            return .failure(Failure(message: "This prompt had only hidden characters, so it may be malicious. T3 Code did not open it."))
        }
        return .success(prompt.text.isEmpty ? nil : prompt)
    }

    /// Reads the query of a `/new` link.
    public static func parseNewThreadLink(_ query: String) -> Result<NewThreadLink, Failure> {
        let params = QueryParameters(query)
        let prompt: LinkedPrompt?
        switch readPrompt(params) {
        case let .failure(failure): return .failure(failure)
        case let .success(value): prompt = value
        }
        if let pr = params["pr"] {
            guard let pullRequest = parsePullRequest(pr) else {
                return .failure(Failure(message: "This link names a pull request T3 Code cannot read."))
            }
            return .success(.pullRequest(pullRequest, prompt: prompt))
        }
        guard let prompt else { return .failure(Failure(message: "This link has no prompt.")) }
        var repository: Repository?
        if let repo = params["repo"] {
            guard let parsed = parseRepository(repo) else {
                return .failure(Failure(message: "This link names a repository T3 Code cannot read."))
            }
            repository = parsed
        }
        func optional(_ key: String) -> String? {
            guard let value = params[key].map(trimmed), !value.isEmpty else { return nil }
            return value
        }
        return .success(.new(prompt: prompt, repository: repository, provider: optional("provider")?.lowercased(), model: optional("model")))
    }

    /// Reads the `prompt` of a thread link. Nil when the link carries none.
    public static func parseThreadLinkPrompt(_ query: String) -> Result<LinkedPrompt?, Failure> {
        readPrompt(QueryParameters(query))
    }

    /// A shareable `/new` link on the hosted app.
    public static func buildNewThreadLink(prompt: String) -> String {
        "\(hostedAppOrigin)/new?prompt=\(formEncoded(prompt))"
    }

    /// A shareable link to a sent prompt, or nil when the prompt cannot fit in
    /// one. Ports web's `promptLinkFor`.
    public static func shareLink(for prompt: String) -> String? {
        let prompt = trimmed(prompt)
        guard !prompt.isEmpty, prompt.utf16.count <= maxPromptLength else { return nil }
        return buildNewThreadLink(prompt: prompt)
    }

    /// What a `t3code://` (any `t3code-<letters>` scheme) or hosted-app URL
    /// opens, or nil for any other URL. A hosted thread link only opens in
    /// the app when it carries a prompt; a plain one is just a page there.
    public static func route(for url: URL) -> Route? {
        guard let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
              let scheme = components.scheme?.lowercased() else { return nil }
        let query = components.percentEncodedQuery ?? ""
        let path = components.percentEncodedPath
        if matches(#"^t3code(?:-[a-z]+)?$"#, scheme) != nil {
            let host = components.percentEncodedHost?.lowercased()
            if host == "new", path.isEmpty || path == "/" { return .new(query: query) }
            guard host == "threads", let thread = threadPath(path) else { return nil }
            return .thread(environmentID: thread.0, threadID: thread.1, query: query)
        }
        guard scheme == "https", components.host?.lowercased() == "app.t3.codes",
              components.port == nil || components.port == 443 else { return nil }
        if path == "/new" { return .new(query: query) }
        guard QueryParameters(query)["prompt"] != nil, let thread = threadPath(path) else { return nil }
        return .thread(environmentID: thread.0, threadID: thread.1, query: query)
    }

    /// Whether a route carries a prompt link rather than being a plain deep
    /// link: `t3code://new` alone opens New Task, and a thread link without a
    /// prompt just opens the thread.
    public static func carriesPromptLink(_ route: Route) -> Bool {
        switch route {
        case let .new(query):
            let params = QueryParameters(query)
            return params["prompt"] != nil || params["pr"] != nil || params["repo"] != nil
        case let .thread(_, _, query):
            return QueryParameters(query)["prompt"] != nil
        }
    }

    private static func threadPath(_ path: String) -> (String, String)? {
        guard let match = matches(#"^/([^/]+)/([^/]+)/?$"#, path), match.count == 2 else { return nil }
        return (match[0].removingPercentEncoding ?? match[0], match[1].removingPercentEncoding ?? match[1])
    }

    // MARK: - Resolving against this client

    /// The selection a link asks for, on one of the user's own provider
    /// instances. `exact` is false when the instance exists but the model
    /// does not, so its default model stands in. Nil when no usable instance
    /// of that provider exists; the user's default applies then.
    public struct ProviderCandidate: Equatable, Sendable {
        public struct Model: Equatable, Sendable {
            public let slug: String
            public let name: String
            public var aliases: [String] = []
            public var isDefault = false
        }
        public let instanceID: String
        public let driver: String
        public let enabled: Bool
        /// "unavailable" hides the instance.
        public let availability: String?
        /// "ready" is preferred, then "warning".
        public let status: String?
        public let models: [Model]
    }

    public struct ModelResolution: Equatable, Sendable {
        public let instanceID: String
        public let model: String
        public let exact: Bool
    }

    /// People write the name they know. Driver kinds are what the server reports.
    private static let providerAliases = ["claude": "claudeagent"]

    public static func resolveModel(
        _ providers: [ProviderCandidate],
        provider: String,
        model: String?
    ) -> ModelResolution? {
        let driver = providerAliases[provider] ?? provider
        let usable = providers.filter {
            $0.driver.lowercased() == driver && $0.enabled && $0.availability != "unavailable"
        }
        guard let instance = usable.first(where: { $0.status == "ready" })
            ?? usable.first(where: { $0.status == "warning" }) else { return nil }
        let requested = model.flatMap { selectableModel($0, in: instance.models) }
        guard let slug = requested ?? (instance.models.first(where: \.isDefault) ?? instance.models.first)?.slug else { return nil }
        return ModelResolution(instanceID: instance.instanceID, model: slug, exact: model == nil || requested != nil)
    }

    /// Slug, then name, then alias (case-insensitive past the slug), as
    /// `resolveSelectableModel` does.
    static func selectableModel(_ value: String, in models: [ProviderCandidate.Model]) -> String? {
        let value = trimmed(value)
        guard !value.isEmpty else { return nil }
        if let direct = models.first(where: { $0.slug == value }) { return direct.slug }
        let lowered = value.lowercased()
        if let byName = models.first(where: { $0.name.lowercased() == lowered }) { return byName.slug }
        return models.first { $0.aliases.contains { $0.lowercased() == lowered } }?.slug
    }

    /// The text of the one notice a prompt link shows. Every link says the
    /// prompt came from a link; hidden characters replace that line with a
    /// stronger warning.
    public static func notice(hiddenCharacters: Int, modelUnavailable: Bool = false, extra: String? = nil) -> String {
        [
            hiddenCharacters > 0
                ? "This prompt had hidden characters, it may be malicious. They were removed. Read it before you send."
                : "This prompt came from a link. Read it before you send.",
            modelUnavailable ? "The requested model is not available, so your default is used." : nil,
            extra,
        ].compactMap { $0 }.joined(separator: "\n\n")
    }

    /// How a linked prompt lands in an existing thread composer.
    public enum DraftAction: Equatable, Sendable { case fill, keep, ask }

    public static func threadDraftAction(currentText: String, prompt: String) -> DraftAction {
        if currentText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return .fill }
        return currentText == prompt ? .keep : .ask
    }

    /// The machine a prompt without a project opens on: the most recently
    /// active one that offers threads without a project, else the first that does.
    public static func scratchEnvironmentID(mostRecentFirst: [String], scratchCapable: [String]) -> String? {
        mostRecentFirst.first { scratchCapable.contains($0) } ?? scratchCapable.first
    }

    // MARK: - Helpers

    /// `String.prototype.trim`: whitespace and line terminators at both ends.
    private static func trimmed(_ value: String) -> String {
        value.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// `application/x-www-form-urlencoded`, as `URLSearchParams` writes it.
    static func formEncoded(_ value: String) -> String {
        var allowed = CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789*-._")
        allowed.insert(" ")
        return (value.addingPercentEncoding(withAllowedCharacters: allowed) ?? value)
            .replacingOccurrences(of: " ", with: "+")
    }

    /// A query read the way `URLSearchParams` reads one: `+` is a space, and
    /// the first value of a repeated key wins.
    struct QueryParameters {
        private var values: [String: String] = [:]

        init(_ query: String) {
            let query = query.hasPrefix("?") ? String(query.dropFirst()) : query
            for pair in query.split(separator: "&", omittingEmptySubsequences: true) {
                let parts = pair.split(separator: "=", maxSplits: 1, omittingEmptySubsequences: false)
                let key = Self.decode(String(parts[0]))
                let value = parts.count > 1 ? Self.decode(String(parts[1])) : ""
                if values[key] == nil { values[key] = value }
            }
        }

        subscript(key: String) -> String? { values[key] }

        private static func decode(_ value: String) -> String {
            let spaced = value.replacingOccurrences(of: "+", with: " ")
            return spaced.removingPercentEncoding ?? spaced
        }
    }
}
