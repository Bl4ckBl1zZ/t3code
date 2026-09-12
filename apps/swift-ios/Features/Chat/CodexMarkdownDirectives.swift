import Foundation

struct CodexArtifactTemplate: Equatable, Sendable {
    let kind: String
    let displayName: String
    let skillName: String
    let skillDirectory: String

    static let labels = ["document": "Document", "presentation": "Presentation", "spreadsheet": "Spreadsheet", "site": "Site", "google-docs": "Google Doc", "google-slides": "Google Slides", "google-sheets": "Google Sheet", "image": "Image", "email": "Email", "slack": "Slack"]
    var label: String { "\(Self.labels[kind] ?? kind) template" }
    var prompt: String {
        let skill = "$\(skillName)"
        switch kind {
        case "presentation": return "Create a presentation using the \(skill) template about…"
        case "image": return "Create an image using this \(skill) of…"
        case "email": return "Draft an email using this \(skill) about…"
        case "slack": return "Draft a Slack message using this \(skill) about…"
        default: return "Create a \(Self.labels[kind] ?? kind) using this \(skill) about…"
        }
    }

    static func parse(_ line: String) -> Self? {
        let value = line.trimmingCharacters(in: .whitespaces)
        let prefix = "::artifact-template{"
        guard value.hasPrefix(prefix), value.hasSuffix("}"),
              let attrs = CodexMarkdownDirectives.attributes(String(value.dropFirst(prefix.count).dropLast())),
              let kind = attrs["artifact_kind"], labels[kind] != nil,
              let display = attrs["display_name"]?.trimmingCharacters(in: .whitespacesAndNewlines), !display.isEmpty,
              let name = attrs["skill_name"], name.hasPrefix("artifact-template-"),
              let directory = attrs["skill_directory"],
              (directory.hasPrefix("/") || directory.hasPrefix("\\\\") || directory.range(of: #"^[A-Za-z]:[\\/]"#, options: .regularExpression) != nil),
              attrs["gallery_kind"] == nil || ["imagegen", "product-design"].contains(attrs["gallery_kind"]!) else { return nil }
        return Self(kind: kind, displayName: display, skillName: name, skillDirectory: directory)
    }
}

/// Only recognizes Codex's two directives. Fenced code stays outside this inline formatter.
enum CodexMarkdownDirectives {
    static func attributes(_ source: String) -> [String: String]? {
        let chars = Array(source)
        var i = 0
        var values: [String: String] = [:]
        while i < chars.count {
            while i < chars.count && chars[i].isWhitespace { i += 1 }
            if i == chars.count { break }
            let start = i
            while i < chars.count && (chars[i].isLetter || chars[i].isNumber || chars[i] == "_" || chars[i] == "-") { i += 1 }
            guard i > start else { return nil }
            let key = String(chars[start..<i])
            guard i < chars.count, chars[i] == "=" else { return nil }
            i += 1
            guard i < chars.count else { return nil }
            let quote: Character? = chars[i] == "\"" || chars[i] == "'" ? chars[i] : nil
            if quote != nil { i += 1 }
            var value = ""
            var closed = quote == nil
            while i < chars.count {
                if let quote, chars[i] == quote { i += 1; closed = true; break }
                if quote == nil && chars[i].isWhitespace { break }
                if chars[i] == "\\", i + 1 < chars.count, chars[i + 1] == quote || chars[i + 1] == "\\" { i += 1 }
                value.append(chars[i]); i += 1
            }
            guard closed else { return nil }
            values[key] = value
        }
        return values
    }

    static func renderFileCitations(_ source: String) -> String {
        guard source.contains(":codex-file-citation{") else { return source }
        let chars = Array(source)
        let prefix = Array(":codex-file-citation{")
        var i = 0
        var codeTicks = 0
        var result = ""
        while i < chars.count {
            if chars[i] == "\\", i + 1 < chars.count {
                result.append(chars[i]); result.append(chars[i + 1]); i += 2; continue
            }
            if chars[i] == "`" {
                let start = i
                while i < chars.count && chars[i] == "`" { i += 1 }
                let count = i - start
                if codeTicks == 0 { codeTicks = count } else if codeTicks == count { codeTicks = 0 }
                result += String(chars[start..<i]); continue
            }
            if codeTicks == 0, chars[i...].starts(with: prefix) {
                var end = i + prefix.count
                var quote: Character?
                while end < chars.count {
                    let char = chars[end]
                    if char == "\\", end + 1 < chars.count { end += 2; continue }
                    if let current = quote { if char == current { quote = nil } }
                    else if char == "\"" || char == "'" { quote = char }
                    else if char == "}" { break }
                    end += 1
                }
                if end < chars.count,
                   let attrs = attributes(String(chars[(i + prefix.count)..<end])),
                   let path = attrs["path"]?.trimmingCharacters(in: .whitespacesAndNewlines), !path.isEmpty {
                    var url = URLComponents()
                    url.scheme = "t3-file-citation"; url.host = "open"
                    url.queryItems = [URLQueryItem(name: "path", value: path)]
                    if let value = attrs["line_range_start"], let line = Int(value), line > 0 {
                        url.queryItems?.append(URLQueryItem(name: "line", value: String(line)))
                    }
                    let label = path.replacingOccurrences(of: "\\", with: "/").split(separator: "/").last.map(String.init) ?? path
                    let escaped = label.reduce(into: "") { output, char in
                        if "\\[]*_`<&".contains(char) { output += "\\" }; output.append(char)
                    }
                    if let href = url.string { result += "[\(escaped)](<\(href)>)"; i = end + 1; continue }
                }
            }
            result.append(chars[i]); i += 1
        }
        return result
    }

    static func fileTarget(_ url: URL) -> (path: String, line: Int?)? {
        guard url.scheme == "t3-file-citation", let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems,
              let path = items.first(where: { $0.name == "path" })?.value, !path.isEmpty else { return nil }
        let line = items.first(where: { $0.name == "line" })?.value.flatMap(Int.init)
        return (path, line.flatMap { $0 > 0 ? $0 : nil })
    }
}
