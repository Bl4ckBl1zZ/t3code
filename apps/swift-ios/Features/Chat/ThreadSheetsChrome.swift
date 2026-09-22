import SwiftUI

// Chrome shared by the thread's sheets: Details, Linked Pull Requests, pull
// request detail and its pickers, and checkpoint restore. One badge, one tone
// palette and one banner, so a merged pull request or a failed restore reads
// the same on every screen that shows it.

// MARK: - Sheet background

extension View {
    /// Partial-detent sheets float as glass on iOS 26, so nothing is painted
    /// over it there. Earlier systems have no glass sheet and get the palette's
    /// sheet color instead of the system gray.
    @ViewBuilder
    func t3GlassSheetBackground() -> some View {
        if #available(iOS 26, *) {
            self
        } else {
            presentationBackground(T3Colors.sheet)
        }
    }

    /// An inset-grouped list inside a glass sheet: rows keep the palette's
    /// surface, and the space between them is the sheet itself.
    func t3SheetList() -> some View {
        listStyle(.insetGrouped)
            .scrollContentBackground(.hidden)
    }
}

// MARK: - Pull request state

extension PullRequestStatusTone {
    /// The palette color for a tone. Logic names the meaning; this is the one
    /// place that decides what green is.
    var color: Color {
        switch self {
        case .success: T3Colors.success
        case .danger: T3Colors.danger
        case .warning: T3Colors.warning
        case .accent: T3Colors.accent
        case .merged: T3Colors.syntaxKeyword
        case .neutral: T3Colors.textTertiary
        }
    }
}

/// A change request's state as a tinted capsule: Open green, Draft gray,
/// Merged purple, Closed red. Every pull-request surface draws this one.
struct PullRequestStateBadge: View {
    let label: String
    let symbol: String
    let tone: PullRequestStatusTone

    init(state: PullRequestState, isDraft: Bool) {
        label = PullRequestDetailSections.stateLabel(state: state, isDraft: isDraft)
        symbol = PullRequestDetailSections.stateSymbol(state: state, isDraft: isDraft)
        tone = PullRequestDetailSections.stateTone(state: state, isDraft: isDraft)
    }

    /// A persisted link has no state until the host has answered for it.
    init(snapshot: FeaturePullRequestSnapshot?) {
        guard let snapshot, let state = PullRequestState(rawValue: snapshot.state) else {
            label = "Waiting for Host"
            symbol = "clock"
            tone = .neutral
            return
        }
        label = PullRequestDetailSections.stateLabel(state: state, isDraft: snapshot.isDraft)
        symbol = PullRequestDetailSections.stateSymbol(state: state, isDraft: snapshot.isDraft)
        tone = PullRequestDetailSections.stateTone(state: state, isDraft: snapshot.isDraft)
    }

    var body: some View {
        HStack(spacing: 4) {
            Image(symbol: symbol)
                .imageScale(.small)
            Text(label)
                .lineLimit(1)
        }
        .font(T3Typography.supportingStrong)
        .foregroundStyle(tone.color)
        .padding(.horizontal, 8)
        .padding(.vertical, 2)
        .background(tone.color.opacity(0.14), in: Capsule())
        .fixedSize()
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(label)
    }
}

/// A person or team on a pull request: the host's avatar where it sent one,
/// otherwise their initials. Shared by the reviewer picker, the Reviewers
/// section and the timeline so one person looks the same everywhere.
struct PullRequestAvatar: View {
    let login: String
    var avatarURL: String?
    var isTeam = false
    @ScaledMetric(relativeTo: .body) private var size: CGFloat = 28

    private var url: URL? {
        guard let value = avatarURL.flatMap(URL.init(string:)),
              ["https", "http"].contains(value.scheme?.lowercased() ?? "") else { return nil }
        return value
    }

    var body: some View {
        AsyncImage(url: url) { phase in
            if let image = phase.image {
                image.resizable().scaledToFill()
            } else {
                ZStack {
                    Circle().fill(T3Colors.subtleStrong)
                    if isTeam {
                        Image(systemName: "person.3.fill")
                            .font(.system(size: size * 0.4))
                    } else {
                        Text(login.prefix(2).uppercased())
                            .font(.system(size: size * 0.38, weight: .semibold))
                    }
                }
                .foregroundStyle(T3Colors.textSecondary)
            }
        }
        .frame(width: size, height: size)
        .clipShape(Circle())
        .accessibilityHidden(true)
    }
}

