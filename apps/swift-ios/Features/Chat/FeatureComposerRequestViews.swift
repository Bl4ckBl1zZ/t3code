import SwiftUI

/// A pending approval, in place of the editor.
///
/// The detail is capped so a long command or patch can never push the
/// decision off screen: it scrolls inside its box, and the whole text opens in
/// a sheet. The decision row is always on screen.
struct FeatureComposerApprovalPanel: View {
    let approval: FeatureApproval
    let position: Int
    let total: Int
    let isResponding: Bool
    let onDecision: (FeatureApprovalDecision) -> Void
    let onCancelTurn: () -> Void

    /// The button that was tapped, so its spinner says which answer is on
    /// the way while the others stay readable.
    private enum Choice: Equatable {
        case decision(FeatureApprovalDecision)
        case cancelTurn
    }

    @State private var pendingChoice: Choice?
    @State private var showsFullDetail = false
    @ScaledMetric(relativeTo: .body) private var detailMaximumHeight: CGFloat = 170

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Label(approval.title, systemImage: kindSymbol)
                    .font(T3Typography.navigationTitle)
                    .foregroundStyle(T3Colors.textPrimary)
                    .lineLimit(2)
                    .frame(maxWidth: .infinity, alignment: .leading)

                if total > 1 {
                    Text("\(position) of \(total)")
                        .font(T3Typography.supporting.monospacedDigit())
                        .foregroundStyle(T3Colors.textSecondary)
                }
            }

            if hasDetail {
                detailBox
            }

            decisions
        }
        .padding(.horizontal, 12)
        .padding(.top, 14)
        .padding(.bottom, 12)
        .disabled(isResponding)
        .t3SensoryFeedback(.warning, trigger: approval.id)
        .onChange(of: isResponding) { _, responding in
            if !responding { pendingChoice = nil }
        }
        .onChange(of: approval.id) { pendingChoice = nil }
        .sheet(isPresented: $showsFullDetail) {
            NavigationStack {
                ScrollView {
                    detailText
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(16)
                }
                .navigationTitle(detailTitle)
                .navigationBarTitleDisplayMode(.inline)
                .t3SheetToolbar(.close)
                .t3NavigationChrome()
            }
            .presentationDetents([.medium, .large])
        }
        .accessibilityElement(children: .contain)
    }

    // MARK: - Detail

    private var trimmedDetail: String {
        approval.detail.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// An approval with nothing to show gets no box: an empty labelled box
    /// reads as content that failed to load.
    private var hasDetail: Bool {
        !trimmedDetail.isEmpty
    }

    private var isCode: Bool {
        approval.kind == .command || approval.kind == .patch
    }

    /// Long enough that the capped box scrolls, so the full text gets its
    /// own page. A line count rather than a measurement keeps this off the
    /// layout pass.
    private var isLongDetail: Bool {
        trimmedDetail.count > 400 || trimmedDetail.reduce(0) { $1 == "\n" ? $0 + 1 : $0 } >= 7
    }

    private var detailText: some View {
        Text(trimmedDetail)
            .font(isCode ? T3Typography.code : T3Typography.threadBody)
            .foregroundStyle(T3Colors.textPrimary.opacity(0.92))
            .lineSpacing(3)
            .textSelection(.enabled)
    }

    @ViewBuilder
    private var detailBox: some View {
        let shape = RoundedRectangle(cornerRadius: 14, style: .continuous)
        VStack(alignment: .leading, spacing: 6) {
            ComposerCappedScrollView(maximumHeight: detailMaximumHeight) {
                detailText
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(10)
            }
            .background(isCode ? T3Colors.input : Color.clear, in: shape)

            if isLongDetail {
                Button("Show Full \(detailTitle)") { showsFullDetail = true }
                    .font(T3Typography.supportingStrong)
                    .buttonStyle(.borderless)
                    .frame(minHeight: T3Metrics.minimumTapTarget)
            }
        }
    }

    private var detailTitle: String {
        switch approval.kind {
        case .command: "Command"
        case .fileRead: "File Access"
        case .fileChange: "File Change"
        case .patch: "Patch"
        case .other: "Details"
        }
    }

    private var kindSymbol: String {
        switch approval.kind {
        case .command: "terminal"
        case .fileRead: "doc"
        case .fileChange: "pencil"
        case .patch: "doc.badge.gearshape"
        case .other: "exclamationmark.shield"
        }
    }

    // MARK: - Decisions

    @ViewBuilder
    private var decisions: some View {
        if let options = approval.options {
            VStack(alignment: .leading, spacing: 8) {
                ForEach(options, id: \.decision) { option in
                    decisionButton(option.label, choice: .decision(option.decision))
                    if let warning = option.warning {
                        Label(warning, systemImage: "exclamationmark.triangle")
                            .font(T3Typography.supporting)
                            .foregroundStyle(T3Colors.warning)
                    }
                }
                decisionButton("Cancel Turn", choice: .cancelTurn)
            }
        } else {
            Grid(horizontalSpacing: 8, verticalSpacing: 8) {
                GridRow {
                    decisionButton("Allow Once", choice: .decision(.allowOnce))
                    decisionButton("Allow for Session", choice: .decision(.allowForSession))
                }
                GridRow {
                    decisionButton("Decline", choice: .decision(.deny))
                    decisionButton("Cancel Turn", choice: .cancelTurn)
                }
            }
        }
    }

    @ViewBuilder
    private func decisionButton(_ title: String, choice: Choice) -> some View {
        let button = Button(role: role(for: choice)) {
            pendingChoice = choice
            switch choice {
            case let .decision(decision): onDecision(decision)
            case .cancelTurn: onCancelTurn()
            }
        } label: {
            ZStack {
                Text(title)
                    .lineLimit(1)
                    .minimumScaleFactor(0.8)
                    .opacity(isPending(choice) ? 0 : 1)
                if isPending(choice) {
                    ProgressView()
                        .controlSize(.small)
                }
            }
            .frame(maxWidth: .infinity, minHeight: 30)
        }
        .buttonBorderShape(.capsule)
        .controlSize(.large)

        switch choice {
        case .decision(.allowOnce):
            button.t3ProminentButtonStyle()
        case .decision(.deny):
            button.buttonStyle(.bordered).tint(T3Colors.danger)
        case .cancelTurn:
            button.buttonStyle(.bordered).tint(T3Colors.textSecondary)
        case .decision:
            button.t3SecondaryButtonStyle()
        }
    }

    private func role(for choice: Choice) -> ButtonRole? {
        choice == .decision(.deny) ? .destructive : nil
    }

    private func isPending(_ choice: Choice) -> Bool {
        isResponding && pendingChoice == choice
    }
}

