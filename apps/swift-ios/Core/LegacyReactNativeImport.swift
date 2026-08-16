import Foundation
import Security

/// One-time import of the React Native client's saved servers.
///
/// This app takes over `com.t3code.dev` from the React Native client, so an
/// update lands on top of an existing install. Same bundle identifier means the
/// same Keychain access, but the two clients store their state completely
/// differently — RN writes a single JSON catalog through `expo-secure-store`,
/// this app writes credentials per environment plus a separate catalog file in
/// Application Support. Without this import every tester would update straight
/// into onboarding and have to re-pair every server.
///
/// The RN keys are read, never deleted: leaving them in place keeps a rollback
/// to the React Native build possible for one release.
public enum LegacyReactNativeImport {
    /// `expo-secure-store` stores each value as a generic password whose service
    /// is the `keychainService` option, defaulting to `"app"`. The mobile client
    /// never passed one. See `expo-secure-store/ios/SecureStoreModule.swift`.
    public static let legacyKeychainService = "app"
    public static let catalogKey = "t3code.connection-catalog.v1"

    public struct ImportedEnvironment: Equatable, Sendable {
        public let environment: Environment
        /// Absent when the catalog listed a server whose credential entry was
        /// missing. The server is still imported so the user can re-pair it in
        /// place rather than adding it from scratch.
        public let accessToken: String?
    }

    // MARK: - Reading the legacy catalog

    /// Reads a value written by `expo-secure-store`.
    ///
    /// The account and the generic attribute are both the UTF-8 bytes of the
    /// key, which is why this cannot use the plain string form.
    public static func legacyValue(
        forKey key: String,
        service: String = legacyKeychainService
    ) -> Data? {
        let encodedKey = Data(key.utf8)
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrGeneric as String: encodedKey,
            kSecAttrAccount as String: encodedKey,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]

        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess else {
            return nil
        }
        return item as? Data
    }

    /// Maps the RN catalog onto this app's environment model.
    ///
    /// Only directly-paired (bearer) servers are imported, because only they
    /// carry a profile with URLs and a token. Relay servers are deliberately
    /// skipped: they are rediscovered from the relay after T3 Connect sign-in,
    /// and importing one as bearer would leave a row that can never connect.
    public static func environments(fromCatalog data: Data) -> [ImportedEnvironment] {
        guard
            let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else { return [] }

        let profiles = (root["profiles"] as? [[String: Any]]) ?? []
        let credentials = (root["credentials"] as? [[String: Any]]) ?? []

        var tokensByConnectionID: [String: String] = [:]
        for entry in credentials {
            guard
                let connectionID = entry["connectionId"] as? String,
                let credential = entry["credential"] as? [String: Any],
                let token = credential["token"] as? String
            else { continue }
            tokensByConnectionID[connectionID] = token
        }

        var imported: [ImportedEnvironment] = []
        var seen: Set<String> = []
        for profile in profiles {
            guard
                profile["_tag"] as? String == "BearerConnectionProfile",
                let environmentID = profile["environmentId"] as? String,
                let connectionID = profile["connectionId"] as? String,
                let httpBaseURLString = profile["httpBaseUrl"] as? String,
                let webSocketBaseURLString = profile["wsBaseUrl"] as? String,
                let httpBaseURL = URL(string: httpBaseURLString),
                let webSocketBaseURL = URL(string: webSocketBaseURLString),
                !seen.contains(environmentID)
            else { continue }
            seen.insert(environmentID)

            imported.append(
                ImportedEnvironment(
                    environment: Environment(
                        id: environmentID,
                        label: (profile["label"] as? String) ?? httpBaseURL.host ?? environmentID,
                        httpBaseURL: httpBaseURL,
                        webSocketBaseURL: webSocketBaseURL,
                        kind: .bearer
                    ),
                    accessToken: tokensByConnectionID[connectionID]
                )
            )
        }
        return imported
    }

    // MARK: - Running the import

    public enum Outcome: Equatable, Sendable {
        /// The catalog already had servers, so nothing was touched.
        case skippedExistingCatalog
        case noLegacyData
        case imported(count: Int)
    }

    /// Imports the React Native servers when this app has none of its own.
    ///
    /// Guarded on an empty catalog rather than on a "did migrate" flag: the
    /// guard then also covers a reinstall, and it can never overwrite servers
    /// the user added in this app.
    @discardableResult
    public static func run(
        environmentStore: EnvironmentStore,
        credentialStore: any CredentialStore,
        readCatalog: () -> Data? = { legacyValue(forKey: catalogKey) }
    ) async -> Outcome {
        guard let existing = try? await environmentStore.load(), existing.isEmpty else {
            return .skippedExistingCatalog
        }
        guard let data = readCatalog() else { return .noLegacyData }

        let imported = environments(fromCatalog: data)
        guard !imported.isEmpty else { return .noLegacyData }

        // Credentials are written before the catalog so a failure part-way
        // leaves the catalog empty and the import simply runs again, rather
        // than listing servers that cannot authenticate.
        for entry in imported {
            guard let accessToken = entry.accessToken else { continue }
            try? await credentialStore.setCredential(
                EnvironmentCredential(accessToken: accessToken),
                for: entry.environment.id
            )
        }

        do {
            try await environmentStore.save(imported.map(\.environment))
        } catch {
            return .noLegacyData
        }
        return .imported(count: imported.count)
    }
}
