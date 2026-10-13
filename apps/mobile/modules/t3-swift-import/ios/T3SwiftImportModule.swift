import ExpoModulesCore
import Foundation
import Security

/// Reads what the SwiftUI T3 Code client saved, for an app that replaces it
/// under the same bundle id: the environment catalog file and the per-route
/// credentials it kept in the Keychain. Read-only; the Swift data stays put.
///
/// Both clients share an App ID, so the Swift items sit in this app's default
/// keychain access group and a query without an explicit group finds them.
/// `expo-secure-store` cannot read them: it always matches on a generic
/// attribute the Swift client never set.
public class T3SwiftImportModule: Module {
  /// `KeychainCredentialStore` in the Swift client: one generic password per
  /// credential, account = credential id, data = JSON `EnvironmentCredential`.
  static let credentialService = "codes.t3.swift-ios.environment-credentials"

  public func definition() -> ModuleDefinition {
    Name("T3SwiftImport")

    /// `{ catalog?: string, credentials: { [credentialId]: string } }`, or
    /// `catalog` absent when the Swift client never saved one. Throws when the
    /// Keychain cannot be read yet (before first unlock), so the caller retries.
    AsyncFunction("readSavedEnvironments") { () -> [String: Any] in
      guard let catalog = try Self.readCatalog() else {
        return ["credentials": [String: String]()]
      }
      return ["catalog": catalog, "credentials": try Self.readCredentials()]
    }
  }

  /// `EnvironmentStore` in the Swift client.
  private static func readCatalog() throws -> String? {
    guard
      let root = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)
        .first
    else { return nil }
    let url = root.appendingPathComponent("T3CodeSwift/environments.json", isDirectory: false)
    guard FileManager.default.fileExists(atPath: url.path) else { return nil }
    return String(bytes: try Data(contentsOf: url), encoding: .utf8)
  }

  private static func readCredentials() throws -> [String: String] {
    let query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: credentialService,
      kSecMatchLimit as String: kSecMatchLimitAll,
      kSecReturnAttributes as String: true,
      kSecReturnData as String: true,
    ]
    var result: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &result)
    if status == errSecItemNotFound { return [:] }
    guard status == errSecSuccess else {
      throw Exception(
        name: "SwiftImportKeychainError",
        description: "Reading saved Swift credentials failed with status \(status)."
      )
    }

    var credentials: [String: String] = [:]
    for item in result as? [[String: Any]] ?? [] {
      let account =
        item[kSecAttrAccount as String] as? String
        ?? (item[kSecAttrAccount as String] as? Data).flatMap { String(bytes: $0, encoding: .utf8) }
      guard let account, let data = item[kSecValueData as String] as? Data,
        let credential = String(bytes: data, encoding: .utf8)
      else { continue }
      credentials[account] = credential
    }
    return credentials
  }
}
