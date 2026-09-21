import AuthenticationServices
import ClerkKit
import ClerkKitUI
import SwiftUI

/// Environments linked to the signed-in T3 account, following the Wi-Fi
/// pattern: a checkmark marks the one in use and tapping a row connects to it.
public struct T3ConnectView: View {
    @SwiftUI.Environment(\.dismiss) private var dismiss
    @Bindable private var controller: T3ConnectController
    @State private var isAuthPresented = false
    @State private var didStartInitialRefresh = false
    @State private var didFinishInitialRefresh = false
    @State private var lastRefreshSucceeded = false
    @State private var isPullRefreshing = false
    @State private var isSigningOut = false
    @State private var confirmingSignOut = false
    @State private var unlinkTarget: T3ConnectRelayEnvironment?
    @State private var retryEnvironment: T3ConnectRelayEnvironment?
    @State private var connectedEnvironmentID: String?
    private let activeEnvironmentID: String?
    private let connectEnvironment:
        @MainActor (T3ConnectManagedEnvironmentCredential) async throws -> Void
    private let onConnected: @MainActor () async -> Void

    /// `activeEnvironmentID` is the environment this app is using, which gets
    /// the checkmark when it is one of the account's.
    public init(
        capability: any T3ConnectCapable,
        activeEnvironmentID: String? = nil,
        onConnected: @escaping @MainActor () async -> Void = {}
    ) {
        controller = capability.t3ConnectController
        connectEnvironment = capability.connectT3Environment
        self.activeEnvironmentID = activeEnvironmentID
        self.onConnected = onConnected
    }

    public var body: some View {
        content
            .navigationTitle("T3 Connect")
            .navigationBarTitleDisplayMode(.large)
            .t3NavigationChrome()
            .task {
                guard !didStartInitialRefresh else { return }
                didStartInitialRefresh = true
                await refresh()
                didFinishInitialRefresh = true
                presentAuthenticationIfNeeded()
            }
            .onChange(of: controller.account?.id) { _, accountID in
                guard didFinishInitialRefresh,
                      accountID == nil,
                      controller.unavailableReason == nil else { return }
                isAuthPresented = true
            }
            .fullScreenCover(
                isPresented: $isAuthPresented,
                onDismiss: handleAuthenticationDismissal
            ) {
                authenticationView
            }
            .confirmationDialog(
                "Sign out of T3 Connect?",
                isPresented: $confirmingSignOut,
                titleVisibility: .visible
            ) {
                Button("Sign Out", role: .destructive) {
                    Task { await signOut() }
                }
                Button("Cancel", role: .cancel) {}
            } message: {
                Text("You’ll need to sign in again to reach cloud environments from this device.")
            }
            .confirmationDialog(
                unlinkTarget.map { "Unlink “\($0.label)”?" } ?? "Unlink?",
                isPresented: Binding(
                    get: { unlinkTarget != nil },
                    set: { if !$0 { unlinkTarget = nil } }
                ),
                titleVisibility: .visible,
                presenting: unlinkTarget
            ) { environment in
                Button("Unlink", role: .destructive) {
                    Task { await controller.unlink(environment) }
                }
                Button("Cancel", role: .cancel) {}
            } message: { _ in
                Text("It’s removed from your T3 account on every device. Link it again from T3 Code on that computer.")
            }
    }

