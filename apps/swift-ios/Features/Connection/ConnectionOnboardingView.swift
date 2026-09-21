import SwiftUI
import UIKit

/// Pairing a computer: Welcome on first launch, "Add Server" from Settings and
/// Setup, and Confirm Connection for a pairing link opened in the app.
///
/// Typed details, pasted and scanned links, and opened links all land on one
/// details page, which swaps to the network checklist while connecting and to
/// the success beat once connected.
public struct ConnectionOnboardingView: View {
    /// Where the flow is shown, which decides who owns the navigation stack.
    enum Presentation {
        /// First launch at the app root, in its own stack. `holdsScreen` stays
        /// true while a page past Welcome is open: pairing installs the first
        /// server, which would otherwise swap the root to Home before the
        /// success beat plays.
        case root(holdsScreen: Binding<Bool>)
        /// "Add Server", pushed onto the caller's navigation stack. It pops
        /// itself once connected.
        case pushed
        /// A sheet with its own stack and a close button.
        case sheet
        /// A pairing link opened while Home is showing: Confirm Connection is
        /// the sheet's first page.
        case link(ConnectionDetails)
    }

    @SwiftUI.Environment(\.scenePhase) private var scenePhase
    @SwiftUI.Environment(\.dismiss) private var dismiss
    @SwiftUI.Environment(\.horizontalSizeClass) private var horizontalSizeClass
    @Bindable private var model: FeatureRootModel

    private let presentation: Presentation
    private let readinessChecker: any ConnectionReadinessChecking
    private let onConnected: @MainActor () -> Void
    private let onClose: (@MainActor () -> Void)?

    @State private var stage = ConnectionStage.form
    @State private var endpoint: String
    @State private var pairingCode: String
    @State private var problem: ConnectionProblem?
    @State private var source: ConnectionSource
    @State private var focusRequest = ConnectionFocusRequest(field: .endpoint)
    @State private var showingDetails = false
    @State private var showingT3Connect = false
    @State private var showingScanner = false
    @State private var handedOffToRoot = false
    @State private var connectionTask: Task<Void, Never>?
    @State private var connectionAttemptID: UUID?

    /// "Add Server" pushed onto the caller's navigation stack. With `onClose`
    /// it is instead a sheet with its own stack whose close button calls it.
    /// Either way the flow dismisses itself once connected, then calls
    /// `onConnected`.
    public init(
        model: FeatureRootModel,
        onConnected: @escaping @MainActor () -> Void = {},
        onCancel onClose: (@MainActor () -> Void)? = nil
    ) {
        self.init(
            model: model,
            presentation: onClose == nil ? .pushed : .sheet,
            onConnected: onConnected,
            onClose: onClose
        )
    }

    init(
        model: FeatureRootModel,
        presentation: Presentation,
        readinessChecker: any ConnectionReadinessChecking = LocalNetworkAccessChecker(),
        onConnected: @escaping @MainActor () -> Void = {},
        onClose: (@MainActor () -> Void)? = nil
    ) {
        self.model = model
        self.presentation = presentation
        self.readinessChecker = readinessChecker
        self.onConnected = onConnected
        self.onClose = onClose

        if case let .link(details) = presentation {
            _endpoint = State(initialValue: details.endpoint)
            _pairingCode = State(initialValue: details.pairingCode ?? "")
            _source = State(initialValue: .openedLink)
            _problem = State(initialValue: details.pairingCode == nil ? .missingCode : nil)
            _focusRequest = State(initialValue: ConnectionFocusRequest(
                field: details.pairingCode == nil ? .pairingCode : nil
            ))
        } else {
            _endpoint = State(initialValue: "")
            _pairingCode = State(initialValue: "")
            _source = State(initialValue: .manual)
        }
    }

