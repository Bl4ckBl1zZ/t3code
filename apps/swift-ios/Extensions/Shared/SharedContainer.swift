import Foundation

enum T3SharedContainer {
    // Must match T3CODE_APP_GROUP_IDENTIFIER and T3CODE_URL_SCHEME in the Xcode
    // project and the $(...) references in the .entitlements files. Identity
    // lives in three places; changing only some breaks the share extension and
    // deep links silently, so ExtensionContractTests asserts they agree.
    #if DEBUG
    static let appGroupID = "group.com.bl4ckbl1zz.t3code.dev.debug"
    static let urlScheme = "t3code-debug"
    #else
    static let appGroupID = "group.com.bl4ckbl1zz.t3code.dev"
    static let urlScheme = "t3code"
    #endif

    static var rootURL: URL? {
        FileManager.default.containerURL(
            forSecurityApplicationGroupIdentifier: appGroupID
        )
    }
}
