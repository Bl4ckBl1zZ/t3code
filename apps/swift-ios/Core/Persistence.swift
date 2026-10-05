import Foundation
import Security

public protocol CredentialStore: Sendable {
    func credential(for environmentID: String) async throws -> EnvironmentCredential?
    func setCredential(_ credential: EnvironmentCredential, for environmentID: String) async throws
    func removeCredential(for environmentID: String) async throws
}

public enum CredentialStoreError: LocalizedError, Sendable {
    case keychain(OSStatus)
    case invalidData

    public var errorDescription: String? {
        switch self {
        case let .keychain(status):
            SecCopyErrorMessageString(status, nil) as String? ?? "Keychain error \(status)."
        case .invalidData:
            "The saved environment credential is invalid."
        }
    }
}

/// Access tokens are deliberately isolated from the environment catalog so
/// catalog exports and backups never contain authentication material.
public actor KeychainCredentialStore: CredentialStore {
    private let service: String
    private let accessibility: CFString

    public init(
        service: String = "codes.t3.swift-ios.environment-credentials",
        accessibility: CFString = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
    ) {
        self.service = service
        self.accessibility = accessibility
    }

    public func credential(for environmentID: String) throws -> EnvironmentCredential? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: environmentID,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess else { throw CredentialStoreError.keychain(status) }
        guard let data = item as? Data else { throw CredentialStoreError.invalidData }
        do {
            return try JSONDecoder.t3.decode(EnvironmentCredential.self, from: data)
        } catch {
            throw CredentialStoreError.invalidData
        }
    }

    public func setCredential(
        _ credential: EnvironmentCredential,
        for environmentID: String
    ) throws {
        let data = try JSONEncoder.t3.encode(credential)
        let lookup: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: environmentID,
        ]
        let attributes: [String: Any] = [
            kSecValueData as String: data,
            kSecAttrAccessible as String: accessibility,
        ]
        let updateStatus = SecItemUpdate(lookup as CFDictionary, attributes as CFDictionary)
        if updateStatus == errSecItemNotFound {
            var insertion = lookup
            attributes.forEach { insertion[$0.key] = $0.value }
            let status = SecItemAdd(insertion as CFDictionary, nil)
            guard status == errSecSuccess else { throw CredentialStoreError.keychain(status) }
        } else if updateStatus != errSecSuccess {
            throw CredentialStoreError.keychain(updateStatus)
        }
    }

    public func removeCredential(for environmentID: String) throws {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: environmentID,
        ]
        let status = SecItemDelete(query as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw CredentialStoreError.keychain(status)
        }
    }
}

public actor InMemoryCredentialStore: CredentialStore {
    private var credentials: [String: EnvironmentCredential]

    public init(credentials: [String: EnvironmentCredential] = [:]) {
        self.credentials = credentials
    }

    public func credential(for environmentID: String) -> EnvironmentCredential? {
        credentials[environmentID]
    }

    public func setCredential(
        _ credential: EnvironmentCredential,
        for environmentID: String
    ) {
        credentials[environmentID] = credential
    }

    public func removeCredential(for environmentID: String) {
        credentials.removeValue(forKey: environmentID)
    }
}