    public var body: some View {
        Group {
            switch presentation {
            case .root:
                NavigationStack { flow }
            case .pushed:
                flow
            case .sheet:
                NavigationStack {
                    flow.t3SheetToolbar(.close, onDismiss: onClose)
                }
            case .link:
                NavigationStack { detailsPage }
            }
        }
        .fullScreenCover(isPresented: $showingScanner) {
            QRCodeScannerView(
                onScan: { details in
                    showingScanner = false
                    apply(details, source: .scan, connectAutomatically: true)
                },
                onPaste: { value in
                    showingScanner = false
                    applyConnectionString(value, source: .pastedLink)
                }
            )
        }
        .onOpenURL(perform: handleOpenedURL)
        .onChange(of: scenePhase) { _, phase in
            // Returning from Settings after allowing Local Network access
            // retries on its own, so the user never taps Connect twice.
            guard phase == .active, problem == .localNetworkDenied, stage == .form,
                  isShowingDetails else { return }
            submitDetails()
        }
        .onChange(of: holdsRoot, initial: true) { _, holds in
            guard case let .root(holdsScreen) = presentation else { return }
            holdsScreen.wrappedValue = holds
        }
    }

    // MARK: - Welcome and Add Server

    private var flow: some View {
        welcomePage
            .navigationDestination(isPresented: $showingDetails) { detailsPage }
            .navigationDestination(isPresented: $showingT3Connect) { t3ConnectPage }
    }

    @ViewBuilder
    private var welcomePage: some View {
        if isRoot {
            optionsList
                .t3BottomBar { welcomeActions }
        } else {
            optionsList
                .navigationTitle("Add Server")
                .navigationBarTitleDisplayMode(.large)
                .t3NavigationChrome()
        }
    }

    private var optionsList: some View {
        List {
            if isRoot {
                Section {
                    hero
                }
                .listRowBackground(Color.clear)
            }

            Section {
                if showsScanRow {
                    Button {
                        showingScanner = true
                    } label: {
                        ConnectionOptionRow(title: "Scan QR Code", systemImage: "qrcode.viewfinder", tint: .blue)
                    }
                }
                HStack(spacing: 12) {
                    ConnectionOptionRow(
                        title: "Pairing Link",
                        subtitle: "Copied from T3 Code",
                        systemImage: "link",
                        tint: .gray,
                        showsChevron: false
                    )
                    ConnectionPasteButton { value in
                        applyConnectionString(value, source: .pastedLink)
                    }
                }
                Button {
                    openManualEntry()
                } label: {
                    ConnectionOptionRow(title: "Enter Manually", systemImage: "keyboard", tint: .gray)
                }
            } footer: {
                Text("T3 Code on your computer shows a link and a QR code when you create a mobile connection.")
            }
            .t3GroupedRow()

            if !isRoot, t3ConnectCapability != nil {
                Section {
                    Button {
                        showingT3Connect = true
                    } label: {
                        ConnectionOptionRow(
                            title: "T3 Connect",
                            subtitle: "Environments linked to your account",
                            systemImage: "cloud",
                            tint: .ink
                        )
                    }
                }
                .t3GroupedRow()
            }
        }
        .listStyle(.insetGrouped)
        .t3GroupedListBackground()
        // On iPad the first-launch column sits in the middle of the screen
        // rather than under the top edge.
        .contentMargins(.top, isRoot && horizontalSizeClass == .regular ? 120 : 0, for: .scrollContent)
        .frame(maxWidth: isRoot ? 560 : .infinity)
        .frame(maxWidth: .infinity)
        .claimsPairingLinks()
    }

    private var hero: some View {
        VStack(spacing: 16) {
            T3BrandMark()
            Text("Your agents, wherever you are.")
                .font(.largeTitle.bold())
                .foregroundStyle(T3Colors.textPrimary)
            Text("Connect securely to T3 Code running on your computer.")
                .font(.body)
                .foregroundStyle(T3Colors.textSecondary)
        }
        .multilineTextAlignment(.center)
        .frame(maxWidth: .infinity)
        .padding(.top, 32)
        .padding(.bottom, 8)
        .accessibilityElement(children: .combine)
    }

