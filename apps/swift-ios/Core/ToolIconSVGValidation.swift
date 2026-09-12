import Foundation
#if canImport(FoundationXML)
import FoundationXML
#endif

/// Bound native SVG work and reject recursive references before constructing the scene graph.
enum ToolIconSVGValidation {
    static func accepts(_ data: Data) -> Bool {
        guard data.count <= ToolIconImageData.maximumBytes,
              let text = String(data: data, encoding: .utf8),
              !text.localizedCaseInsensitiveContains("<!DOCTYPE"),
              !text.localizedCaseInsensitiveContains("<!ENTITY") else { return false }
        let delegate = Delegate()
        let parser = XMLParser(data: data)
        parser.shouldResolveExternalEntities = false
        parser.delegate = delegate
        return parser.parse() && delegate.valid && delegate.nodes > 0 && !delegate.hasCycle()
    }

    private final class Delegate: NSObject, XMLParserDelegate {
        var valid = true
        var nodes = 0
        var stack: [String?] = []
        var edges: [String: Set<String>] = [:]
        var ids: Set<String> = []

        func parser(_ parser: XMLParser, didStartElement name: String, namespaceURI: String?, qualifiedName: String?, attributes: [String: String]) {
            nodes += 1
            if nodes > 512 || stack.count >= 32 || (stack.isEmpty && name != "svg") {
                valid = false; parser.abortParsing(); return
            }
            let id = attributes["id"]
            if let id, !ids.insert(id).inserted { valid = false; parser.abortParsing(); return }
            if let id {
                for parent in stack.compactMap({ $0 }) { edges[parent, default: []].insert(id) }
            }
            stack.append(id)
            if let reference = attributes["href"] ?? attributes["xlink:href"], reference.hasPrefix("#") {
                for parent in stack.compactMap({ $0 }) { edges[parent, default: []].insert(String(reference.dropFirst())) }
            }
        }
        func parser(_ parser: XMLParser, didEndElement: String, namespaceURI: String?, qualifiedName: String?) {
            if !stack.isEmpty { stack.removeLast() }
        }
        func hasCycle() -> Bool {
            var visiting: Set<String> = []
            var finished: Set<String> = []
            func visit(_ id: String) -> Bool {
                if visiting.contains(id) { return true }
                if finished.contains(id) { return false }
                visiting.insert(id)
                for next in edges[id] ?? [] { if visit(next) { return true } }
                visiting.remove(id); finished.insert(id)
                return false
            }
            return edges.keys.contains(where: visit)
        }
    }
}
