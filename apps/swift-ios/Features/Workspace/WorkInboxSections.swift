import SwiftUI

// Ported from apps/mobile/src/features/threads/threadListV2.ts
// (`withWorkSectionHeaders` and `WORK_SECTIONS`) together with the divider it
// renders, apps/mobile/src/features/threads/thread-list-v2-items.tsx's
// `ThreadListV2SectionDivider`.
//
// T3 Work splits the one active block into Main / Needs you / Active. T3 Code
// keeps a single undifferentiated block, so this runs only in Work — and only
// over the active rows: the snoozed and settled shelves below stay whole,
// because parked work is not inbox work no matter who it is waiting on.

/// A Work inbox divider: a label plus a rule.
public struct WorkInboxSectionHeader: Identifiable, Equatable, Sendable {
    /// `attention` marks blocked-on-you work, matching the web work inbox. It
    /// is the only tone that earns colour; the rest are quiet dividers, because
    /// three loud labels would mark nothing.
    public enum Tone: String, Equatable, Sendable {
        case standard
        case attention
    }

    public let section: MobileWorkInboxSection
    public let label: String
    public let tone: Tone

    /// Matches the React Native list key so the two clients' rows correspond
    /// one-to-one when a layout is compared across them.
    public var id: String { "v2-work-section:\(section.rawValue)" }

    public init(section: MobileWorkInboxSection, label: String, tone: Tone) {
        self.section = section
        self.label = label
        self.tone = tone
    }
}

/// One section's header and the rows under it. Never empty: an empty inbox
/// stays quiet rather than showing three bare labels.
public struct WorkInboxGroup<Row: Equatable>: Equatable {
    public let header: WorkInboxSectionHeader
    public let rows: [Row]

    public init(header: WorkInboxSectionHeader, rows: [Row]) {
        self.header = header
        self.rows = rows
    }
}

public enum WorkInboxSections {
    public static func header(for section: MobileWorkInboxSection) -> WorkInboxSectionHeader {
        switch section {
        case .main:
            WorkInboxSectionHeader(section: .main, label: "Main", tone: .standard)
        case .needsYou:
            WorkInboxSectionHeader(section: .needsYou, label: "Needs you", tone: .attention)
        case .active:
            WorkInboxSectionHeader(section: .active, label: "Active", tone: .standard)
        }
    }

    /// Inbox order: the pinned Main thread, then what is blocked on you, then
    /// everything else.
    public static let ordered: [WorkInboxSectionHeader] = [
        header(for: .main),
        header(for: .needsYou),
        header(for: .active),
    ]

    /// Splits an already-ordered active block into the Work sections, keeping
    /// each section's rows in the order they arrived.
    ///
    /// Sections with no rows are omitted entirely — including their header.
    public static func groups<Row: Equatable>(
        active rows: [Row],
        section: (Row) -> MobileWorkInboxSection
    ) -> [WorkInboxGroup<Row>] {
        ordered.compactMap { header in
            let matching = rows.filter { section($0) == header.section }
            guard !matching.isEmpty else { return nil }
            return WorkInboxGroup(header: header, rows: matching)
        }
    }

    /// Which section a Home row belongs to.
    ///
    /// `workInboxRole` is a parameter because `FeatureThread` does not carry it
    /// — see ``WorkspaceSwitcher/workspaceThread(_:environmentID:workInboxRole:relationshipToParent:)``.
    /// Passing `nil` puts every row in Needs you / Active, which is the right
    /// answer for a server that has no Main thread and the wrong one for a
    /// server that does, so the caller has to say.
    public static func section(
        of thread: FeatureThread,
        workInboxRole: String? = nil
    ) -> MobileWorkInboxSection {
        MobileWorkspaceRouting.workInboxSection(
            WorkspaceSwitcher.workspaceThread(thread, workInboxRole: workInboxRole)
        )
    }

    public static func groups(
        active threads: [FeatureThread],
        workInboxRole: (FeatureThread) -> String? = { _ in nil }
    ) -> [WorkInboxGroup<FeatureThread>] {
        groups(active: threads) { section(of: $0, workInboxRole: workInboxRole($0)) }
    }
}

/// The Work inbox divider. Sized and weighted like ``HomeShelfHeader`` so the
/// two kinds of structure in the sidebar read as one system, but it is not a
/// disclosure control: a Work section cannot be collapsed.
struct WorkInboxSectionDivider: View {
    let header: WorkInboxSectionHeader

    var body: some View {
        HStack(spacing: 10) {
            Text(header.label)
                .lineLimit(1)
            Rectangle()
                .fill(ruleColor)
                .frame(height: 1)
        }
        .font(T3Typography.homeMetadata.weight(.medium))
        .foregroundStyle(labelColor)
        .padding(.horizontal, 12)
        .padding(.top, 12)
        .padding(.bottom, 4)
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isHeader)
        .accessibilityLabel(header.label)
    }

    /// `warning` is the theme's amber. The React Native divider names the same
    /// hue through Tailwind (`amber-600` / `amber-400`); naming it through the
    /// token keeps it following appearance changes with everything else.
    private var labelColor: Color {
        switch header.tone {
        case .attention: T3Colors.warning
        case .standard: T3Colors.textTertiary
        }
    }

    private var ruleColor: Color {
        switch header.tone {
        case .attention: T3Colors.warning.opacity(0.2)
        case .standard: T3Colors.border
        }
    }
}