    /// The one primary action at the bottom of Welcome: T3 Connect when this
    /// build has it, otherwise scanning.
    private var welcomeActions: some View {
        VStack(spacing: 12) {
            if t3ConnectCapability != nil {
                Button {
                    showingT3Connect = true
                } label: {
                    Label("Continue with T3 Connect", systemImage: "cloud")
                        .frame(maxWidth: .infinity)
                }
                .t3ProminentButtonStyle()
                .controlSize(.large)
                .accessibilityHint("Sign in to connect an environment linked to your T3 account")
            } else if QRCodeScannerView.isCameraAvailable {
                Button {
                    showingScanner = true
                } label: {
                    Label("Scan QR Code", systemImage: "qrcode.viewfinder")
                        .frame(maxWidth: .infinity)
                }
                .t3ProminentButtonStyle()
                .controlSize(.large)
            }

            Link("Get T3 Code for your computer", destination: Self.downloadURL)
                .font(T3Typography.supporting)
                .tint(T3Colors.accent)
        }
        .frame(maxWidth: 520)
    }

    @ViewBuilder
    private var t3ConnectPage: some View {
        if let capability = t3ConnectCapability {
            T3ConnectView(
                capability: capability,
                activeEnvironmentID: model.snapshot.environments.first(where: \.isActive)?.id
            ) {
                await model.reloadAfterConnection()
                // T3ConnectView plays the success haptic and marks the row in use.
                await finishConnection()
            }
        }
    }

    // MARK: - Details

    private var detailsPage: some View {
        ConnectionDetailsPage(
            endpoint: $endpoint,
            pairingCode: $pairingCode,
            stage: stage,
            problem: problem,
            source: source,
            focusRequest: focusRequest,
            connectedName: model.snapshot.environments.first(where: \.isActive)?.name,
            isSheetRoot: isLinkPresentation,
            onSubmit: submitDetails,
            onCancelAttempt: cancelToForm,
            onPaste: { applyConnectionString($0, source: .pastedLink) },
            onEndpointEdited: autofillIfPairingLink
        )
        .claimsPairingLinks()
        .onDisappear(perform: cancelConnectionAttempt)
    }

    // MARK: - State

    private var isRoot: Bool {
        if case .root = presentation { return true }
        return false
    }

    private var isLinkPresentation: Bool {
        if case .link = presentation { return true }
        return false
    }

    private var isShowingDetails: Bool {
        showingDetails || isLinkPresentation
    }

    /// Keeps the root on this flow from the first page past Welcome until the
    /// success beat hands off to Home.
    private var holdsRoot: Bool {
        (showingDetails || showingT3Connect) && !handedOffToRoot
    }

    /// At the root, scanning is the primary action when T3 Connect is absent,
    /// so its row would repeat the button below it.
    private var showsScanRow: Bool {
        QRCodeScannerView.isCameraAvailable && (!isRoot || t3ConnectCapability != nil)
    }

    private var t3ConnectCapability: (any T3ConnectCapable)? {
        guard let capability = model.client as? any T3ConnectCapable,
              capability.t3ConnectController.unavailableReason == nil
        else { return nil }
        return capability
    }

    private static let downloadURL = URL(string: "https://t3.codes/download")!

    // MARK: - Actions

    @MainActor
    private func openManualEntry() {
        cancelConnectionAttempt()
        source = .manual
        problem = nil
        stage = .form
        focusRequest = ConnectionFocusRequest(field: .endpoint)
        showingDetails = true
    }

    @MainActor
    private func handleOpenedURL(_ url: URL) {
        // Only pairing links belong here; thread and project links are the
        // root's to route.
        guard let route = try? PlatformDeepLinkParser.parse(url),
              case let .connection(endpoint, token) = route
        else { return }
        apply(ConnectionDetails(endpoint: endpoint, pairingCode: token), source: .openedLink)
    }

    @MainActor
    private func applyConnectionString(_ value: String, source: ConnectionSource) {
        do {
            apply(try ConnectionDetailsParser.parse(value), source: source)
        } catch {
            cancelConnectionAttempt()
            self.source = .manual
            stage = .form
            problem = .message(error.localizedDescription)
            focusRequest = ConnectionFocusRequest(field: .endpoint)
            showDetailsPage()
        }
    }

    @MainActor
    private func apply(
        _ details: ConnectionDetails,
        source: ConnectionSource,
        connectAutomatically: Bool = false
    ) {
        cancelConnectionAttempt()
        endpoint = details.endpoint
        pairingCode = details.pairingCode ?? ""
        self.source = source
        stage = .form
        showDetailsPage()
        guard let code = details.pairingCode else {
            problem = .missingCode
            focusRequest = ConnectionFocusRequest(field: .pairingCode)
            return
        }
        problem = nil
        focusRequest = ConnectionFocusRequest(field: nil)
        if connectAutomatically {
            connect(endpoint: details.endpoint, code: code)
        }
    }

