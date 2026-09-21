import Foundation
import Testing
@testable import T3Code

@Suite("Native project creation")
struct ProjectCreationModelsTests {
    @Test
    func repositoryNamesCoverHttpsSshAndProviderPaths() {
        #expect(
            ProjectCreationPath.repositoryName(
                from: "https://github.com/pingdotgg/t3code.git"
            ) == "t3code"
        )
        #expect(
            ProjectCreationPath.repositoryName(
                from: "git@github.com:pingdotgg/t3code.git"
            ) == "t3code"
        )
        #expect(ProjectCreationPath.repositoryName(from: "pingdotgg/t3code") == "t3code")
        #expect(ProjectCreationPath.repositoryName(from: "") == "repository")
    }

    @Test
    func pathsRequireServerAbsoluteOrHomeRelativeInput() throws {
        #expect(try ProjectCreationPath.validated(" ~/work/t3code ").get() == "~/work/t3code")
        #expect(try ProjectCreationPath.validated("/srv/t3code").get() == "/srv/t3code")
        #expect(try ProjectCreationPath.validated(#"C:\work\t3code"#).get() == #"C:\work\t3code"#)
        #expect(ProjectCreationPath.validated("relative/project").isFailure)
        #expect(ProjectCreationPath.validated("  ").isFailure)
    }

    @Test
    func destinationSuggestionsRespectUnixAndWindowsSeparators() {
        #expect(ProjectCreationPath.appending("t3code", to: "~/work") == "~/work/t3code")
        #expect(ProjectCreationPath.appending("t3code", to: "~/work/") == "~/work/t3code")
        #expect(
            ProjectCreationPath.appending("t3code", to: #"C:\work"#) == #"C:\work\t3code"#
        )
        #expect(
            ProjectCreationPath.normalizedForComparison(#"C:\Work\T3Code\"#)
                == "c:/work/t3code"
        )
        #expect(ProjectCreationPath.normalizedForComparison("/srv/App") == "/srv/App")
        #expect(ProjectCreationPath.normalizedForComparison(#"/srv/a\b"#) == #"/srv/a\b"#)
    }

    @Test
    func folderBrowseQueriesNavigateDirectoriesInsteadOfPrefixSearching() {
        #expect(ProjectCreationPath.directoryBrowsePath("~/work") == "~/work/")
        #expect(ProjectCreationPath.directoryBrowsePath("/srv/t3code/") == "/srv/t3code/")
        #expect(
            ProjectCreationPath.directoryBrowsePath(#"C:\work\t3code"#)
                == #"C:\work\t3code\"#
        )

        #expect(ProjectCreationPath.parentBrowsePath(of: "~/work/t3code/") == "~/work/")
        #expect(ProjectCreationPath.parentBrowsePath(of: "~/") == nil)
        #expect(ProjectCreationPath.parentBrowsePath(of: "/srv/t3code/") == "/srv/")
        #expect(ProjectCreationPath.parentBrowsePath(of: "/") == nil)
        #expect(
            ProjectCreationPath.parentBrowsePath(of: #"C:\work\t3code\"#)
                == #"C:\work\"#
        )
        #expect(ProjectCreationPath.parentBrowsePath(of: #"C:\"#) == nil)
        #expect(
            ProjectCreationPath.parentBrowsePath(of: #"\\server\share\folder\"#)
                == #"\\server\share\"#
        )
        #expect(ProjectCreationPath.parentBrowsePath(of: #"\\server\share\"#) == nil)
        #expect(
            ProjectCreationPath.directoryBrowsePath("//server/share/folder")
                == #"\\server\share\folder\"#
        )
    }

    @Test
    func projectTitlesHandleServerPathStyles() {
        #expect(ProjectCreationPath.lastPathComponent("/srv/t3code/") == "t3code")
        #expect(ProjectCreationPath.lastPathComponent(#"C:\work\t3code\"#) == "t3code")
        #expect(ProjectCreationPath.lastPathComponent(#"\\server\share\t3code"#) == "t3code")
    }

    @Test
    func explicitPathsMatchTheConnectedServerFilesystemStyle() {
        #expect(
            ProjectCreationPath.isCompatibleWithServerPath(
                "/srv/t3code",
                serverPath: "/srv"
            )
        )
        #expect(
            !ProjectCreationPath.isCompatibleWithServerPath(
                #"C:\work\t3code"#,
                serverPath: "/srv"
            )
        )
        #expect(
            ProjectCreationPath.isCompatibleWithServerPath(
                #"C:\work\t3code"#,
                serverPath: #"C:\work"#
            )
        )
        #expect(
            ProjectCreationPath.isCompatibleWithServerPath(
                "//server/share/t3code",
                serverPath: #"C:\work"#
            )
        )
        #expect(
            !ProjectCreationPath.isCompatibleWithServerPath(
                "/srv/t3code",
                serverPath: #"C:\work"#
            )
        )
        #expect(
            ProjectCreationPath.isCompatibleWithServerPath(
                "~/work/t3code",
                serverPath: #"C:\Users\theo"#
            )
        )
    }

    @Test
    func discoveryKeepsGitUrlReadyAndGatesProviderAuthentication() {
        let discovery = SourceControlDiscoveryResult(
            versionControlSystems: [],
            sourceControlProviders: [
                SourceControlProviderDiscoveryItem(
                    kind: .github,
                    label: "GitHub",
                    status: .available,
                    version: "2.76",
                    installHint: "Install gh",
                    auth: SourceControlProviderAuth(
                        status: .authenticated,
                        account: "octocat"
                    )
                ),
                SourceControlProviderDiscoveryItem(
                    kind: .gitlab,
                    label: "GitLab",
                    status: .available,
                    installHint: "Install glab",
                    auth: SourceControlProviderAuth(
                        status: .unauthenticated,
                        detail: "Run glab auth login"
                    )
                ),
            ]
        )

        let options = ProjectRemoteSourceOptions.options(discovery: discovery)
        let bySource = Dictionary(uniqueKeysWithValues: options.map { ($0.source, $0) })

        #expect(bySource[.url]?.isReady == true)
        #expect(bySource[.github]?.isReady == true)
        #expect(bySource[.github]?.detail == "Signed in as octocat")
        #expect(bySource[.gitlab]?.isReady == false)
        #expect(bySource[.gitlab]?.detail == "Run glab auth login")
        #expect(bySource[.bitbucket]?.isReady == false)
    }

    @Test
    func pathIssuesExplainWhyAPathCannotBeAddedYet() {
        let projects = [
            FeatureProject(id: "p1", environmentID: "mac", name: "api-server", path: "/srv/api-server"),
            FeatureProject(id: "p2", environmentID: "linux", name: "web", path: "/srv/web"),
        ]
        func issue(_ path: String, serverPath: String? = "/srv") -> ProjectPathIssue? {
            ProjectCreationPath.issue(
                for: path,
                serverPath: serverPath,
                environmentID: "mac",
                projects: projects
            )
        }

        #expect(issue("  ") == .empty)
        #expect(issue("relative/project") == .malformed("Use an absolute path, or start with ~/."))
        #expect(issue(#"C:\work\t3code"#) == .foreignFilesystem)
        #expect(issue(#"C:\work\t3code"#, serverPath: nil) == nil)
        #expect(issue("/srv/api-server/") == .alreadyUsed(projectName: "api-server"))
        // Another environment's project doesn't claim this machine's folder.
        #expect(issue("/srv/web") == nil)
        #expect(issue("~/work/t3code") == nil)
    }

    @Test
    func addProjectCommitFollowsModeLookupAndClonedCopy() {
        #expect(AddProjectCommit.folder(pathIssue: nil) == .init(title: "Add", isEnabled: true))
        #expect(AddProjectCommit.folder(pathIssue: .empty).isEnabled == false)

        let providerUnresolved = AddProjectCommit.clone(
            remoteURL: "pingdotgg/t3code",
            needsLookup: true,
            destinationIssue: nil,
            hasClonedCopy: false
        )
        #expect(providerUnresolved == .init(title: "Clone", isEnabled: false))

        let gitURLReady = AddProjectCommit.clone(
            remoteURL: "git@github.com:pingdotgg/t3code.git",
            needsLookup: false,
            destinationIssue: nil,
            hasClonedCopy: false
        )
        #expect(gitURLReady == .init(title: "Clone", isEnabled: true))

        let missingRemote = AddProjectCommit.clone(
            remoteURL: "",
            needsLookup: false,
            destinationIssue: nil,
            hasClonedCopy: false
        )
        #expect(missingRemote.isEnabled == false)

        let destinationTaken = AddProjectCommit.clone(
            remoteURL: "git@github.com:pingdotgg/t3code.git",
            needsLookup: false,
            destinationIssue: .alreadyUsed(projectName: "t3code"),
            hasClonedCopy: false
        )
        #expect(destinationTaken.isEnabled == false)

        let registrationRetry = AddProjectCommit.clone(
            remoteURL: "git@github.com:pingdotgg/t3code.git",
            needsLookup: false,
            destinationIssue: nil,
            hasClonedCopy: true
        )
        #expect(registrationRetry == .init(title: "Finish Adding", isEnabled: true))
    }
}

private extension Result {
    var isFailure: Bool {
        if case .failure = self { return true }
        return false
    }
}