/// A host label's color, from the six-digit hex the host reports.
enum PullRequestLabelColor {
    static func color(_ hex: String?) -> Color? {
        guard let hex, hex.count == 6, let value = UInt32(hex, radix: 16) else { return nil }
        return Color(
            red: Double((value >> 16) & 255) / 255,
            green: Double((value >> 8) & 255) / 255,
            blue: Double(value & 255) / 255
        )
    }
}

/// A label's color dot. The hairline keeps a host color such as `000000`
/// visible on a dark palette.
struct PullRequestLabelSwatch: View {
    let hex: String?

    var body: some View {
        Circle()
            .fill(PullRequestLabelColor.color(hex) ?? T3Colors.textTertiary)
            .overlay(Circle().strokeBorder(T3Colors.textTertiary.opacity(0.5), lineWidth: 0.5))
            .frame(width: 10, height: 10)
            .accessibilityHidden(true)
    }
}

/// A label as a chip: its color dot and name on a neutral capsule, so the
/// text keeps contrast whatever color the host chose.
struct PullRequestLabelChip: View {
    let label: PullRequestLabel

    var body: some View {
        HStack(spacing: 5) {
            PullRequestLabelSwatch(hex: label.color)
            Text(label.name).lineLimit(1)
        }
        .font(T3Typography.supporting)
        .foregroundStyle(T3Colors.textPrimary)
        .padding(.horizontal, 10)
        .padding(.vertical, 4)
        .background(T3Colors.subtle, in: Capsule())
    }
}

/// Lays chips out left to right and wraps them onto new lines.
struct PullRequestChipFlow: Layout {
    var spacing: CGFloat = 6

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache _: inout ()) -> CGSize {
        let rows = arrange(width: proposal.width ?? .infinity, subviews: subviews)
        let width = rows.map(\.width).max() ?? 0
        let height = rows.map(\.height).reduce(0, +) + spacing * CGFloat(max(0, rows.count - 1))
        return CGSize(width: width, height: height)
    }

    func placeSubviews(in bounds: CGRect, proposal _: ProposedViewSize, subviews: Subviews, cache _: inout ()) {
        var y = bounds.minY
        for row in arrange(width: bounds.width, subviews: subviews) {
            var x = bounds.minX
            for index in row.indices {
                let size = subviews[index].sizeThatFits(.unspecified)
                subviews[index].place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(size))
                x += size.width + spacing
            }
            y += row.height + spacing
        }
    }

    private struct Row {
        var indices: [Int] = []
        var width: CGFloat = 0
        var height: CGFloat = 0
    }

    private func arrange(width: CGFloat, subviews: Subviews) -> [Row] {
        var rows: [Row] = []
        var current = Row()
        for index in subviews.indices {
            let size = subviews[index].sizeThatFits(.unspecified)
            let proposed = current.indices.isEmpty ? size.width : current.width + spacing + size.width
            if proposed > width, !current.indices.isEmpty {
                rows.append(current)
                current = Row()
            }
            current.width = current.indices.isEmpty ? size.width : current.width + spacing + size.width
            current.height = max(current.height, size.height)
            current.indices.append(index)
        }
        if !current.indices.isEmpty { rows.append(current) }
        return rows
    }
}

/// A card of rows inside a scroll view, for screens that pin a header and so
/// cannot be a `List`. Drawn like an inset-grouped section: Title Case header,
/// surface fill, footer below.
struct ThreadSheetCard<Content: View, Footer: View>: View {
    var title: String?
    @ViewBuilder var content: Content
    @ViewBuilder var footer: Footer

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if let title {
                Text(title)
                    .font(T3Typography.supporting)
                    .foregroundStyle(T3Colors.textSecondary)
                    .padding(.horizontal, 16)
                    .accessibilityAddTraits(.isHeader)
            }
            VStack(alignment: .leading, spacing: 0) {
                content
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(T3Colors.surface, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
            if Footer.self != EmptyView.self {
                footer
                    .font(T3Typography.supporting)
                    .foregroundStyle(T3Colors.textTertiary)
                    .padding(.horizontal, 16)
            }
        }
    }
}

extension ThreadSheetCard where Footer == EmptyView {
    init(title: String? = nil, @ViewBuilder content: () -> Content) {
        self.init(title: title, content: content, footer: { EmptyView() })
    }
}

/// One row inside a `ThreadSheetCard`, with the inset hairline above it that
/// a grouped list would draw.
struct ThreadSheetCardRow<Content: View>: View {
    var showsDivider = true
    var dividerInset: CGFloat = 16
    @ViewBuilder var content: Content

