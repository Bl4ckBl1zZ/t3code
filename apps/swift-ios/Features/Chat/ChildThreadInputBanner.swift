import SwiftUI

/// The subagent threads below a thread that wait on a question from the reader.
/// Ports client-runtime's `childThreadInputsAtom` (upstream ed4ea1083d): subagent
/// rows are hidden from the lists, so the parent is where their questions show.
/// Provider-native subagents are left out because the provider asks through the
/// parent's own run.
enum ChildThreadInputs {
    static func waiting(under threadID: String, in threads: [FeatureThread]) -> [FeatureThread] {
        var children: [String: [FeatureThread]] = [:]
        for thread in threads where thread.isSubagentThread {
            guard let parent = thread.parentThreadID else { continue }
            children[parent, default: []].append(thread)
        }
        var seen: Set<String> = [threadID]
        var pending = [threadID]
        var waiting: [FeatureThread] = []
        var index = 0
        while index < pending.count {
            for child in children[pending[index]] ?? [] where !seen.contains(child.id) {
                seen.insert(child.id)
                pending.append(child.id)
                if child.state == .waitingForInput, !child.isProviderNativeSubagentThread {
                    waiting.append(child)
                }
            }
            index += 1
        }
        return waiting
    }

    static func title(count: Int) -> String {
        count == 1 ? "Subagent needs input" : "\(count) subagents need input"
    }
}

/// "Subagent needs input" above the composer, linking each waiting subagent.
/// The host hides it while the thread itself waits on the reader.
struct ChildThreadInputBanner: View {
    let children: [FeatureThread]
    let onOpen: (String) -> Void

    var body: some View {
        if let first = children.first {
            VStack(alignment: .leading, spacing: 8) {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Image(systemName: "questionmark.bubble")
                        .foregroundStyle(T3Colors.statusInput)
                        .accessibilityHidden(true)
                    Text(ChildThreadInputs.title(count: children.count))
                        .font(T3Typography.supportingStrong)
                        .foregroundStyle(T3Colors.textPrimary)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    Button("Open Question") { onOpen(first.id) }
                        .t3SecondaryButtonStyle()
                        .buttonBorderShape(.capsule)
                        .controlSize(.small)
                }
                if children.count > 1 {
                    ForEach(children) { child in
                        Button { onOpen(child.id) } label: {
                            Text(child.title)
                                .font(T3Typography.supporting)
                                .foregroundStyle(T3Colors.textSecondary)
                                .lineLimit(1)
                                .frame(maxWidth: .infinity, alignment: .leading)
                        }
                        .buttonStyle(.plain)
                        .accessibilityHint("Opens this subagent's thread")
                    }
                } else {
                    Text(first.title)
                        .font(T3Typography.supporting)
                        .foregroundStyle(T3Colors.textSecondary)
                        .lineLimit(1)
                }
            }
            .padding(14)
            .t3GlassEffect(.regular, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
            .t3GlassRim(in: RoundedRectangle(cornerRadius: 20, style: .continuous))
            .padding(.horizontal, 16)
            .padding(.bottom, 8)
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("composer-child-thread-input")
        }
    }
}