    @ViewBuilder
    private var content: some View {
        if let reason = controller.unavailableReason {
            ContentUnavailableView {
                Label("T3 Connect Unavailable", systemImage: "cloud.slash")
            } description: {
                Text("\(reason)\nDirect and local connections still work without an account.")
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(T3Colors.background)
        } else if controller.account != nil || controller.connectionFailure != nil {
            connectList
        } else {
            ProgressView("Checking your account…")
                .tint(T3Colors.textPrimary)
                .foregroundStyle(T3Colors.textSecondary)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(T3Colors.background)
        }
    }

    private var connectList: some View {
        List {
            if let failure = controller.connectionFailure {
                ConnectionFailureSection(
                    title: "Couldn’t Reach T3 Connect",
                    failure: failure,
                    isRetrying: controller.isRefreshing || controller.busyEnvironmentID != nil
                ) {
                    Task {
                        if let retryEnvironment { await handleConnect(retryEnvironment) }
                        else { await refresh() }
                    }
                }
            }

            if let account = controller.account {
                accountSection(account)
                environmentSection
                signOutSection
            }
        }
        .listStyle(.insetGrouped)
        .t3GroupedListBackground()
        .refreshable {
            retryEnvironment = nil
            isPullRefreshing = true
            await refresh()
            isPullRefreshing = false
        }
    }

    @ViewBuilder
    private var authenticationView: some View {
        if let clerk = controller.clerk {
            T3ConnectAuthenticationView {
                await controller.refresh()
                if controller.account != nil {
                    isAuthPresented = false
                    return true
                }
                return false
            }
                .environment(\.clerkTheme, T3ConnectClerkAppearance.theme)
                .environment(clerk)
        } else {
            ProgressView()
                .tint(T3Colors.textPrimary)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(T3Colors.background.ignoresSafeArea())
        }
    }

    /// Sign-in opens on its own only when the account check actually
    /// succeeded and found no one; an offline check shows its failure instead.
    private func presentAuthenticationIfNeeded() {
        guard controller.unavailableReason == nil,
              lastRefreshSucceeded,
              controller.account == nil else { return }
        isAuthPresented = true
    }

    private func handleAuthenticationDismissal() {
        Task {
            await refresh()
            if lastRefreshSucceeded, controller.account == nil {
                dismiss()
            }
        }
    }

    private func refresh() async {
        await controller.refresh()
        lastRefreshSucceeded = controller.connectionFailure == nil
    }

    private func accountSection(_ account: T3ConnectAccount) -> some View {
        Section {
            HStack(spacing: 14) {
                Image(systemName: "person.crop.circle.fill")
                    .font(.largeTitle)
                    .imageScale(.large)
                    .foregroundStyle(T3Colors.textTertiary)
                VStack(alignment: .leading, spacing: 2) {
                    Text(account.email ?? "T3 account")
                        .font(.headline)
                        .foregroundStyle(T3Colors.textPrimary)
                    Text("Signed in to T3 Connect")
                        .font(T3Typography.supporting)
                        .foregroundStyle(T3Colors.textTertiary)
                }
            }
            .padding(.vertical, 4)
            .accessibilityElement(children: .combine)
        }
        .t3GroupedRow()
    }

    @ViewBuilder
    private var environmentSection: some View {
        if controller.environments.isEmpty {
            if lastRefreshSucceeded, !controller.isRefreshing {
                Section {
                    ContentUnavailableView {
                        Label("No Linked Environments", systemImage: "cloud")
                    } description: {
                        Text("Link an environment from T3 Code on your computer, then pull to refresh.")
                    }
                }
                .listRowBackground(Color.clear)
            } else if controller.isRefreshing, !isPullRefreshing {
                Section("Cloud Environments") {
                    refreshingRow
                }
                .t3GroupedRow()
            }
        } else {
            Section {
                ForEach(controller.environments) { item in
                    environmentRow(item)
                        .swipeActions {
                            Button("Unlink", systemImage: "link.badge.minus", role: .destructive) {
                                unlinkTarget = item.environment
                            }
                        }
                        .contextMenu {
                            Button("Unlink", systemImage: "link.badge.minus", role: .destructive) {
                                unlinkTarget = item.environment
                            }
                        }
                }
                if controller.isRefreshing, !isPullRefreshing {
                    refreshingRow
                }
            } header: {
                Text("Cloud Environments")
            } footer: {
                Text("Link environments from T3 Code on your computer. Touch and hold one to unlink it.")
            }
            .t3GroupedRow()
        }
    }

    private var refreshingRow: some View {
        HStack(spacing: 10) {
            ProgressView()
            Text("Refreshing environments…")
                .font(T3Typography.supporting)
                .foregroundStyle(T3Colors.textSecondary)
        }
    }

    private var signOutSection: some View {
        Section {
            Button(role: .destructive) {
                confirmingSignOut = true
            } label: {
                HStack {
                    Spacer()
                    if isSigningOut {
                        ProgressView()
                    } else {
                        Text("Sign Out")
                    }
                    Spacer()
                }
            }
            .foregroundStyle(T3Colors.danger)
            .disabled(isSigningOut || controller.busyEnvironmentID != nil)
        }
        .t3GroupedRow()
    }

    private func environmentRow(_ item: T3ConnectCloudEnvironment) -> some View {
        let status = T3ConnectEnvironmentStatus(item, isInUse: item.id == inUseEnvironmentID)
        let isBusy = controller.busyEnvironmentID == item.id
        return Button {
            Task { await handleConnect(item.environment) }
        } label: {
            HStack(spacing: 12) {
                Image(systemName: "checkmark")
                    .font(.body.weight(.semibold))
                    .foregroundStyle(T3Colors.accent)
                    .opacity(status.isInUse ? 1 : 0)
                    .frame(width: 22)
                    .accessibilityHidden(true)

                VStack(alignment: .leading, spacing: 2) {
                    Text(item.environment.label)
                        .foregroundStyle(status.isOffline ? T3Colors.textTertiary : T3Colors.textPrimary)
                        .lineLimit(1)
                    Text(status.text)
                        .font(T3Typography.supporting)
                        .foregroundStyle(status.color)
                        .lineLimit(1)
                }

                Spacer(minLength: 8)

                if isBusy {
                    ProgressView()
                }
            }
            .contentShape(Rectangle())
        }
        .disabled(controller.busyEnvironmentID != nil || isSigningOut || status.isOffline)
        .accessibilityValue(status.accessibilityValue)
        .accessibilityHint(status.isInUse ? "" : "Connects to this environment")
    }

    private var inUseEnvironmentID: String? {
        connectedEnvironmentID ?? activeEnvironmentID
    }

    private func handleConnect(_ environment: T3ConnectRelayEnvironment) async {
        retryEnvironment = environment
        controller.errorMessage = nil
        do {
            let credential = try await controller.credential(for: environment)
            try await connectEnvironment(credential)
            connectedEnvironmentID = environment.environmentId
            retryEnvironment = nil
            PlatformHapticEngine.shared.play(.success)
            await onConnected()
        } catch {
            controller.reportConnectionFailure(error)
        }
    }

    private func signOut() async {
        isSigningOut = true
        defer { isSigningOut = false }
        retryEnvironment = nil
        await controller.signOut()
    }
}

/// How one cloud environment's row reads: status words and their color.
struct T3ConnectEnvironmentStatus: Equatable {
    enum Tone: Equatable {
        case success
        case danger
        case tertiary
    }