    var body: some View {
        VStack(spacing: 0) {
            if showsDivider {
                Rectangle()
                    .fill(T3Colors.separator)
                    .frame(height: 0.5)
                    .padding(.leading, dividerInset)
                    .accessibilityHidden(true)
            }
            content
                .padding(.horizontal, 16)
                .padding(.vertical, 10)
                .frame(maxWidth: .infinity, minHeight: T3Metrics.minimumTapTarget, alignment: .leading)
        }
    }
}

// MARK: - Banner

/// How loud a banner is. Red only for failures; a wait the reader can act on
/// is a warning.
enum ThreadSheetBannerTone {
    case warning, error

    var tint: Color { self == .error ? T3Colors.danger : T3Colors.warning }

    /// The fill behind a banner, as a list row background or a card.
    var fill: Color { tint.opacity(0.12) }

    var symbol: String { self == .error ? "exclamationmark.octagon.fill" : "exclamationmark.triangle.fill" }
}

/// A problem stated at the top of a sheet, with the action that fixes it.
struct ThreadSheetBanner<Actions: View>: View {
    let tone: ThreadSheetBannerTone
    let title: String
    var message: String?
    @ViewBuilder var actions: Actions

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            Image(systemName: tone.symbol)
                .foregroundStyle(tone.tint)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 4) {
                Text(title)
                    .font(T3Typography.supportingStrong)
                    .foregroundStyle(T3Colors.textPrimary)
                if let message, !message.isEmpty {
                    Text(message)
                        .font(T3Typography.supporting)
                        .foregroundStyle(T3Colors.textSecondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                if Actions.self != EmptyView.self {
                    // Side by side while they fit; stacked at accessibility
                    // sizes rather than clipped.
                    ViewThatFits(in: .horizontal) {
                        HStack(spacing: 8) { actions }
                        VStack(alignment: .leading, spacing: 8) { actions }
                    }
                    .buttonStyle(.bordered)
                    .tint(T3Colors.textPrimary)
                    .padding(.top, 4)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .accessibilityElement(children: .contain)
    }
}

extension ThreadSheetBanner where Actions == EmptyView {
    init(tone: ThreadSheetBannerTone, title: String, message: String? = nil) {
        self.init(tone: tone, title: title, message: message) { EmptyView() }
    }
}

// MARK: - Rows

/// A navigation or action row's label in a grouped list: a Settings tile, the
/// title with an optional second line, and a trailing value.
///
/// Built on `LabeledContent`, so at accessibility sizes the value drops below
/// the title instead of squeezing it.
struct ThreadSheetRowLabel<Value: View>: View {
    let title: String
    var subtitle: String?
    var monospacedSubtitle = false
    let systemImage: String
    let tint: T3SettingsTile.Tint
    var titleColor: Color = T3Colors.textPrimary
    @ViewBuilder var value: Value

    var body: some View {
        LabeledContent {
            value
                .font(T3Typography.threadBody)
                .foregroundStyle(T3Colors.textSecondary)
        } label: {
            Label {
                VStack(alignment: .leading, spacing: 2) {
                    Text(title)
                        .font(T3Typography.threadBody)
                        .foregroundStyle(titleColor)
                    if let subtitle, !subtitle.isEmpty {
                        Text(subtitle)
                            .font(monospacedSubtitle ? T3Typography.tool : T3Typography.supporting)
                            .foregroundStyle(T3Colors.textTertiary)
                            .lineLimit(2)
                            .truncationMode(.middle)
                    }
                }
            } icon: {
                T3SettingsTile(systemImage, tint: tint)
            }
        }
    }
}

extension ThreadSheetRowLabel where Value == Text? {
    init(
        title: String,
        subtitle: String? = nil,
        monospacedSubtitle: Bool = false,
        systemImage: String,
        tint: T3SettingsTile.Tint,
        titleColor: Color = T3Colors.textPrimary,
        value: String? = nil
    ) {
        self.init(
            title: title,
            subtitle: subtitle,
            monospacedSubtitle: monospacedSubtitle,
            systemImage: systemImage,
            tint: tint,
            titleColor: titleColor
        ) {
            value.map { Text($0) }
        }
    }
}

/// The disclosure chevron for a `Button` row that leaves the sheet. List only
/// draws one for `NavigationLink`, and a row that navigates has to say so.
struct ThreadSheetDisclosure: View {
    var body: some View {
        Image(systemName: "chevron.right")
            .font(.footnote.weight(.semibold))
            .foregroundStyle(T3Colors.textTertiary)
            .accessibilityHidden(true)
    }
}
