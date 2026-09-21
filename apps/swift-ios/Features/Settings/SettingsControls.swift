import SwiftUI

// Shared chrome for the settings pages in this folder. Every page is an
// inset-grouped Form on the palette background, so rows, separators, headers
// and footers are the system's own. What lives here is only what those rows do
// not already provide.

/// A settings page: an inset-grouped `Form` on the palette background whose
/// rows are filled from the palette's surface, so a chosen theme repaints every
/// page rather than only the ones that remembered to.
struct SettingsForm<Content: View>: View {
    private let content: Content

    init(@ViewBuilder content: () -> Content) {
        self.content = content()
    }

    var body: some View {
        Form {
            content.t3GroupedRow()
        }
        .formStyle(.grouped)
        .t3GroupedListBackground()
        .t3NavigationChrome()
    }
}

/// A row label led by a Settings-style tile, with an optional second line.
struct SettingsTileLabel: View {
    let title: String
    let systemImage: String
    let tint: T3SettingsTile.Tint
    var subtitle: String?

    var body: some View {
        Label {
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .foregroundStyle(T3Colors.textPrimary)
                if let subtitle {
                    Text(subtitle)
                        .font(T3Typography.supporting)
                        .foregroundStyle(T3Colors.textSecondary)
                }
            }
        } icon: {
            T3SettingsTile(systemImage, tint: tint)
        }
    }
}

/// A section footer: the explanation, then the last failed write beneath it in
/// the danger color. Either half may be absent.
struct SettingsFooter: View {
    var text: String?
    var error: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            if let text { Text(text) }
            if let error {
                Text(error).foregroundStyle(T3Colors.danger)
            }
        }
    }
}

/// Stand-ins for rows whose first answer is still in flight: shaped like the
/// real rows and redacted. Static on purpose — a waiting state never animates.
struct SettingsPlaceholderRows: View {
    var count = 3

    var body: some View {
        ForEach(0..<count, id: \.self) { _ in
            LabeledContent("Loading setting", value: "Value")
                .redacted(reason: .placeholder)
                .accessibilityElement(children: .ignore)
                .accessibilityLabel("Loading")
        }
    }
}

/// A page whose first load failed: what went wrong and the way to try again,
/// in place of the rows it could not fill.
struct SettingsRetrySection: View {
    let message: String
    let retry: () -> Void

    var body: some View {
        Section {
            Button("Try Again", systemImage: "arrow.clockwise", action: retry)
        } footer: {
            Text(message).foregroundStyle(T3Colors.danger)
        }
    }
}

extension View {
    /// Scopes a server-backed page to one server: its name sits under the title
    /// and, with more than one server, the title opens a menu that switches it.
    ///
    /// iOS 26 uses the system subtitle and title menu. Earlier systems have no
    /// subtitle, so the same two lines are drawn in the principal slot instead.
    func settingsServerScope(
        title: String,
        environments: [FeatureEnvironment],
        selection: Binding<String>,
        isEnabled: Bool = true
    ) -> some View {
        modifier(SettingsServerScopeModifier(
            title: title,
            environments: environments,
            selection: selection,
            isEnabled: isEnabled
        ))
    }
}

private struct SettingsServerScopeModifier: ViewModifier {
    let title: String
    let environments: [FeatureEnvironment]
    @Binding var selection: String
    let isEnabled: Bool

    private var serverName: String? {
        environments.first { $0.id == selection }?.name
    }

    private var isSwitchable: Bool { environments.count > 1 }

    func body(content: Content) -> some View {
        if #available(iOS 26, *) {
            modern(content)
        } else {
            content
                .navigationTitle(title)
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .principal) { legacyTitle }
                }
        }
    }

    @available(iOS 26, *)
    @ViewBuilder
    private func modern(_ content: Content) -> some View {
        let titled = content
            .navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
            .navigationSubtitle(serverName ?? "")
        if isSwitchable {
            titled.toolbarTitleMenu { picker }
        } else {
            titled
        }
    }

    private var picker: some View {
        Picker("Server", selection: $selection) {
            ForEach(environments) { environment in
                Label(environment.name, systemImage: environment.machineSymbol)
                    .tag(environment.id)
            }
        }
        .disabled(!isEnabled)
    }

    @ViewBuilder
    private var legacyTitle: some View {
        let stack = VStack(spacing: 0) {
            HStack(spacing: 4) {
                Text(title)
                    .font(T3Typography.navigationTitle)
                    .foregroundStyle(T3Colors.textPrimary)
                if isSwitchable {
                    Image(systemName: "chevron.down.circle.fill")
                        .font(.footnote)
                        .foregroundStyle(T3Colors.textTertiary)
                        .accessibilityHidden(true)
                }
            }
            if let serverName {
                Text(serverName)
                    .font(T3Typography.supporting)
                    .foregroundStyle(T3Colors.textSecondary)
            }
        }
        .lineLimit(1)
        if isSwitchable {
            Menu { picker } label: { stack }
                .accessibilityLabel("\(title), \(serverName ?? ""), switch server")
        } else {
            stack.accessibilityElement(children: .combine)
        }
    }
}

