import SwiftUI

/// Find in Thread, under the navigation bar with the other banners (web's
/// `ThreadFindBar`): the query, where the selection stands, previous and next,
/// and Done. Return steps forward and keeps the keyboard up.
struct ThreadFindBar: View {
    let model: ThreadFindModel
    @FocusState private var fieldFocused: Bool

    private var shape: RoundedRectangle {
        RoundedRectangle(cornerRadius: 22, style: .continuous)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                Image(systemName: "magnifyingglass")
                    .foregroundStyle(T3Colors.textTertiary)
                    .accessibilityHidden(true)
                TextField("Find in Thread", text: Binding(get: { model.query }, set: { model.setQuery($0) }))
                    .font(T3Typography.composer)
                    .textFieldStyle(.plain)
                    .focused($fieldFocused)
                    .submitLabel(.search)
                    .autocorrectionDisabled()
                    .textInputAutocapitalization(.never)
                    .onSubmit {
                        model.next()
                        fieldFocused = true
                    }
                    .accessibilityIdentifier("thread-find-field")
                if let label = model.countLabel {
                    Text(label)
                        .font(T3Typography.supporting)
                        .monospacedDigit()
                        .foregroundStyle(model.hasNoResults || model.status == .failed ? T3Colors.danger : T3Colors.textSecondary)
                        .lineLimit(1)
                        .fixedSize()
                        .accessibilityIdentifier("thread-find-count")
                }
                stepButton("Previous Match", systemImage: "chevron.up") { model.previous() }
                stepButton("Next Match", systemImage: "chevron.down") { model.next() }
                Button("Done") { model.close() }
                    .font(T3Typography.control)
                    .foregroundStyle(T3Colors.textPrimary)
                    .buttonStyle(.plain)
                    .frame(minHeight: T3Metrics.minimumTapTarget)
                    .padding(.leading, 4)
                    .accessibilityIdentifier("thread-find-done")
            }
            if model.status == .failed {
                HStack(spacing: 8) {
                    Text("Could not search this thread. Please retry.")
                        .font(T3Typography.supporting)
                        .foregroundStyle(T3Colors.danger)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    Button("Retry") { model.retry() }
                        .font(T3Typography.supportingStrong)
                        .buttonStyle(.plain)
                        .foregroundStyle(T3Colors.textPrimary)
                        .frame(minHeight: T3Metrics.minimumTapTarget)
                }
                .padding(.bottom, 2)
            }
        }
        .padding(.leading, 14)
        .padding(.trailing, 10)
        .t3GlassEffect(in: shape)
        .t3GlassRim(in: shape)
        .padding(.horizontal, 16)
        .padding(.top, 8)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Find in Thread")
        .accessibilityIdentifier("thread-find-bar")
        .onChange(of: model.focusRequest, initial: true) { fieldFocused = true }
    }

    private func stepButton(_ title: String, systemImage: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: systemImage)
                .font(.body.weight(.semibold))
                .frame(width: 32, height: T3Metrics.minimumTapTarget)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .foregroundStyle(model.canStep ? T3Colors.textPrimary : T3Colors.textTertiary)
        .disabled(!model.canStep)
        .accessibilityLabel(title)
    }
}