    @MainActor
    private func showDetailsPage() {
        guard !isLinkPresentation else { return }
        // A link opened while T3 Connect is showing replaces it.
        showingT3Connect = false
        showingDetails = true
    }

    /// A complete pairing link typed or pasted into the Server field fills in
    /// both fields.
    @MainActor
    private func autofillIfPairingLink(_ value: String) {
        guard let details = try? ConnectionDetailsParser.parse(value),
              let code = details.pairingCode
        else { return }
        endpoint = details.endpoint
        pairingCode = code
        problem = nil
        focusRequest = ConnectionFocusRequest(field: nil)
    }

    @MainActor
    private func submitDetails() {
        let code = pairingCode.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !code.isEmpty, stage == .form else { return }
        do {
            connect(endpoint: try ConnectionDetailsParser.normalizedEndpoint(endpoint), code: code)
        } catch {
            problem = .message(error.localizedDescription)
            focusRequest = ConnectionFocusRequest(field: .endpoint)
        }
    }

    @MainActor
    private func connect(endpoint: String, code: String) {
        cancelConnectionAttempt()
        let attemptID = UUID()
        connectionAttemptID = attemptID
        self.endpoint = endpoint
        problem = nil
        stage = .checking

        connectionTask = Task {
            let readiness = await readinessChecker.check(endpoint: endpoint)
            guard !Task.isCancelled, connectionAttemptID == attemptID else { return }
            switch readiness {
            case .ready:
                stage = .connecting
            case .localNetworkDenied:
                fail(.localNetworkDenied)
                return
            case .unreachable:
                fail(.unreachable)
                return
            }

            model.errorMessage = nil
            let didConnect = await model.pair(endpoint: endpoint, token: code)
            guard !Task.isCancelled, connectionAttemptID == attemptID else { return }
            connectionAttemptID = nil
            connectionTask = nil

            if didConnect {
                PlatformHapticEngine.shared.play(.success)
                await finishConnection()
            } else {
                let rawError = model.errorMessage
                model.errorMessage = nil
                fail(.message(ConnectionErrorCopy.message(for: rawError)))
            }
        }
    }

    /// The success beat. At the root it holds for a moment so the checkmark
    /// is seen, then hands off to Home; elsewhere the flow closes itself.
    @MainActor
    private func finishConnection() async {
        switch presentation {
        case .root:
            stage = .success
            try? await Task.sleep(for: .milliseconds(800))
            handedOffToRoot = true
        case .pushed, .sheet, .link:
            dismiss()
        }
        onConnected()
    }

    @MainActor
    private func fail(_ problem: ConnectionProblem) {
        connectionAttemptID = nil
        connectionTask = nil
        self.problem = problem
        stage = .form
    }

    /// Cancel while checking or pairing: back to the filled-in form.
    @MainActor
    private func cancelToForm() {
        cancelConnectionAttempt()
        model.errorMessage = nil
        stage = .form
    }

    @MainActor
    private func cancelConnectionAttempt() {
        connectionTask?.cancel()
        connectionTask = nil
        connectionAttemptID = nil
    }
}

// MARK: - Details page

/// The Server and Code form, replaced by the network checklist while
/// connecting and by the success beat once connected.
private struct ConnectionDetailsPage: View {
    @Binding var endpoint: String
    @Binding var pairingCode: String
    let stage: ConnectionStage
    let problem: ConnectionProblem?
    let source: ConnectionSource
    let focusRequest: ConnectionFocusRequest
    let connectedName: String?
    /// Confirm Connection for an opened link is its sheet's first page, so it
    /// carries the sheet's cancel and confirm buttons.
    let isSheetRoot: Bool
    let onSubmit: () -> Void
    let onCancelAttempt: () -> Void
    let onPaste: (String) -> Void
    let onEndpointEdited: (String) -> Void

    @FocusState private var focusedField: ConnectionField?
    @ScaledMetric(relativeTo: .body) private var labelWidth: CGFloat = 64

