import SwiftUI

/// The `/`, `$`, `@` and `/model` suggestions floating above the composer.
///
/// Sized to its content up to a cap, grouped into Commands and Skills under
/// `/`, with two-line rows. The highlighted row follows ↑/↓ from a hardware
/// keyboard and is what Return inserts.
struct FeatureComposerCommandPopover: View {
    let triggerKind: FeatureComposerTriggerKind
    let items: [FeatureComposerMenuItem]
    let highlightedIndex: Int
    let isLoading: Bool
    let errorMessage: String?
    let pathSearchAvailable: Bool
    let onSelect: (FeatureComposerMenuItem) -> Void
    let onRetry: () -> Void

    @ScaledMetric(relativeTo: .body) private var maximumHeight: CGFloat = 260

    var body: some View {
        Group {
            if items.isEmpty {
                emptyState
            } else {
                ScrollViewReader { proxy in
                    ComposerCappedScrollView(maximumHeight: maximumHeight) {
                        VStack(alignment: .leading, spacing: 0) {
                            ForEach(sections) { section in
                                if let title = section.title {
                                    Text(title)
                                        .font(T3Typography.supportingStrong)
                                        .foregroundStyle(T3Colors.textSecondary)
                                        .padding(.horizontal, 14)
                                        .padding(.top, 10)
                                        .padding(.bottom, 2)
                                        .accessibilityAddTraits(.isHeader)
                                }
                                ForEach(section.entries) { entry in
                                    Button {
                                        onSelect(entry.item)
                                    } label: {
                                        FeatureComposerCommandRow(
                                            item: entry.item,
                                            triggerKind: triggerKind,
                                            isHighlighted: entry.index == highlightedIndex
                                        )
                                    }
                                    .buttonStyle(.plain)
                                    .id(entry.index)
                                    .accessibilityIdentifier("composer-suggestion-\(entry.item.id)")
                                }
                            }
                        }
                        .padding(.vertical, 4)
                    }
                    .scrollIndicators(.hidden)
                    .onChange(of: highlightedIndex) { _, index in
                        proxy.scrollTo(index)
                    }
                }
            }
        }
        // A menu floating over the conversation is the surface Liquid Glass
        // exists for; `.regular` keeps the rows legible against whatever is
        // scrolling behind them.
        .clipShape(shape)
        .t3GlassEffect(.regular, in: shape)
        .t3GlassRim(in: shape)
        .accessibilityLabel(groupLabel)
        .accessibilityIdentifier("composer-command-menu")
    }

    private var shape: RoundedRectangle {
        RoundedRectangle(cornerRadius: 22, style: .continuous)
    }

    @ViewBuilder
    private var emptyState: some View {
        HStack(spacing: 10) {
            if isLoading {
                ProgressView()
                    .controlSize(.small)
            } else if triggerKind == .path, pathSearchAvailable, errorMessage == nil {
                Image(systemName: "doc")
                    .foregroundStyle(T3Colors.textTertiary)
            }
            Text(emptyMessage)
                .font(T3Typography.supporting)
                .foregroundStyle(T3Colors.textSecondary)
                .frame(maxWidth: .infinity, alignment: .leading)
            if !isLoading, let errorMessage, !errorMessage.isEmpty {
                Button("Retry", action: onRetry)
                    .buttonStyle(.borderless)
                    .font(T3Typography.supportingStrong)
            }
        }
        .padding(.horizontal, 14)
        .frame(minHeight: T3Metrics.minimumTapTarget)
    }

    /// Commands and skills are sectioned under `/`; every other trigger lists
    /// one kind and needs no header.
    private var sections: [SuggestionSection] {
        let indexed = items.enumerated().map { SuggestionEntry(index: $0.offset, item: $0.element) }
        guard triggerKind == .slashCommand else {
            return [SuggestionSection(title: nil, entries: indexed)]
        }
        let commands = indexed.filter { !$0.isSkill }
        let skills = indexed.filter(\.isSkill)
        guard !commands.isEmpty, !skills.isEmpty else {
            return [SuggestionSection(title: nil, entries: indexed)]
        }
        return [
            SuggestionSection(title: "Commands", entries: commands),
            SuggestionSection(title: "Skills", entries: skills),
        ]
    }

    private var groupLabel: String {
        switch triggerKind {
        case .slashCommand: return "Commands"
        case .model: return "Models"
        case .skill: return "Skills"
        case .path: return "Files"
        }
    }

    private var emptyMessage: String {
        if isLoading { return "Searching files…" }
        if let errorMessage, !errorMessage.isEmpty { return errorMessage }
        switch triggerKind {
        case .slashCommand: return "No matching commands."
        case .model: return "No matching models."
        case .skill: return "No matching skills."
        case .path where !pathSearchAvailable: return "File search is unavailable."
        case .path: return "Type a file name to search."
        }
    }
}

private struct SuggestionEntry: Identifiable {
    /// Position in the flat item list, which is what the highlight counts.
    let index: Int
    let item: FeatureComposerMenuItem

    var id: String { item.id }

    var isSkill: Bool {
        if case .skill = item { return true }
        return false
    }
}

private struct SuggestionSection: Identifiable {
    let title: String?
    let entries: [SuggestionEntry]

    var id: String { title ?? "" }
}

private struct FeatureComposerCommandRow: View {
    let item: FeatureComposerMenuItem
    let triggerKind: FeatureComposerTriggerKind
    let isHighlighted: Bool

    /// Under `/` a skill is one command among the provider's own, so it reads
    /// with the same leading slash. Under `$` the menu is nothing but skills
    /// and the sigil is already on screen.
    private var label: String {
        guard triggerKind == .slashCommand, case let .skill(skill) = item else {
            return item.label
        }
        return "/\(skill.name)"
    }

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: iconName)
                .foregroundStyle(T3Colors.textTertiary)
                .frame(width: 20)
                .accessibilityHidden(true)

            VStack(alignment: .leading, spacing: 1) {
                Text(label)
                    .font(T3Typography.control)
                    .foregroundStyle(T3Colors.textPrimary)
                    .lineLimit(1)
                if !item.description.isEmpty {
                    Text(item.description)
                        .font(T3Typography.supporting)
                        .foregroundStyle(T3Colors.textSecondary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 6)
        .frame(minHeight: T3Metrics.minimumTapTarget)
        .background {
            if isHighlighted {
                RoundedRectangle(cornerRadius: 14, style: .continuous)
                    .fill(T3Colors.subtleStrong)
                    .padding(.horizontal, 6)
            }
        }
        .contentShape(Rectangle())
        .accessibilityAddTraits(isHighlighted ? .isSelected : [])
    }

    private var iconName: String {
        switch item {
        case .modelCommand, .providerCommand: return "terminal"
        case .model: return "cpu"
        // Where the skill came from — a plugin, the repo, the user's own
        // directory — is what tells two similarly named skills apart.
        case let .skill(skill): return skill.sourceSymbolName
        case let .path(entry): return entry.kind == .directory ? "folder" : "doc"
        }
    }
}