    let text: String
    let tone: Tone
    let isInUse: Bool
    let isOffline: Bool

    init(_ item: T3ConnectCloudEnvironment, isInUse: Bool) {
        self.isInUse = isInUse
        isOffline = item.statusError == nil && item.status?.status == .offline
        if item.statusError != nil {
            // The raw request error is in the failure section, not the row.
            text = "Status unavailable"
            tone = .tertiary
        } else {
            switch item.status?.status {
            case .online:
                text = isInUse ? "Online · In use" : "Online"
                tone = .success
            case .offline:
                text = "Offline"
                tone = .danger
            case nil:
                text = "Checking…"
                tone = .tertiary
            }
        }
    }

    var color: Color {
        switch tone {
        case .success: T3Colors.success
        case .danger: T3Colors.danger
        case .tertiary: T3Colors.textTertiary
        }
    }

    var accessibilityValue: String {
        isInUse ? "\(text), selected" : text
    }
}

@MainActor
private struct T3ConnectAuthenticationView: View {
    @SwiftUI.Environment(\.dismiss) private var dismiss
    @SwiftUI.Environment(\.colorScheme) private var colorScheme
    @SwiftUI.Environment(Clerk.self) private var clerk
    @State private var activeProvider: OAuthProvider?
    @State private var errorMessage: String?
    @State private var isEmailPresented = false
    @State private var optionsFailed = false
    @State private var isLoadingOptions = false

    private let onAuthenticationChanged: @MainActor () async -> Bool
    private let preferredProviders: [OAuthProvider] = [
        .apple,
        .github,
        .google,
        .microsoft,
    ]

    init(
        onAuthenticationChanged: @escaping @MainActor () async -> Bool
    ) {
        self.onAuthenticationChanged = onAuthenticationChanged
    }