    var body: some View {
        Group {
            switch stage {
            case .form:
                form
            case .checking, .connecting:
                progress
            case .success:
                ConnectionSuccessView(serverName: connectedName)
            }
        }
        .navigationTitle(stage == .form ? source.heading : "")
        .navigationBarTitleDisplayMode(stage == .form && !isSheetRoot ? .large : .inline)
        .navigationBarBackButtonHidden(stage != .form)
        .t3NavigationChrome()
        .modifier(ConnectionDetailsToolbar(
            stage: stage,
            canSubmit: canSubmit,
            isSheetRoot: isSheetRoot,
            onSubmit: onSubmit,
            onCancelAttempt: onCancelAttempt
        ))
        .task(id: focusRequest) {
            focusedField = focusRequest.field
        }
    }

    private var form: some View {
        Form {
            if let problem, let notice = problem.notice {
                Section {
                    ConnectionProblemRow(
                        title: notice.title,
                        message: notice.message,
                        systemImage: notice.systemImage
                    )
                    if problem == .localNetworkDenied {
                        Button("Open Settings") {
                            guard let url = URL(string: UIApplication.openSettingsURLString) else { return }
                            UIApplication.shared.open(url)
                        }
                        .tint(T3Colors.accent)
                    }
                }
                .t3GroupedRow()
            }

            Section {
                LabeledContent {
                    TextField("192.168.1.5:3773", text: $endpoint)
                        .keyboardType(.URL)
                        .textContentType(.URL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .submitLabel(.next)
                        .focused($focusedField, equals: .endpoint)
                        .onSubmit { focusedField = .pairingCode }
                        .onChange(of: endpoint) { _, value in onEndpointEdited(value) }
                        .accessibilityLabel("Server address")
                } label: {
                    Text("Server").frame(width: labelWidth, alignment: .leading)
                }
                LabeledContent {
                    TextField("12-character code", text: $pairingCode)
                        .font(.body.monospaced())
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .submitLabel(.go)
                        .focused($focusedField, equals: .pairingCode)
                        .onSubmit(onSubmit)
                        .accessibilityLabel("Pairing code")
                } label: {
                    Text("Code").frame(width: labelWidth, alignment: .leading)
                }
            } footer: {
                if let message = problem?.footerMessage {
                    Text(message).foregroundStyle(T3Colors.danger)
                } else {
                    Text(source.footer)
                }
            }
            .t3GroupedRow()

            Section {
                HStack(spacing: 12) {
                    Text(source == .manual ? "Have a pairing link?" : "Have a different link?")
                        .foregroundStyle(T3Colors.textPrimary)
                    Spacer(minLength: 8)
                    ConnectionPasteButton(onPaste: onPaste)
                }
            }
            .t3GroupedRow()
        }
        .t3GroupedListBackground()
        .scrollDismissesKeyboard(.interactively)
    }

    private var progress: some View {
        List {
            Section {
                VStack(spacing: 8) {
                    Image(systemName: "laptopcomputer")
                        .font(.largeTitle)
                        .imageScale(.large)
                        .foregroundStyle(T3Colors.textTertiary)
                        .padding(.bottom, 6)
                    Text(stage == .checking ? "Checking Network Access" : "Connecting Securely")
                        .font(.title2.bold())
                        .foregroundStyle(T3Colors.textPrimary)
                    Text(displayEndpoint)
                        .font(.footnote.monospaced())
                        .foregroundStyle(T3Colors.textTertiary)
                        .lineLimit(2)
                }
                .multilineTextAlignment(.center)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 24)
                .listRowBackground(Color.clear)
                .accessibilityElement(children: .combine)
            }

            Section {
                ConnectionProgressRow(title: "Server details", state: .complete)
                ConnectionProgressRow(
                    title: EndpointNetworkScope.isLocal(endpoint) ? "Local network access" : "Network access",
                    state: stage == .checking ? .active : .complete
                )
                ConnectionProgressRow(
                    title: "Secure pairing",
                    state: stage == .connecting ? .active : .waiting
                )
            } footer: {
                Text("Keep T3 Code open on your computer.")
            }
            .t3GroupedRow()
        }
        .listStyle(.insetGrouped)
        .t3GroupedListBackground()
    }