public actor EnvironmentStore {
    private struct Document: Codable {
        let version: Int
        var environments: [Environment]
        var activeEnvironmentID: String?
    }

    public let fileURL: URL

    /// Snapshot publishes read the catalog several times a second, so the
    /// decoded document is cached and invalidated by writes on this actor.
    private var cached: Document?

    public init(fileURL: URL? = nil) {
        if let fileURL {
            self.fileURL = fileURL
        } else {
            let root = FileManager.default.urls(
                for: .applicationSupportDirectory,
                in: .userDomainMask
            ).first!
            self.fileURL = root
                .appendingPathComponent("T3CodeSwift", isDirectory: true)
                .appendingPathComponent("environments.json", isDirectory: false)
        }
    }

    public func load() throws -> [Environment] {
        try loadDocument().environments
    }

    public func activeEnvironmentID() throws -> String? {
        try loadDocument().activeEnvironmentID
    }

    public func setActiveEnvironment(id: String?) throws {
        var document = try loadDocument()
        document.activeEnvironmentID = id
        try save(document)
    }

    public func save(_ environments: [Environment]) throws {
        try FileManager.default.createDirectory(
            at: fileURL.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        var document = try loadDocument()
        document.environments = environments
        try save(document)
    }

    @discardableResult
    public func upsert(_ environment: Environment) throws -> [Environment] {
        var environments = try load()
        if let index = environments.firstIndex(where: { $0.id == environment.id }) {
            environments[index] = environment
        } else {
            environments.append(environment)
        }
        try save(environments)
        return environments
    }

    /// Switches one saved environment on or off. Off moves the active
    /// selection to the next environment that is still on, so nothing keeps
    /// pointing at a server this device no longer connects to.
    @discardableResult
    public func setEnabled(id: String, enabled: Bool) throws -> [Environment] {
        var document = try loadDocument()
        guard let index = document.environments.firstIndex(where: { $0.id == id }) else {
            return document.environments
        }
        guard document.environments[index].isEnabled != enabled else {
            return document.environments
        }
        document.environments[index].isEnabled = enabled
        if !enabled, document.activeEnvironmentID == id {
            document.activeEnvironmentID = document.environments.first(where: \.isEnabled)?.id
        }
        try save(document)
        return document.environments
    }

    /// Records the result of a protocol check. An incompatible environment is
    /// switched off (and stops being the active one) with the reason kept for
    /// Settings; a compatible result clears the reason but leaves the switch
    /// to the caller. Returns the saved environment.
    @discardableResult
    public func setCompatibility(
        id: String,
        issue: EnvironmentCompatibilityIssue?
    ) throws -> Environment? {
        var document = try loadDocument()
        guard let index = document.environments.firstIndex(where: { $0.id == id }) else {
            return nil
        }
        var environment = document.environments[index]
        environment.unsupportedReason = issue?.reason
        environment.serverUpdateRequired = issue?.serverUpdateRequired ?? false
        if issue != nil {
            environment.isEnabled = false
        }
        guard environment != document.environments[index] else { return environment }
        document.environments[index] = environment
        if !environment.isEnabled, document.activeEnvironmentID == id {
            document.activeEnvironmentID = document.environments.first(where: \.isEnabled)?.id
        }
        try save(document)
        return environment
    }

    /// Saves the addresses a server reports as learned routes. Runs the merge
    /// against the saved record inside this actor so a concurrent route edit
    /// is never overwritten. Returns the new routes, or nil when nothing
    /// changed or `activeRouteID` is no longer saved.
    public func learnRoutes(
        id: String,
        activeRouteID: String,
        reported: [ServerDirectEndpoint]
    ) throws -> [EnvironmentRoute]? {
        var document = try loadDocument()
        guard let index = document.environments.firstIndex(where: { $0.id == id }),
              let active = document.environments[index].routes.first(where: { $0.id == activeRouteID }),
              let next = EnvironmentRoutes.mergingLearned(
                  into: document.environments[index].routes,
                  activeRoute: active,
                  reported: reported
              ) else {
            return nil
        }
        document.environments[index].routes = next
        try save(document)
        return next
    }

    /// Puts the saved routes in the order of `routeIDs`, which must list each
    /// once. Returns the new routes, or nil when the order is not valid.
    public func reorderRoutes(id: String, routeIDs: [String]) throws -> [EnvironmentRoute]? {
        var document = try loadDocument()
        guard let index = document.environments.firstIndex(where: { $0.id == id }),
              let next = EnvironmentRoutes.reordered(
                  document.environments[index].routes,
                  as: routeIDs
              ) else {
            return nil
        }
        guard next != document.environments[index].routes else { return next }
        document.environments[index].routes = next
        try save(document)
        return next
    }

    /// Drops one route and the learned routes that borrow its credential.
    /// Refuses to drop the last route; removing the environment does that.
    /// Returns the routes before and after, or nil when nothing was removed.
    public func removeRoute(
        id: String,
        routeID: String
    ) throws -> (removed: [EnvironmentRoute], remaining: [EnvironmentRoute])? {
        var document = try loadDocument()
        guard let index = document.environments.firstIndex(where: { $0.id == id }) else {
            return nil
        }
        let previous = document.environments[index].routes
        let remaining = EnvironmentRoutes.removing(routeID, from: previous)
        guard !remaining.isEmpty, remaining.count < previous.count else { return nil }
        document.environments[index].routes = remaining
        try save(document)
        let remainingIDs = Set(remaining.map(\.id))
        return (previous.filter { !remainingIDs.contains($0.id) }, remaining)
    }

    @discardableResult
    public func remove(id: String) throws -> [Environment] {
        var document = try loadDocument()
        document.environments.removeAll { $0.id == id }
        if document.activeEnvironmentID == id {
            document.activeEnvironmentID = document.environments.first(where: \.isEnabled)?.id
        }
        try save(document)
        return document.environments
    }

    private func loadDocument() throws -> Document {
        if let cached { return cached }
        guard FileManager.default.fileExists(atPath: fileURL.path) else {
            return Document(version: 1, environments: [], activeEnvironmentID: nil)
        }
        let data = try Data(contentsOf: fileURL)
        let document = try JSONDecoder.t3.decode(Document.self, from: data)
        cached = document
        return document
    }

    private func save(_ document: Document) throws {
        try FileManager.default.createDirectory(
            at: fileURL.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        try JSONEncoder.t3.encode(document).write(to: fileURL, options: .atomic)
        cached = document
    }
}
