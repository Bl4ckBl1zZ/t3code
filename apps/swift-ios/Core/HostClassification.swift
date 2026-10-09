import Foundation

/// Where a hostname points, as far as connection routes care: this device,
/// a private network, a tailnet or another VPN, or the public internet. Mirrors
/// `packages/shared/src/hostClassification.ts` so the app ranks and labels
/// routes the way the web client does.
public enum HostClassification {
    public static func normalized(_ host: String) -> String {
        var value = host.lowercased()
        if value.hasPrefix("[") { value.removeFirst() }
        if value.hasSuffix("]") { value.removeLast() }
        while value.hasSuffix(".") { value.removeLast() }
        return value
    }

    public static func isLoopback(_ host: String) -> Bool {
        let value = normalized(host)
        if value == "localhost" || value == "::1" { return true }
        return ipv4(value)?.first == 127
    }

    /// A name or address only Tailscale uses: a MagicDNS name or its IPv6
    /// range fd7a:115c:a1e0::/48. Its IPv4 addresses come from the shared
    /// 100.64.0.0/10 range, so they prove nothing on their own.
    public static func isTailnet(_ host: String) -> Bool {
        let value = normalized(host)
        if value.hasSuffix(".ts.net") { return true }
        guard let address = ipv6(value) else { return false }
        return address[0] == 0xfd7a && address[1] == 0x115c && address[2] == 0xa1e0
    }

    /// An IPv4 address in 100.64.0.0/10. Tailscale, Cloudflare WARP and Mesh,
    /// other VPNs, and carrier-grade NAT all assign from this range.
    public static func isSharedAddressSpace(_ host: String) -> Bool {
        guard let parts = ipv4(normalized(host)) else { return false }
        return parts[0] == 100 && (64...127).contains(parts[1])
    }

    public static func isPrivateNetwork(_ host: String) -> Bool {
        let value = normalized(host)
        if value == "::" || isLoopback(value) || value.hasSuffix(".localhost")
            || value.hasSuffix(".local") || value == "home.arpa" || value.hasSuffix(".home.arpa")
            || value.hasSuffix(".ts.net")
            || (!value.contains(".") && !value.contains(":")) {
            return true
        }
        if let parts = ipv4(value) ?? mappedIPv4(value) {
            return isPrivateIPv4(parts)
        }
        guard let address = ipv6(value) else { return false }
        // Unique local fc00::/7 and link-local fe80::/10.
        return address[0] & 0xfe00 == 0xfc00 || address[0] & 0xffc0 == 0xfe80
    }

    private static func isPrivateIPv4(_ parts: [Int]) -> Bool {
        parts[0] == 0 || parts[0] == 10 || parts[0] == 127
            || (parts[0] == 100 && (64...127).contains(parts[1]))
            || (parts[0] == 172 && (16...31).contains(parts[1]))
            || (parts[0] == 192 && parts[1] == 168)
            || (parts[0] == 169 && parts[1] == 254)
            || (parts[0] == 198 && (18...19).contains(parts[1]))
    }

    private static func ipv4(_ value: String) -> [Int]? {
        let parts = value.split(separator: ".", omittingEmptySubsequences: false)
        guard parts.count == 4 else { return nil }
        let numbers = parts.compactMap { part -> Int? in
            guard !part.isEmpty, part.allSatisfy(\.isASCII), part.allSatisfy(\.isNumber),
                  let number = Int(part), (0...255).contains(number) else { return nil }
            return number
        }
        return numbers.count == 4 ? numbers : nil
    }

    private static func mappedIPv4(_ value: String) -> [Int]? {
        guard value.hasPrefix("::ffff:") else { return nil }
        let suffix = String(value.dropFirst("::ffff:".count))
        if let dotted = ipv4(suffix) { return dotted }
        let hextets = suffix.split(separator: ":", omittingEmptySubsequences: false)
        guard hextets.count == 2,
              let high = hextet(hextets[0]), let low = hextet(hextets[1]) else { return nil }
        return [high >> 8, high & 0xff, low >> 8, low & 0xff]
    }

    private static func ipv6(_ value: String) -> [Int]? {
        guard value.contains(":") else { return nil }
        let halves = value.components(separatedBy: "::")
        guard halves.count <= 2 else { return nil }
        let head = halves[0].isEmpty ? [] : halves[0].split(separator: ":", omittingEmptySubsequences: false)
        let tail = halves.count == 2 && !halves[1].isEmpty
            ? halves[1].split(separator: ":", omittingEmptySubsequences: false)
            : []
        let parsedHead = head.compactMap(hextet)
        let parsedTail = tail.compactMap(hextet)
        guard parsedHead.count == head.count, parsedTail.count == tail.count else { return nil }
        let missing = 8 - head.count - tail.count
        if halves.count == 1, missing != 0 { return nil }
        if halves.count == 2, missing < 1 { return nil }
        return parsedHead + Array(repeating: 0, count: max(0, missing)) + parsedTail
    }

    private static func hextet(_ part: Substring) -> Int? {
        guard (1...4).contains(part.count), part.allSatisfy(\.isHexDigit) else { return nil }
        return Int(part, radix: 16)
    }
}