    private var canSubmit: Bool {
        !endpoint.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && !pairingCode.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private var displayEndpoint: String {
        for scheme in ["https://", "http://"] where endpoint.lowercased().hasPrefix(scheme) {
            return String(endpoint.dropFirst(scheme.count))
        }
        return endpoint
    }
}

/// Connect in the form's toolbar, and Cancel in place of the back button while
/// checking or pairing. An opened link's sheet uses the sheet toolbar instead,
/// whose cancel returns to the form mid-attempt and closes the sheet otherwise.
private struct ConnectionDetailsToolbar: ViewModifier {
    let stage: ConnectionStage
    let canSubmit: Bool
    let isSheetRoot: Bool
    let onSubmit: () -> Void
    let onCancelAttempt: () -> Void

    func body(content: Content) -> some View {
        if isSheetRoot {
            content.t3SheetToolbar(
                .cancel,
                confirm: T3SheetConfirmation(
                    title: "Connect",
                    isEnabled: canSubmit,
                    isBusy: stage.isInProgress || stage == .success,
                    action: onSubmit
                ),
                onDismiss: stage.isInProgress ? onCancelAttempt : nil
            )
        } else {
            content.toolbar {
                if stage == .form {
                    ToolbarItem(placement: .confirmationAction) {
                        ConnectionConnectButton(isEnabled: canSubmit, action: onSubmit)
                    }
                } else if stage.isInProgress {
                    ToolbarItem(placement: .cancellationAction) {
                        if #available(iOS 26, *) {
                            Button(role: .cancel, action: onCancelAttempt)
                        } else {
                            Button("Cancel", role: .cancel, action: onCancelAttempt)
                        }
                    }
                }
            }
        }
    }
}

/// The form's commit button: ink glass on iOS 26, bold text before.
private struct ConnectionConnectButton: View {
    let isEnabled: Bool
    let action: () -> Void

    var body: some View {
        if #available(iOS 26, *) {
            Button("Connect", action: action)
                .buttonStyle(.glassProminent)
                .tint(T3Colors.primaryAction)
                .foregroundStyle(T3Colors.primaryActionForeground)
                .disabled(!isEnabled)
        } else {
            Button(action: action) {
                Text("Connect").fontWeight(.semibold)
            }
            .disabled(!isEnabled)
        }
    }
}

private struct ConnectionSuccessView: View {
    let serverName: String?
    @State private var celebrates = false

    var body: some View {
        VStack(spacing: 12) {
            Image(systemName: "checkmark.circle.fill")
                .font(.largeTitle)
                .imageScale(.large)
                .foregroundStyle(T3Colors.success)
                .symbolEffect(.bounce, value: celebrates)
            Text(serverName.map { "Connected to \($0)" } ?? "You’re Connected")
                .font(.title.bold())
                .foregroundStyle(T3Colors.textPrimary)
            Text("Loading your projects and threads.")
                .font(T3Typography.threadBody)
                .foregroundStyle(T3Colors.textSecondary)
        }
        .multilineTextAlignment(.center)
        .padding(32)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(T3Colors.background)
        .accessibilityElement(children: .combine)
        .onAppear { celebrates = true }
    }
}

private struct ConnectionOptionRow: View {
    let title: String
    var subtitle: String?
    let systemImage: String
    let tint: T3SettingsTile.Tint
    var showsChevron = true

    var body: some View {
        HStack(spacing: 12) {
            T3SettingsTile(systemImage, tint: tint)
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .foregroundStyle(T3Colors.textPrimary)
                if let subtitle {
                    Text(subtitle)
                        .font(T3Typography.supporting)
                        .foregroundStyle(T3Colors.textTertiary)
                }
            }
            Spacer(minLength: 8)
            if showsChevron {
                Image(systemName: "chevron.right")
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(T3Colors.textTertiary)
                    .accessibilityHidden(true)
            }
        }
        .contentShape(Rectangle())
    }
}

private struct ConnectionProgressRow: View {
    let title: String
    let state: ConnectionProgressState

