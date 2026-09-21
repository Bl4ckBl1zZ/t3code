import SwiftUI

public struct FeatureRootView: View {
    @State private var model: FeatureRootModel
    @State private var startedFresh = false
    @State private var showingSetup = false
    @State private var holdsOnboarding = false
    @AppStorage("t3.native.onboarding.completed") private var setupCompleted = false
    /// Set once Home has shown real data. A returning user then gets Home's
    /// shell with placeholder rows at launch instead of the loading screen.
    @AppStorage("t3.native.workspace.shown") private var hasShownWorkspace = false
    private let navigationRequest: FeatureWorkspaceNavigationRequest?
    private let onNavigationRequestConsumed: @MainActor (UUID) -> Void

    public init(client: any FeatureClient) {
        _model = State(initialValue: FeatureRootModel(client: client))
        navigationRequest = nil
        onNavigationRequestConsumed = { _ in }
    }

    init(
        model: FeatureRootModel,
        navigationRequest: FeatureWorkspaceNavigationRequest? = nil,
        onNavigationRequestConsumed: @escaping @MainActor (UUID) -> Void = { _ in }
    ) {
        _model = State(initialValue: model)
        self.navigationRequest = navigationRequest
        self.onNavigationRequestConsumed = onNavigationRequestConsumed
    }

    public var body: some View {
        Group {
            if model.isLoading && !hasShownWorkspace {
                FeatureLoadingView()
                    .transition(.opacity)
            } else if showsHome || model.isLoading {
                // Still loading here means a returning user: Home's shell with
                // placeholder rows until the first snapshot lands.
                WorkspaceView(
                    model: model,
                    navigationRequest: navigationRequest,
                    onNavigationRequestConsumed: onNavigationRequestConsumed,
                    isAwaitingData: model.isLoading,
                    submitNewTask: { request in
                        await model.startTask(request)
                    },
                    submitMessage: { submission in
                        await model.sendMessage(submission)
                    }
                )
                .transition(.opacity)
            } else {
                ConnectionOnboardingView(model: model, presentation: .root(holdsScreen: $holdsOnboarding))
                    .onAppear { if model.snapshot.environments.isEmpty { startedFresh = true } }
                    .transition(.opacity)
            }
        }
        .animation(.easeInOut(duration: 0.3), value: model.isLoading)
        .animation(.easeInOut(duration: 0.3), value: showsHome)
        .preferredColorScheme(preferredColorScheme)
        .tint(T3Colors.accent)
        .background(T3Colors.background.ignoresSafeArea())
        .task { await model.start() }
        .onChange(of: showsHome) { _, ready in
            if ready && startedFresh && !setupCompleted { showingSetup = true; startedFresh = false }
        }
        .sheet(isPresented: $showingSetup) {
            AgentSetupView(model: model, onFinished: { setupCompleted = true; showingSetup = false })
        }
        // The palette lives in a store rather than the environment so every
        // T3Colors reader picks it up; this is the one place settings feed it.
        // `apply` no-ops unless the selection actually moved, so the frequent
        // non-theme settings updates cost nothing.
        .onChange(of: model.snapshot.settings.diffColorScheme, initial: true) { _, value in
            T3ThemeStore.shared.diffColorScheme = value
        }
        .onChange(of: themeSelection, initial: true) { _, selection in
            T3ThemeStore.shared.apply(
                lightPaletteID: selection.light,
                darkPaletteID: selection.dark,
                publishedPalettes: selection.publishedPalettes
            )
        }
        .alert(
            model.errorTitle ?? "Something Went Wrong",
            isPresented: Binding(
                get: { model.errorMessage != nil },
                set: { if !$0 { model.errorMessage = nil } }
            ),
            actions: {
                Button("OK") { model.errorMessage = nil }
            },
            message: {
                Text(model.errorMessage ?? "Unknown error")
            }
        )
        .onChange(of: model.isLoading) { _, isLoading in
            if !isLoading { hasShownWorkspace = shouldShowWorkspace }
        }
    }

    /// Onboarding keeps the screen through its success beat after the first
    /// pairing installs a server.
    private var showsHome: Bool {
        shouldShowWorkspace && !holdsOnboarding
    }

    /// Keep the last-known workspace visible through a degraded connection.
    /// Connection management also stays mounted while saved servers are being
    /// removed, so a disconnected fallback cannot destroy its own Settings sheet.
    private var shouldShowWorkspace: Bool {
        FeatureRootPresentation.showsWorkspace(
            snapshot: model.snapshot,
            isManagingConnections: model.isManagingConnections
        )
    }

    private var preferredColorScheme: ColorScheme? {
        switch model.snapshot.settings.appearance {
        case .system: nil
        case .light: .light
        case .dark: .dark
        }
    }

    /// Equatable so `onChange` fires on a palette edit and nothing else.
    private var themeSelection: FeatureThemeSelection {
        FeatureThemeSelection(
            light: model.snapshot.settings.lightThemeID,
            dark: model.snapshot.settings.darkThemeID,
            environmentID: activeEnvironmentID,
            publishedPalettes: T3PublishedPalette.resolve(activeEnvironmentThemes)
        )
    }

    private var activeEnvironmentID: String? {
        model.snapshot.environments.first(where: \.isActive)?.id
    }

    private var activeEnvironmentThemes: [EnvironmentTheme] {
        guard let activeEnvironmentID else { return [] }
        return model.snapshot.environmentThemesByEnvironment?[activeEnvironmentID] ?? []
    }
}

struct FeatureThemeSelection: Equatable {
    let light: String
    let dark: String
    let environmentID: String?
    let publishedPalettes: [T3PublishedPalette]
}

enum FeatureRootPresentation {
    static func showsWorkspace(
        snapshot: FeatureSnapshot,
        isManagingConnections: Bool
    ) -> Bool {
        isManagingConnections
            || snapshot.connection.state != .disconnected
            || !snapshot.environments.isEmpty
            || !snapshot.projects.isEmpty
            || !snapshot.threads.isEmpty
    }
}

/// The app mark over the palette background, so launch → loading → content
/// reads as one frame. Static apart from the system spinner.
private struct FeatureLoadingView: View {
    var body: some View {
        VStack(spacing: 34) {
            T3BrandMark(size: 76)
            ProgressView("Connecting to T3 Code…")
                .font(T3Typography.supporting)
                .foregroundStyle(T3Colors.textSecondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(T3Colors.background)
        .accessibilityElement(children: .combine)
    }
}
