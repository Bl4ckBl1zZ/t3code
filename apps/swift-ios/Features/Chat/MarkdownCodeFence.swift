import Foundation
import SwiftUI

/// What a code fence's info string says beyond its language. Mirrors the web
/// client's `extractFenceTitle`: an explicit `title=`/`file=`/`filename=`
/// attribute wins, otherwise the first token that looks like a file name.
enum MarkdownCodeFenceInfo {
    private static let titleAttribute = try! NSRegularExpression(
        pattern: #"(?:^|\s)(?:title|file(?:name)?)=(?:"([^"]+)"|'([^']+)'|(\S+))"#,
        options: [.caseInsensitive]
    )
    private static let fileNameToken = try! NSRegularExpression(
        pattern: #"^[\w@][\w@./-]*\.[A-Za-z0-9]+$"#
    )

    /// The title in `meta`, the info string after the language
    /// (```` ```ts title="x.ts" ```` or ```` ```ts src/main.ts ````).
    static func title(meta: String) -> String? {
        let meta = meta.trimmingCharacters(in: .whitespaces)
        guard !meta.isEmpty else { return nil }
        let range = NSRange(meta.startIndex..., in: meta)
        if let match = titleAttribute.firstMatch(in: meta, range: range) {
            for group in 1...3 {
                if let captured = Range(match.range(at: group), in: meta) {
                    return String(meta[captured])
                }
            }
        }
        return meta.split(whereSeparator: \.isWhitespace).lazy.map(String.init).first { token in
            fileNameToken.firstMatch(in: token, range: NSRange(token.startIndex..., in: token)) != nil
        }
    }
}

/// The web client's "Run in terminal" rule for a fenced block: a finished,
/// closed fence in a shell language holding exactly one visible command line.
enum MarkdownShellCommand {
    private static let languages: Set<String> = ["sh", "bash", "zsh", "fish", "shell", "powershell", "pwsh"]

    /// The command to type into the terminal, or nil when the block must not
    /// offer to run. Language matching is case-sensitive, like the web.
    static func runnable(language: String?, code: String, terminated: Bool, isStreaming: Bool) -> String? {
        guard terminated, !isStreaming, let language, languages.contains(language) else { return nil }
        let command = code.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !command.isEmpty, !command.hasSuffix("\\") else { return nil }
        // Control characters include the newline, so a second line disqualifies
        // the block; format characters (bidi overrides, zero-width) could make
        // the rendered command differ from what the terminal receives.
        let hidden = code.unicodeScalars.contains { scalar in
            switch scalar.properties.generalCategory {
            case .control, .format: true
            default: false
            }
        }
        return hidden ? nil : command
    }
}

/// A code block's header label: the fence title as a file name when there is
/// one, with the language after it, or the language alone.
struct MarkdownCodeBlockTitle: View {
    let title: String?
    let language: String?

    private var languageLabel: String { (language?.isEmpty == false ? language! : "code").lowercased() }

    var body: some View {
        if let title {
            HStack(spacing: 5) {
                Image(systemName: "doc.text")
                    .imageScale(.small)
                    .foregroundStyle(T3Colors.textTertiary)
                    .accessibilityHidden(true)
                Text(verbatim: title)
                    .foregroundStyle(T3Colors.textSecondary)
                    .truncationMode(.middle)
                    .layoutPriority(1)
                if language?.isEmpty == false {
                    Text(verbatim: languageLabel)
                        .foregroundStyle(T3Colors.textTertiary)
                }
            }
            .font(T3Typography.supporting.monospaced())
            .lineLimit(1)
            .accessibilityElement(children: .combine)
        } else {
            Text(verbatim: languageLabel)
                .font(T3Typography.supporting.monospaced())
                .foregroundStyle(T3Colors.textTertiary)
                .lineLimit(1)
        }
    }
}

/// "Run in Terminal" on a shell block. One tap runs, like the web client and
/// the thread's project actions; the terminal opens on what started.
struct MarkdownRunCommandButton: View {
    let isRunning: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Group {
                if isRunning {
                    ProgressView().controlSize(.small)
                } else {
                    Image(systemName: "play")
                        .font(T3Typography.control)
                        .foregroundStyle(T3Colors.textSecondary)
                }
            }
            .frame(width: T3Metrics.minimumTapTarget, height: T3Metrics.minimumTapTarget)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(isRunning)
        .accessibilityLabel("Run in terminal")
        .accessibilityHint("Runs this command in the thread’s terminal")
    }
}