    var body: some View {
        HStack(spacing: 14) {
            Group {
                switch state {
                case .complete:
                    Image(systemName: "checkmark.circle.fill")
                        .foregroundStyle(T3Colors.success)
                case .active:
                    ProgressView()
                        .controlSize(.small)
                case .waiting:
                    Image(systemName: "circle")
                        .foregroundStyle(T3Colors.textTertiary)
                }
            }
            .font(.title3)
            .frame(width: 24)

            Text(title)
                .font(.body.weight(state == .active ? .semibold : .regular))
                .foregroundStyle(state == .waiting ? T3Colors.textTertiary : T3Colors.textPrimary)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(title)
        .accessibilityValue(state.accessibilityValue)
    }
}

// MARK: - Model

enum ConnectionStage: Equatable {
    case form
    case checking
    case connecting
    case success

    var isInProgress: Bool {
        self == .checking || self == .connecting
    }
}

/// How the details got onto the page, which sets its title and footer.
enum ConnectionSource: Equatable {
    case manual
    case pastedLink
    case openedLink
    case scan

    var heading: String {
        self == .manual ? "Connect Manually" : "Confirm Connection"
    }

    var footer: String {
        switch self {
        case .manual:
            "Both values are shown in T3 Code when you create a mobile connection."
        case .pastedLink:
            "From the pairing link you pasted. Check the address before connecting."
        case .openedLink:
            "From a link you opened. Only connect to computers you trust."
        case .scan:
            "From the QR code you scanned. Check the address before connecting."
        }
    }
}

/// Why the last attempt stopped, and where the details page shows it.
enum ConnectionProblem: Equatable {
    /// Local Network access is off for this app.
    case localNetworkDenied
    /// The address did not answer.
    case unreachable
    /// The link carried an address but no pairing code.
    case missingCode
    /// A parse or pairing failure, already in user-facing words.
    case message(String)

    struct Notice: Equatable {
        let title: String
        let message: String
        let systemImage: String
    }

    /// Network problems get their own section above the fields.
    var notice: Notice? {
        switch self {
        case .localNetworkDenied:
            Notice(
                title: "Local Network Access Is Off",
                message: "Allow it so this device can find T3 Code on your computer. T3 Code tries again when you come back.",
                systemImage: "wifi.slash"
            )
        case .unreachable:
            Notice(
                title: "Can’t Reach the Server",
                message: "This device cannot reach that server. Confirm the address and that both devices are on the same network.",
                systemImage: "wifi.exclamationmark"
            )
        case .missingCode, .message:
            nil
        }
    }

    /// Everything else sits in the footer under the fields.
    var footerMessage: String? {
        switch self {
        case .localNetworkDenied, .unreachable:
            nil
        case .missingCode:
            "The link did not include a pairing code. Enter it above."
        case let .message(message):
            message
        }
    }
}

enum ConnectionField: Hashable {
    case endpoint
    case pairingCode
}

/// A request to move focus. A fresh ID re-runs the request even when the field
/// is the same one as last time.
struct ConnectionFocusRequest: Equatable {
    let id = UUID()
    let field: ConnectionField?
}

private enum ConnectionProgressState {
    case complete
    case active
    case waiting

    var accessibilityValue: String {
        switch self {
        case .complete: "Done"
        case .active: "In progress"
        case .waiting: "Waiting"
        }
    }
}

// MARK: - Pairing links

/// Tracks whether an onboarding page is on screen. Those pages confirm
/// pairing links themselves, so the app root should leave such links alone
/// rather than pair them a second time.
@MainActor
enum ConnectionOnboardingLinks {
    private static var visiblePages = Set<UUID>()

    static var areHandledByOnboarding: Bool {
        !visiblePages.isEmpty
    }

    fileprivate static func pageAppeared(_ id: UUID) {
        visiblePages.insert(id)
    }

    fileprivate static func pageDisappeared(_ id: UUID) {
        visiblePages.remove(id)
    }
}

private struct ClaimsPairingLinks: ViewModifier {
    @State private var id = UUID()

    func body(content: Content) -> some View {
        content
            .onAppear { ConnectionOnboardingLinks.pageAppeared(id) }
            .onDisappear { ConnectionOnboardingLinks.pageDisappeared(id) }
    }
}

private extension View {
    func claimsPairingLinks() -> some View {
        modifier(ClaimsPairingLinks())
    }
}