struct FeatureComposerUserInputPanel: View {
    let input: FeatureUserInput
    let isResponding: Bool
    let onSubmit: ([String: FeatureInputAnswer], [String: [FeatureUploadAttachment]], Bool) -> Void
    /// Hands back text the reader typed into "Other…" that selecting an option
    /// has just replaced, so the composer can park it in the thread draft.
    let onDisplaceCustomAnswer: (String) -> Void

    @SwiftUI.Environment(\.accessibilityReduceMotion) private var reduceMotion

    @State private var answers: [String: FeatureInputAnswer] = [:]
    @State private var files: [String: [FeatureDraftAttachment]] = [:]
    @State private var preparation = FeatureAttachmentPreparationState()
    @State private var questionIndex = 0
    /// The question the reader collapsed, rather than a bare flag: the panel
    /// takes over the whole composer pill, so a tall prompt buries the
    /// transcript it is asking about. Keying on the id reopens the panel when
    /// the prompt moves on, which happens without a tap — answering a
    /// single-select question advances it.
    @State private var collapsedQuestionID: String?
    /// A long question shows four lines until the reader asks for the rest,
    /// so it cannot grow the pill past the screen.
    @State private var expandedQuestionID: String?
    @State private var unansweredWarnings = 0

    var body: some View {
        Group {
            if let question = activeQuestion {
                VStack(spacing: 0) {
                    Button {
                        collapsedQuestionID = FeatureComposerPromptCollapse.toggled(
                            collapsedQuestionID: collapsedQuestionID,
                            activeQuestionID: question.id
                        )
                    } label: {
                        VStack(alignment: .leading, spacing: 0) {
                            HStack(spacing: 8) {
                                Text(headerLine(question))
                                    .font(T3Typography.supporting)
                                    .foregroundStyle(T3Colors.textSecondary)
                                    .lineLimit(1)

                                Spacer()

                                Image(systemName: isCollapsed ? "chevron.down" : "chevron.up")
                                    .font(T3Typography.supportingStrong)
                                    .foregroundStyle(T3Colors.textSecondary)
                                    .contentTransition(.symbolEffect(.replace))
                                    .frame(width: 28, height: 28)
                                    .t3GlassEffect(.regular, in: Circle())
                                    .accessibilityHidden(true)
                            }

                            // Collapsed, the question itself is the only thing
                            // worth keeping on screen — without it the header
                            // is an unlabelled bar.
                            Text(question.question)
                                .font(T3Typography.navigationTitle)
                                .foregroundStyle(T3Colors.textPrimary)
                                .fixedSize(horizontal: false, vertical: true)
                                .lineLimit(questionLineLimit(question))
                                .padding(.top, 5)
                        }
                        .padding(.horizontal, 15)
                        .padding(.top, 12)
                        .padding(.bottom, needsMoreButton(question) ? 0 : 12)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .contentShape(.rect)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(question.header)
                    .accessibilityValue(question.question)
                    .accessibilityHint(isCollapsed ? "Show the options" : "Hide the options")

                    if needsMoreButton(question) {
                        Button("More") { expandedQuestionID = question.id }
                            .font(T3Typography.supportingStrong)
                            .buttonStyle(.borderless)
                            .frame(maxWidth: .infinity, minHeight: 32, alignment: .leading)
                            .padding(.horizontal, 15)
                    }

                    if !isCollapsed {
                        collapsibleBody(question)
                    }
                }
                .disabled(isResponding)
                .animation(
                    VoiceMorph.appearance(reduceMotion: reduceMotion),
                    value: isCollapsed
                )
                .t3SensoryFeedback(.selection, trigger: answers)
                .t3SensoryFeedback(.warning, trigger: unansweredWarnings)
            }
        }
        .onChange(of: input.id) {
            answers = [:]
            files = [:]
            questionIndex = 0
            collapsedQuestionID = nil
            expandedQuestionID = nil
        }
        .onChange(of: questionIDs) { previousIDs, currentIDs in
            questionIndex = FeatureComposerQuestionReconciliation.index(
                current: questionIndex,
                previousQuestionIDs: previousIDs,
                currentQuestionIDs: currentIDs
            )
            answers = FeatureComposerQuestionReconciliation.answers(
                answers,
                currentQuestionIDs: currentIDs
            )
        }
    }

    private var isCollapsed: Bool {
        FeatureComposerPromptCollapse.isCollapsed(
            collapsedQuestionID: collapsedQuestionID,
            activeQuestionID: activeQuestion?.id
        )
    }

    /// "Question 1 of 2 · Choose any", or the provider's header alone.
    private func headerLine(_ question: FeatureInputQuestion) -> String {
        var parts: [String] = []
        if input.questions.count > 1 {
            parts.append("Question \(questionIndex + 1) of \(input.questions.count)")
        } else if !question.header.isEmpty {
            parts.append(question.header)
        }
        if question.allowsMultiple { parts.append("Choose any") }
        return parts.joined(separator: " · ")
    }

    private func questionLineLimit(_ question: FeatureInputQuestion) -> Int? {
        if isCollapsed { return 1 }
        return expandedQuestionID == question.id ? nil : 4
    }

    /// A rough cut on length rather than a measurement: past about four lines'
    /// worth of text the question folds behind "More".
    private func needsMoreButton(_ question: FeatureInputQuestion) -> Bool {
        !isCollapsed && expandedQuestionID != question.id && question.question.count > 180
    }

    @ViewBuilder
    private func collapsibleBody(_ question: FeatureInputQuestion) -> some View {
        VStack(spacing: 0) {
            Divider().overlay(T3Colors.separator)

            ScrollView {
                VStack(spacing: 6) {
                    ForEach(
                        Array(question.options.enumerated()),
                        id: \.offset
                    ) { _, option in
                        optionButton(option, question: question)
                    }
                }
                .padding(.horizontal, 10)
                .padding(.top, 10)
            }
            .frame(maxHeight: 320)
            .scrollIndicators(.hidden)

            if question.allowCustomAnswer != false {
            HStack(spacing: 8) {
                Image(systemName: "pencil")
                    .font(T3Typography.supporting)
                    .foregroundStyle(T3Colors.textTertiary)

                TextField(
                    "Write custom answer",
                    text: answerBinding(for: question),
                    axis: .vertical
                )
                .font(T3Typography.composer)
                .lineLimit(1...4)
                .submitLabel(.return)
            }
            .padding(.horizontal, 12)
            .frame(minHeight: T3Metrics.minimumTapTarget)
            .background(
                T3Colors.input,
                in: RoundedRectangle(cornerRadius: 14, style: .continuous)
            )
            .padding(.horizontal, 10)
            .padding(.top, 7)

            }
            if input.allowsAttachments == true && question.allowCustomAnswer != false {
                let questionFiles = Binding(
                    get: { files[question.id] ?? [] },
                    set: { files[question.id] = $0 }
                )
                HStack(alignment: .bottom, spacing: 4) {
                    FeatureImageAttachmentPicker(
                        attachments: questionFiles,
                        preparationState: $preparation,
                        maximumCount: max(0, 8 - files.filter { $0.key != question.id }.values.reduce(0) { $0 + $1.count })
                    )
                    FeatureAttachmentStrip(
                        attachments: questionFiles,
                        pendingCount: preparation.pendingItemCount
                    )
                }
                .padding(.horizontal, 10)
                .padding(.top, 4)
            }
            HStack(spacing: 8) {
                if input.allowsDismiss == true {
                    Button("Dismiss") { onSubmit([:], [:], true) }
                        .buttonStyle(.bordered)
                        .buttonBorderShape(.capsule)
                        .tint(T3Colors.textSecondary)
                        .disabled(preparation.isPreparing)
                }
                if questionIndex > 0 {
                    Button("Back") {
                        questionIndex -= 1
                    }
                    .t3SecondaryButtonStyle()
                    .buttonBorderShape(.capsule)
                }

                Spacer()

                Button(action: advanceOrSubmit) {
                    ZStack {
                        Text(isLastQuestion ? "Submit" : "Next")
                            .opacity(isResponding ? 0 : 1)
                        if isResponding {
                            ProgressView()
                                .controlSize(.small)
                        }
                    }
                }
                .t3ProminentButtonStyle()
                .buttonBorderShape(.capsule)
                .disabled(!canAdvance)
            }
            .controlSize(.large)
            .frame(minHeight: T3Metrics.minimumTapTarget)
            .padding(.horizontal, 10)
            .padding(.top, 9)
            .padding(.bottom, 11)
        }
    }

    private var activeQuestion: FeatureInputQuestion? {
        guard input.questions.indices.contains(questionIndex) else { return nil }
        return input.questions[questionIndex]
    }

    private var questionIDs: [String] {
        input.questions.map(\.id)
    }

    private var isLastQuestion: Bool {
        questionIndex >= input.questions.count - 1
    }

    private var canAdvance: Bool {
        guard let activeQuestion else { return false }
        return !preparation.isPreparing && normalizedAnswer(for: activeQuestion.id) != nil
    }

    private var normalizedAnswers: [String: FeatureInputAnswer]? {
        var result: [String: FeatureInputAnswer] = [:]
        for question in input.questions {
            guard let answer = normalizedAnswer(for: question.id) else { return nil }
            result[question.id] = answer
        }
        return result
    }

    private func optionButton(
        _ option: FeatureInputOption,
        question: FeatureInputQuestion
    ) -> some View {
        let isSelected = isOptionSelected(option.answerValue, for: question)

        return Button {
            select(option.answerValue, for: question)
        } label: {
            HStack(alignment: .center, spacing: 10) {
                // Multiple choice leads with a selection circle, as system
                // multi-select lists do; single choice gets a trailing check.
                if question.allowsMultiple {
                    Image(systemName: isSelected ? "checkmark.circle.fill" : "circle")
                        .font(.title3)
                        .foregroundStyle(isSelected ? T3Colors.accent : T3Colors.textTertiary)
                        .contentTransition(.symbolEffect(.replace))
                        .accessibilityHidden(true)
                }

                VStack(alignment: .leading, spacing: 2) {
                    Text(option.label)
                        .font(T3Typography.control)
                        .foregroundStyle(T3Colors.textPrimary)

                    if !option.detail.isEmpty, option.detail != option.label {
                        Text(option.detail)
                            .font(T3Typography.supporting)
                            .foregroundStyle(T3Colors.textSecondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }

                Spacer(minLength: 8)

                if isSelected, !question.allowsMultiple {
                    Image(systemName: "checkmark")
                        .font(T3Typography.supporting.weight(.bold))
                        .foregroundStyle(T3Colors.accent)
                        .accessibilityHidden(true)
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 9)
            .frame(maxWidth: .infinity, minHeight: T3Metrics.minimumTapTarget, alignment: .leading)
            .background(T3Colors.subtle, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(isSelected ? .isSelected : [])
    }

    private func answerBinding(for question: FeatureInputQuestion) -> Binding<String> {
        Binding(
            get: {
                FeatureComposerCustomAnswer.text(
                    in: answers[question.id],
                    for: question
                )
            },
            set: {
                answers[question.id] = FeatureComposerCustomAnswer.replacingText(
                    in: answers[question.id],
                    with: $0,
                    for: question
                )
            }
        )
    }

    private func select(_ label: String, for question: FeatureInputQuestion) {
        // Read before toggling. A single-select option replaces the whole
        // answer, and the advance below moves the panel off this question, so
        // anything typed into "Other…" would have nowhere left to live. A
        // multi-select keeps its custom text in the same selection array, so
        // displacing it there would only duplicate it into the draft.
        if !question.allowsMultiple {
            let displaced = FeatureComposerCustomAnswer.text(
                in: answers[question.id],
                for: question
            )
            if !displaced.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                onDisplaceCustomAnswer(displaced)
            }
        }
        answers[question.id] = (answers[question.id] ?? .selections([]))
            .togglingOption(label, allowsMultiple: question.allowsMultiple)
        if question.allowsMultiple {
            return
        }
        guard !isLastQuestion else { return }
        let selectedQuestionID = question.id
        Task { @MainActor in
            await Task.yield()
            guard activeQuestion?.id == selectedQuestionID,
                  !isLastQuestion else {
                return
            }
            questionIndex += 1
        }
    }

    private func advanceOrSubmit() {
        guard canAdvance else { return }
        if !isLastQuestion {
            questionIndex += 1
        } else if let normalizedAnswers {
            onSubmit(normalizedAnswers, files.mapValues { $0.map { FeatureUploadAttachment(data: $0.data, name: $0.filename, mimeType: $0.mimeType) } }, false)
        } else if let unanswered = input.questions.firstIndex(where: {
            normalizedAnswer(for: $0.id) == nil
        }) {
            unansweredWarnings += 1
            questionIndex = unanswered
        }
    }

    private func normalizedAnswer(for questionID: String) -> FeatureInputAnswer? {
        answers[questionID]?.normalized ?? ((files[questionID]?.isEmpty == false) ? .text("See attached files.") : nil)
    }

    private func isOptionSelected(_ label: String, for question: FeatureInputQuestion) -> Bool {
        switch answers[question.id] {
        case let .text(value):
            return !question.allowsMultiple && value == label
        case let .selections(values):
            return values.contains(label)
        case nil:
            return false
        }
    }
}

enum FeatureComposerCustomAnswer {
    static func text(
        in answer: FeatureInputAnswer?,
        for question: FeatureInputQuestion
    ) -> String {
        let optionLabels = Set(question.options.map(\.answerValue))
        switch answer {
        case let .text(value):
            return optionLabels.contains(value) ? "" : value
        case let .selections(values):
            return values.first(where: { !optionLabels.contains($0) }) ?? ""
        case nil:
            return ""
        }
    }

    /// Moves an answer the reader typed but did not send into the thread draft,
    /// after whatever was already waiting there. Selecting an option outranks a
    /// custom answer, and their own words are not ours to drop on that tap.
    static func carryingDisplacedAnswer(_ answer: String, into draft: String) -> String {
        let displaced = answer.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !displaced.isEmpty else { return draft }
        var trimmedDraft = draft
        while let last = trimmedDraft.last, last.isWhitespace { trimmedDraft.removeLast() }
        guard !trimmedDraft.isEmpty else { return displaced }
        return "\(trimmedDraft)\n\n\(displaced)"
    }

    static func replacingText(
        in answer: FeatureInputAnswer?,
        with text: String,
        for question: FeatureInputQuestion
    ) -> FeatureInputAnswer {
        guard question.allowsMultiple else { return .text(text) }
        let optionLabels = Set(question.options.map(\.answerValue))
        let selectedOptions: [String]
        if case let .selections(values) = answer {
            selectedOptions = values.filter(optionLabels.contains)
        } else {
            selectedOptions = []
        }
        return .selections(text.isEmpty ? selectedOptions : selectedOptions + [text])
    }
}

/// Which question the reader has collapsed, if any.
///
/// State is the collapsed question's id rather than a bool so the panel reopens
/// on its own when the prompt advances: answering a single-select question
/// moves to the next one without a tap, and a stale `true` would leave the
/// reader staring at a header for a question they have not seen.
enum FeatureComposerPromptCollapse {
    static func isCollapsed(collapsedQuestionID: String?, activeQuestionID: String?) -> Bool {
        guard let collapsedQuestionID, let activeQuestionID else { return false }
        return collapsedQuestionID == activeQuestionID
    }

    static func toggled(collapsedQuestionID: String?, activeQuestionID: String) -> String? {
        isCollapsed(
            collapsedQuestionID: collapsedQuestionID,
            activeQuestionID: activeQuestionID
        ) ? nil : activeQuestionID
    }
}

enum FeatureComposerQuestionReconciliation {
    static func index(
        current: Int,
        previousQuestionIDs: [String],
        currentQuestionIDs: [String]
    ) -> Int {
        guard !currentQuestionIDs.isEmpty else { return 0 }
        if previousQuestionIDs.indices.contains(current),
           let retained = currentQuestionIDs.firstIndex(
               of: previousQuestionIDs[current]
           ) {
            return retained
        }
        return min(max(0, current), currentQuestionIDs.count - 1)
    }

    static func answers(
        _ answers: [String: FeatureInputAnswer],
        currentQuestionIDs: [String]
    ) -> [String: FeatureInputAnswer] {
        let liveIDs = Set(currentQuestionIDs)
        return answers.filter { liveIDs.contains($0.key) }
    }
}