// MARK: - Chrome shared with screens outside Settings

/// A settled request failure, inline under the field it concerns. Settings
/// pages put failures in section footers instead; this remains for the sheets
/// elsewhere in the app that still use it.
struct SettingsErrorBanner: View {
    let message: String

    var body: some View {
        Label(message, systemImage: "exclamationmark.triangle")
            .font(T3Typography.supporting)
            .foregroundStyle(T3Colors.danger)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 12)
            .fixedSize(horizontal: false, vertical: true)
            .accessibilityElement(children: .combine)
    }
}

/// A titled card of rows, for the few screens outside Settings that have not
/// moved to an inset-grouped list. Plain header, no rim.
struct SettingsSection<Content: View>: View {
    let title: String
    let footer: String?
    let content: Content

    init(
        title: String,
        footer: String? = nil,
        @ViewBuilder content: () -> Content
    ) {
        self.title = title
        self.footer = footer
        self.content = content()
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title)
                .font(T3Typography.supportingStrong)
                .foregroundStyle(T3Colors.textSecondary)
                .padding(.horizontal, 4)
                .frame(minHeight: 24, alignment: .leading)
                .accessibilityAddTraits(.isHeader)

            VStack(spacing: 0) {
                content
            }
            .background(T3Colors.surface)
            .clipShape(RoundedRectangle(cornerRadius: 20, style: .continuous))

            if let footer {
                Text(footer)
                    .font(T3Typography.supporting)
                    .foregroundStyle(T3Colors.textTertiary)
                    .padding(.horizontal, 4)
                    .padding(.top, 2)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(.horizontal, 16)
    }
}

enum SettingsActionTone {
    case primary
    case secondary
    case danger
}

/// A full-width action button for sheets outside Settings. Primary is the
/// screen's one ink call to action; the others are secondary glass. The busy
/// spinner replaces the icon so the button never changes width mid-request.
struct SettingsActionButton: View {
    let title: String
    var systemImage: String?
    var tone: SettingsActionTone = .secondary
    var isBusy = false
    var isDisabled = false
    let action: () -> Void

    var body: some View {
        styled(Button(action: action) { label })
            .controlSize(.large)
            .disabled(isDisabled || isBusy)
            .accessibilityLabel(title)
    }

    /// Only danger overrides the color; the others keep the one their button
    /// style sets, which is what keeps ink labels legible in every palette.
    @ViewBuilder
    private var label: some View {
        let content = HStack(spacing: 8) {
            if isBusy {
                ProgressView()
                    .controlSize(.small)
            } else if let systemImage {
                Image(systemName: systemImage)
                    .accessibilityHidden(true)
            }
            Text(title)
        }
        .font(T3Typography.control.weight(.semibold))
        .frame(maxWidth: .infinity)
        if tone == .danger {
            content.foregroundStyle(T3Colors.danger)
        } else {
            content
        }
    }

    @ViewBuilder
    private func styled(_ button: some View) -> some View {
        switch tone {
        case .primary: button.t3ProminentButtonStyle()
        case .secondary, .danger: button.t3SecondaryButtonStyle()
        }
    }
}

extension View {
    /// The text-entry treatment for free-standing fields outside a Form: a
    /// filled input strip with a hairline under it.
    func settingsInputField(minHeight: CGFloat = 48) -> some View {
        font(T3Typography.threadBody)
            .foregroundStyle(T3Colors.textPrimary)
            .padding(.horizontal, 12)
            .padding(.vertical, 12)
            .frame(maxWidth: .infinity, minHeight: minHeight, alignment: .topLeading)
            .background(T3Colors.input)
            .overlay(alignment: .bottom) {
                Rectangle()
                    .fill(T3Colors.inputBorder)
                    .frame(height: 1)
            }
    }
}