    var body: some View {
        NavigationStack {
            GeometryReader { geometry in
                ScrollView {
                    VStack(spacing: 0) {
                        hero
                            .padding(.top, 48)
                        Spacer(minLength: 40)
                        providerOptions
                    }
                    .frame(maxWidth: 440)
                    .padding(.horizontal, 24)
                    .padding(.bottom, 24)
                    .frame(maxWidth: .infinity, minHeight: geometry.size.height)
                }
                .scrollBounceBehavior(.basedOnSize)
            }
            .background(T3Colors.background.ignoresSafeArea())
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    if #available(iOS 26, *) {
                        Button(role: .close) { dismiss() }
                    } else {
                        Button("Close", systemImage: "xmark") { dismiss() }
                    }
                }
            }
            .toolbarBackground(.hidden, for: .navigationBar)
        }
        .task { await loadOptions() }
        .sheet(isPresented: $isEmailPresented, onDismiss: authenticationDidFinish) {
            AuthView(mode: .signInOrUp)
                .prefetchClerkImages()
                .environment(\.clerkTheme, T3ConnectClerkAppearance.theme)
                .environment(clerk)
                .presentationDragIndicator(.visible)
        }
        .alert(
            "Couldn’t Sign In",
            isPresented: Binding(
                get: { errorMessage != nil },
                set: { if !$0 { errorMessage = nil } }
            )
        ) {
            Button("OK") { errorMessage = nil }
        } message: {
            Text(errorMessage ?? "Please try again.")
        }
    }

    private var hero: some View {
        VStack(spacing: 12) {
            T3BrandMark()
                .padding(.bottom, 6)
            Text("Sign In to T3 Connect")
                .font(.title.bold())
                .foregroundStyle(T3Colors.textPrimary)
            Text("Reach your environments from anywhere.")
                .font(T3Typography.threadBody)
                .foregroundStyle(T3Colors.textSecondary)
        }
        .multilineTextAlignment(.center)
        .accessibilityElement(children: .combine)
    }

    @ViewBuilder
    private var providerOptions: some View {
        if clerk.environment != nil {
            VStack(spacing: 12) {
                ForEach(availableProviders) { provider in
                    providerButton(provider)
                }
                Button("Use Email Instead") {
                    isEmailPresented = true
                }
                .font(T3Typography.control)
                .tint(T3Colors.accent)
                .frame(minHeight: T3Metrics.minimumTapTarget)
                .disabled(activeProvider != nil)
            }
        } else if optionsFailed {
            ContentUnavailableView {
                Label("Couldn’t Load Sign-In Options", systemImage: "wifi.exclamationmark")
            } description: {
                Text("Check your connection and try again.")
            } actions: {
                Button("Try Again") {
                    Task { await loadOptions() }
                }
                .t3SecondaryButtonStyle()
                .disabled(isLoadingOptions)
            }
        } else {
            ProgressView("Loading sign-in options…")
                .tint(T3Colors.textPrimary)
                .foregroundStyle(T3Colors.textSecondary)
                .frame(maxWidth: .infinity, minHeight: 120)
        }
    }

    /// Continue with Apple follows Apple's button rules: black in light mode,
    /// white in dark, with the Apple logo. The other providers are secondary
    /// capsules.
    @ViewBuilder
    private func providerButton(_ provider: OAuthProvider) -> some View {
        let button = Button {
            Task { await signIn(with: provider) }
        } label: {
            HStack(spacing: 10) {
                if activeProvider == provider {
                    ProgressView()
                        .tint(provider == .apple ? appleForeground : T3Colors.textPrimary)
                        .accessibilityLabel("Signing in with \(provider.name)")
                } else {
                    T3ConnectAuthProviderIcon(provider: provider)
                        .foregroundStyle(provider == .apple ? appleForeground : T3Colors.textPrimary)
                        .frame(width: 20, height: 20)
                    Text("Continue with \(provider.name)")
                        .font(.body.weight(.semibold))
                }
            }
            .frame(maxWidth: .infinity, minHeight: 28)
        }
        .controlSize(.large)
        .disabled(activeProvider != nil)
        .accessibilityIdentifier("t3-connect-auth-\(provider.strategy)")

        if provider == .apple {
            button.buttonStyle(AppleSignInButtonStyle(isDark: colorScheme == .dark))
        } else {
            button
                .buttonBorderShape(.capsule)
                .t3SecondaryButtonStyle()
        }
    }

    private var appleForeground: Color {
        colorScheme == .dark ? .black : .white
    }

    private var availableProviders: [OAuthProvider] {
        guard let environment = clerk.environment else { return [] }
        let enabledStrategies = Set(
            environment.userSettings.social.values
                .filter { $0.enabled && $0.authenticatable }
                .map(\.strategy)
        )
        return preferredProviders.filter { enabledStrategies.contains($0.strategy) }
    }

    private func loadOptions() async {
        guard clerk.environment == nil, !isLoadingOptions else { return }
        isLoadingOptions = true
        optionsFailed = false
        defer { isLoadingOptions = false }
        do {
            _ = try await clerk.refreshEnvironment()
        } catch {
            if !Task.isCancelled { optionsFailed = true }
        }
    }

    private func signIn(with provider: OAuthProvider) async {
        activeProvider = provider
        defer { activeProvider = nil }

        do {
            if provider == .apple {
                try await clerk.auth.signInWithApple()
            } else {
                try await clerk.auth.signInWithOAuth(provider: provider)
            }

            if !(await onAuthenticationChanged()) {
                errorMessage = "Sign-in finished, but T3 Connect couldn’t load your account. Try again, or use email instead."
            }
        } catch {
            // Closing Apple's or the provider's sheet is a choice, not an error.
            guard !Self.isUserCancellation(error) else { return }
            errorMessage = error.localizedDescription
        }
    }

    private func authenticationDidFinish() {
        Task { _ = await onAuthenticationChanged() }
    }

    static func isUserCancellation(_ error: any Error) -> Bool {
        if error is CancellationError { return true }
        if let authorization = error as? ASAuthorizationError, authorization.code == .canceled {
            return true
        }
        if let web = error as? ASWebAuthenticationSessionError, web.code == .canceledLogin {
            return true
        }
        let nsError = error as NSError
        return nsError.domain == NSURLErrorDomain && nsError.code == NSURLErrorCancelled
    }
}

