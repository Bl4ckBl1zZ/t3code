import SwiftUI

// Chrome shared by the New Task and New Work / New Chat sheets: the glass
// capsule menus under the hero (computer, workspace, branch), the wrapping
// starter row, and the leading cancel button.

/// A glass capsule that labels a `Menu` or button: glyph, value, and an
/// up-down chevron when it opens a choice. In layout flow with a 44pt target,
/// never positioned with an offset.
struct ComposeCapsuleLabel: View {
    let title: String
    let systemImage: String
    var showsChevron = true
    var glyphTint: Color = T3Colors.textSecondary

    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: systemImage)
                .imageScale(.small)
                .foregroundStyle(glyphTint)
            Text(title)
                .lineLimit(1)
            if showsChevron {
                Image(systemName: "chevron.up.chevron.down")
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(T3Colors.textTertiary)
                    .accessibilityHidden(true)
            }
        }
        .font(T3Typography.supportingStrong)
        .foregroundStyle(T3Colors.textPrimary)
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .t3GlassEffect(.regular, interactive: showsChevron, in: Capsule())
        .t3GlassRim(in: Capsule())
        .frame(minHeight: T3Metrics.minimumTapTarget)
        .contentShape(Capsule())
    }
}

/// Lays children out left to right, wrapping onto new centered lines, so
/// starter capsules never truncate at large text sizes.
struct ComposeFlowLayout: Layout {
    var spacing: CGFloat = 8

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let rows = rows(for: subviews, width: proposal.width ?? .infinity)
        let height = rows.reduce(0) { $0 + $1.height } + spacing * CGFloat(max(0, rows.count - 1))
        let width = rows.map(\.width).max() ?? 0
        return CGSize(width: proposal.width ?? width, height: height)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var y = bounds.minY
        for row in rows(for: subviews, width: bounds.width) {
            var x = bounds.minX + (bounds.width - row.width) / 2
            for index in row.indices {
                let size = subviews[index].sizeThatFits(.init(width: bounds.width, height: nil))
                subviews[index].place(
                    at: CGPoint(x: x, y: y + (row.height - size.height) / 2),
                    proposal: .init(width: min(size.width, bounds.width), height: size.height)
                )
                x += min(size.width, bounds.width) + spacing
            }
            y += row.height + spacing
        }
    }

    private struct Row {
        var indices: [Int] = []
        var width: CGFloat = 0
        var height: CGFloat = 0
    }

    private func rows(for subviews: Subviews, width: CGFloat) -> [Row] {
        var rows: [Row] = []
        var current = Row()
        for index in subviews.indices {
            let size = subviews[index].sizeThatFits(.init(width: width, height: nil))
            let itemWidth = min(size.width, width)
            let needed = current.indices.isEmpty ? itemWidth : current.width + spacing + itemWidth
            if needed > width, !current.indices.isEmpty {
                rows.append(current)
                current = Row()
            }
            current.width = current.indices.isEmpty ? itemWidth : current.width + spacing + itemWidth
            current.height = max(current.height, size.height)
            current.indices.append(index)
        }
        if !current.indices.isEmpty { rows.append(current) }
        return rows
    }
}

/// The leading button of an edit sheet: the system cancel xmark on iOS 26,
/// "Cancel" before. For sheets whose leave needs its own confirmation;
/// others use `t3SheetToolbar(.cancel, …)`.
struct ComposeCancelButton: View {
    let action: () -> Void

    var body: some View {
        if #available(iOS 26, *) {
            Button(role: .cancel, action: action)
        } else {
            Button("Cancel", role: .cancel, action: action)
        }
    }
}
