import XCTest

@testable import T3Code

/// Ports packages/client-runtime/src/providerSkills.test.ts.
final class ProviderSkillSourceTests: XCTestCase {
    func testMarksPluginBackedSkillsAsAppInstalls() {
        // Under the user's home directory, so the scope alone would say
        // "personal" — the plugin path has to outrank it.
        XCTAssertEqual(
            ProviderSkillSource.kind(
                path: "/Users/julius/.codex/plugins/cache/openai-curated/github/skills/gh-fix-ci/SKILL.md",
                scope: "user"
            ),
            .app
        )
        XCTAssertEqual(
            ProviderSkillSource.kind(
                path: "/Users/julius/.agents/plugins/mattpocock/skills/tdd/SKILL.md",
                scope: "user"
            ),
            .app
        )
    }

    func testMapsStandardScopesToSourceKinds() {
        XCTAssertEqual(
            ProviderSkillSource.kind(
                path: "/workspace/.codex/skills/review-follow-up/SKILL.md",
                scope: "repo"
            ),
            .repo
        )
        XCTAssertEqual(
            ProviderSkillSource.kind(
                path: "/workspace/.codex/skills/review-follow-up/SKILL.md",
                scope: "project"
            ),
            .project
        )
        XCTAssertEqual(
            ProviderSkillSource.kind(
                path: "/Users/julius/.agents/skills/agent-browser/SKILL.md",
                scope: "user"
            ),
            .personal
        )
        XCTAssertEqual(
            ProviderSkillSource.kind(
                path: "/usr/local/share/codex/skills/imagegen/SKILL.md",
                scope: "system"
            ),
            .system
        )
    }

    func testKeepsUnknownAndMissingScopesUsable() {
        XCTAssertEqual(
            ProviderSkillSource.kind(path: "/opt/skills/team-review/SKILL.md", scope: "team_shared"),
            .other
        )
        XCTAssertEqual(
            ProviderSkillSource.kind(path: "/opt/skills/team-review/SKILL.md", scope: nil),
            .other
        )
        XCTAssertEqual(
            ProviderSkillSource.kind(path: "/opt/skills/team-review/SKILL.md", scope: "  "),
            .other
        )
    }

    func testNormalisesScopeCasingAndWindowsSeparators() {
        XCTAssertEqual(
            ProviderSkillSource.kind(path: "/workspace/skills/a/SKILL.md", scope: " Repository "),
            .repo
        )
        XCTAssertEqual(
            ProviderSkillSource.kind(
                path: #"C:\Users\julius\.codex\plugins\cache\gh\skills\fix\SKILL.md"#,
                scope: "user"
            ),
            .app
        )
    }

    /// An unrecognised scope keeps the crate the popover already showed, so the
    /// row never renders an empty icon slot.
    func testUnknownSourceKeepsTheOriginalSymbol() {
        XCTAssertEqual(ProviderSkillSource.symbolName(for: .other), "shippingbox")
        for kind in ProviderSkillSourceKind.allCases {
            XCTAssertFalse(ProviderSkillSource.symbolName(for: kind).isEmpty)
        }
    }

    func testSkillModelExposesItsSourceSymbol() {
        let skill = FeatureProviderSkill(
            name: "gh-fix-ci",
            path: "/Users/julius/.codex/plugins/cache/openai-curated/github/skills/gh-fix-ci/SKILL.md",
            scope: "user"
        )
        XCTAssertEqual(skill.sourceKind, .app)
        XCTAssertEqual(skill.sourceSymbolName, "square.grid.2x2")
    }
}