/// Sign in with Apple's required look: a solid black button in light mode and
/// a white one in dark, never the palette's colors.
private struct AppleSignInButtonStyle: ButtonStyle {
    let isDark: Bool
    @SwiftUI.Environment(\.isEnabled) private var isEnabled

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .foregroundStyle(isDark ? Color.black : Color.white)
            .padding(.horizontal, 20)
            .padding(.vertical, 14)
            .background(isDark ? Color.white : Color.black, in: Capsule())
            .opacity(isEnabled ? (configuration.isPressed ? 0.8 : 1) : 0.5)
            .contentShape(Capsule())
    }
}

private struct T3ConnectAuthProviderIcon: View {
    let provider: OAuthProvider

    @ViewBuilder
    var body: some View {
        switch provider {
        case .apple:
            Image(systemName: "apple.logo")
                .resizable()
                .scaledToFit()
        case .github:
            Image("AuthGitHub")
                .resizable()
                .scaledToFit()
        case .google:
            Image("AuthGoogle")
                .resizable()
                .scaledToFit()
        case .microsoft:
            Image("AuthMicrosoft")
                .resizable()
                .scaledToFit()
        default:
            Image(systemName: "person.crop.circle")
                .resizable()
                .scaledToFit()
        }
    }
}

@MainActor
private enum T3ConnectClerkAppearance {
    static let theme = ClerkTheme(
        colors: .init(
            primary: T3Colors.primaryAction,
            background: T3Colors.background,
            input: T3Colors.input,
            danger: T3Colors.danger,
            success: T3Colors.success,
            warning: T3Colors.warning,
            foreground: T3Colors.textPrimary,
            mutedForeground: T3Colors.textSecondary,
            primaryForeground: T3Colors.primaryActionForeground,
            inputForeground: T3Colors.textPrimary,
            neutral: T3Colors.textPrimary,
            ring: T3Colors.textPrimary,
            muted: T3Colors.surfaceRaised,
            shadow: T3Colors.border,
            border: T3Colors.border
        ),
        design: .init(borderRadius: 12)
    )
}
