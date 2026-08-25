import Foundation

/// Claude's auto-compaction threshold, mirroring the `autoCompactWindow` rule in
/// `packages/contracts/src/settings.ts`.
///
/// The server is the authority: it validates the same range at the patch
/// boundary and rejects anything outside it. This exists so the field can say
/// what is wrong before the round trip, and so the row can render a stored
/// value as something a person reads ("300,000 tokens") rather than as digits.
public enum ClaudeAutoCompactWindow {
    /// Both ends inclusive, matching the contract's `100000`-to-`1000000` pattern.
    public static let minimumTokens = 100_000
    public static let maximumTokens = 1_000_000

    public enum ValidationFailure: Error, Equatable, Sendable {
        case notANumber
        case outOfRange
    }

    /// Normalizes what a person typed into what the server stores.
    ///
    /// Empty (or whitespace) is a legitimate value — it means "use Claude's
    /// default" — so it succeeds rather than failing as missing input. Grouping
    /// separators are accepted because the row displays them.
    public static func normalize(
        _ raw: String
    ) -> Result<String, ValidationFailure> {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        let digits = trimmed.filter { !",. ".contains($0) && !$0.isWhitespace }
        if digits.isEmpty { return .success("") }
        guard digits.allSatisfy(\.isASCII), digits.allSatisfy(\.isNumber),
              let tokens = Int(digits)
        else {
            return .failure(.notANumber)
        }
        guard tokens >= minimumTokens, tokens <= maximumTokens else {
            return .failure(.outOfRange)
        }
        return .success(String(tokens))
    }

    /// The stored string as a token count, or nil when the server is on
    /// Claude's default.
    public static func tokens(from stored: String) -> Int? {
        let trimmed = stored.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, let tokens = Int(trimmed), tokens > 0 else { return nil }
        return tokens
    }

    /// What the settings row shows on the right-hand side.
    public static func summary(for stored: String) -> String {
        guard let tokens = tokens(from: stored) else { return "Claude's default" }
        return "\(grouped(tokens)) tokens"
    }

    /// What the text field is seeded with when the sheet opens. Empty stays
    /// empty so the placeholder can carry the example.
    public static func editableText(for stored: String) -> String {
        guard let tokens = tokens(from: stored) else { return "" }
        return grouped(tokens)
    }

    public static func message(for failure: ValidationFailure) -> String {
        switch failure {
        case .notANumber:
            "Enter a number of tokens, or leave the field empty."
        case .outOfRange:
            "Enter between \(grouped(minimumTokens)) and \(grouped(maximumTokens)) tokens."
        }
    }

    private static func grouped(_ tokens: Int) -> String {
        let formatter = NumberFormatter()
        formatter.numberStyle = .decimal
        formatter.groupingSeparator = ","
        formatter.usesGroupingSeparator = true
        return formatter.string(from: NSNumber(value: tokens)) ?? String(tokens)
    }
}
