import Foundation

// Ported from apps/mobile/src/lib/modelOptions.ts together with the
// `@t3tools/shared/model` descriptor helpers it leans on, so every client
// derives the same picker contents — and the same outgoing selection — from one
// server config.

public struct ModelOption: Identifiable, Equatable, Sendable {
    public var id: String { key }

    /// `instanceId:slug`. Two provider instances can advertise the same model,
    /// so the instance has to be part of the identity.
    public let key: String
    public let label: String
    public let subtitle: String
    public let providerKey: String
    public let providerLabel: String
    public let providerDriver: String
    public let isDefault: Bool
    public let isLegacy: Bool
    public let capabilities: ServerModelCapabilities?
    public let selection: ModelSelection

    fileprivate func adopting(_ selection: ModelSelection) -> ModelOption {
        ModelOption(
            key: key,
            label: label,
            subtitle: subtitle,
            providerKey: providerKey,
            providerLabel: providerLabel,
            providerDriver: providerDriver,
            isDefault: isDefault,
            isLegacy: isLegacy,
            capabilities: capabilities,
            selection: selection
        )
    }
}

public struct ModelProviderGroup: Identifiable, Equatable, Sendable {
    public var id: String { providerKey }

    public let providerKey: String
    public let providerLabel: String
    public let models: [ModelOption]
}

/// Which providers a picker may offer. Hermes is the T3 Work assistant and the
/// only thing T3 Work runs on, and it is not a coding provider — so a T3 Work
/// picker lists Hermes and nothing else, and a Code picker lists everything
/// else. `all` is for surfaces that are neither, such as automations.
public enum ModelOptionProviderScope: Equatable, Sendable {
    case all
    case hermesOnly
    case excludeHermes
}

/// One entry in the model menu. The top level is a provider (or its legacy
/// shelf) and `subactions` are its models; nothing nests deeper than that.
public struct ModelMenuAction: Identifiable, Equatable, Sendable {
    public let id: String
    public let title: String
    /// Echoes the chosen model on the provider row so the current selection is
    /// visible without opening the submenu.
    public let subtitle: String?
    /// React Native spells this `state: "on" | undefined`; both render a check.
    public let isSelected: Bool
    public let subactions: [ModelMenuAction]
}

public enum ModelOptions {
    private static let hermesDriver = "hermes"

    /// A stored model selection is only usable when its provider instance is
    /// currently enabled, installed, and authenticated on the server. Returns
    /// the selection unchanged when usable, otherwise `nil` so callers fall
    /// through to the server's default model. A missing config (environment
    /// offline) cannot be validated, so stored selections pass through
    /// untouched.
    public static func selectable(
        _ selection: ModelSelection?,
        in config: ServerConfigSnapshot?
    ) -> ModelSelection? {
        guard let selection, let config else { return selection }
        guard let provider = config.providers.first(where: {
            $0.instanceId == selection.instanceId
        }), isUsable(provider) else { return nil }
        return selection
    }

    public static func build(
        config: ServerConfigSnapshot?,
        fallbackSelection: ModelSelection?,
        scope: ModelOptionProviderScope = .all
    ) -> [ModelOption] {
        // Insertion-ordered by key: a fallback selection that names a model the
        // catalog already lists refreshes it in place rather than repeating it
        // at the end of the picker.
        var order: [String] = []
        var byKey: [String: ModelOption] = [:]
        func put(_ option: ModelOption) {
            if byKey.updateValue(option, forKey: option.key) == nil { order.append(option.key) }
        }

        for provider in config?.providers ?? [] {
            guard isUsable(provider), matches(provider.driver, scope) else { continue }
            let providerLabel = displayLabel(provider)
            for model in provider.models {
                put(
                    ModelOption(
                        key: "\(provider.instanceId):\(model.slug)",
                        label: model.name,
                        subtitle: providerLabel,
                        providerKey: provider.instanceId,
                        providerLabel: providerLabel,
                        providerDriver: provider.driver,
                        isDefault: model.isDefault == true,
                        isLegacy: model.isLegacy == true,
                        capabilities: model.capabilities,
                        selection: normalized(
                            ModelSelection(instanceId: provider.instanceId, model: model.slug),
                            against: model.capabilities
                        )
                    )
                )
            }
        }

        if let fallbackSelection {
            let key = "\(fallbackSelection.instanceId):\(fallbackSelection.model)"
            if let existing = byKey[key] {
                put(
                    existing.adopting(
                        normalized(fallbackSelection, against: existing.capabilities)
                    )
                )
            } else {
                // The config no longer describes this model — most likely the
                // provider went away. Keep it listed under its bare identifiers
                // so the current thread's model is still selectable.
                put(
                    ModelOption(
                        key: key,
                        label: fallbackSelection.model,
                        subtitle: fallbackSelection.instanceId,
                        providerKey: fallbackSelection.instanceId,
                        providerLabel: fallbackSelection.instanceId,
                        providerDriver: fallbackSelection.instanceId,
                        isDefault: false,
                        isLegacy: false,
                        capabilities: nil,
                        selection: fallbackSelection
                    )
                )
            }
        }

        return order.compactMap { byKey[$0] }
    }

    public static func grouped(_ options: [ModelOption]) -> [ModelProviderGroup] {
        var order: [String] = []
        var labels: [String: String] = [:]
        var models: [String: [ModelOption]] = [:]

        for option in options {
            if models[option.providerKey] == nil {
                order.append(option.providerKey)
                labels[option.providerKey] = option.providerLabel
            }
            models[option.providerKey, default: []].append(option)
        }

        return order.map { key in
            ModelProviderGroup(
                providerKey: key,
                providerLabel: labels[key] ?? key,
                models: models[key] ?? []
            )
        }
    }

    public static func menuActions(
        for groups: [ModelProviderGroup],
        selected: ModelSelection?
    ) -> [ModelMenuAction] {
        groups.flatMap { group -> [ModelMenuAction] in
            let current = group.models.filter { !$0.isLegacy }
            let legacy = group.models.filter(\.isLegacy)
            let chosen = group.models.first { isSelected($0, selected) }

            var actions: [ModelMenuAction] = []
            // A provider whose whole catalog is legacy gets no top-level row —
            // an empty submenu is worse than none.
            if !current.isEmpty {
                actions.append(
                    ModelMenuAction(
                        id: "provider:\(group.providerKey)",
                        title: group.providerLabel,
                        subtitle: chosen.flatMap { $0.isLegacy ? nil : $0.label },
                        isSelected: false,
                        subactions: current.map { modelAction($0, selected: selected) }
                    )
                )
            }
            if !legacy.isEmpty {
                actions.append(
                    ModelMenuAction(
                        id: "legacy-models:\(group.providerKey)",
                        title: "\(group.providerLabel) legacy models",
                        subtitle: chosen.flatMap { $0.isLegacy ? $0.label : nil },
                        isSelected: false,
                        subactions: legacy.map { modelAction($0, selected: selected) }
                    )
                )
            }
            return actions
        }
    }

    // MARK: - Providers

    private static func isUsable(_ provider: ServerProviderSnapshot) -> Bool {
        provider.enabled && provider.installed && provider.auth.status != "unauthenticated"
    }

    private static func displayLabel(_ provider: ServerProviderSnapshot) -> String {
        if let displayName = provider.displayName, !displayName.isEmpty { return displayName }
        switch provider.driver {
        case "codex": return "Codex"
        case "claudeAgent": return "Claude"
        default: return provider.instanceId
        }
    }

    private static func matches(_ driver: String, _ scope: ModelOptionProviderScope) -> Bool {
        switch scope {
        case .all: true
        case .hermesOnly: driver == hermesDriver
        case .excludeHermes: driver != hermesDriver
        }
    }

    // MARK: - Menu

    private static func isSelected(_ option: ModelOption, _ selected: ModelSelection?) -> Bool {
        guard let selected else { return false }
        return option.selection.instanceId == selected.instanceId
            && option.selection.model == selected.model
    }

    private static func modelAction(
        _ option: ModelOption,
        selected: ModelSelection?
    ) -> ModelMenuAction {
        ModelMenuAction(
            id: "model:\(option.key)",
            title: option.label,
            subtitle: nil,
            isSelected: isSelected(option, selected),
            subactions: []
        )
    }

    // MARK: - Provider options

    /// A stored selection can name options the model no longer offers, or miss
    /// ones it has gained. Re-resolving against the live descriptors keeps the
    /// picker from sending a value the provider would reject.
    private static func normalized(
        _ selection: ModelSelection,
        against capabilities: ServerModelCapabilities?
    ) -> ModelSelection {
        guard let capabilities else { return selection }
        guard let options = resolvedOptions(capabilities, storing: selection.options) else {
            // Nothing left to honour: drop the stale option list rather than
            // forwarding ids the provider no longer knows.
            return ModelSelection(instanceId: selection.instanceId, model: selection.model)
        }
        return ModelSelection(
            instanceId: selection.instanceId,
            model: selection.model,
            options: options
        )
    }

    private static func resolvedOptions(
        _ capabilities: ServerModelCapabilities,
        storing stored: [ModelSelection.OptionSelection]?
    ) -> [ModelSelection.OptionSelection]? {
        guard let descriptors = capabilities.optionDescriptors, !descriptors.isEmpty else {
            return nil
        }

        var resolved: [ModelSelection.OptionSelection] = []
        for descriptor in descriptors {
            switch descriptor {
            case let .boolean(boolean):
                // A toggle has no catalog default, so an unset option stays
                // unset rather than being forced to false.
                let value: Bool?
                if case let .bool(flag)? = storedValue(stored, id: boolean.id) {
                    value = flag
                } else {
                    value = boolean.currentValue
                }
                if let value {
                    resolved.append(.init(id: boolean.id, value: .bool(value)))
                }

            case let .select(select):
                let raw = storedValue(stored, id: select.id)?.stringValue ?? select.currentValue
                if let value = resolvedChoice(select, raw: raw) {
                    resolved.append(.init(id: select.id, value: .string(value)))
                }
            }
        }
        return resolved.isEmpty ? nil : resolved
    }

    private static func storedValue(
        _ stored: [ModelSelection.OptionSelection]?,
        id: String
    ) -> JSONValue? {
        stored?.first { $0.id == id }?.value
    }

    private static func resolvedChoice(
        _ descriptor: ServerSelectOptionDescriptor,
        raw: String?
    ) -> String? {
        let defaultChoice = descriptor.options.first { $0.isDefault == true }?.id
        let fallback = present(descriptor.currentValue) ?? defaultChoice

        guard let trimmed = present(raw?.trimmingCharacters(in: .whitespacesAndNewlines)) else {
            return fallback
        }
        // A descriptor with no enumerated choices is free-form, so whatever the
        // user stored is still valid.
        guard !descriptor.options.isEmpty else { return trimmed }

        let isKnown = descriptor.options.contains { $0.id == trimmed }
        // Prompt-injected values are chosen by the provider for a single turn,
        // never by the user, so one must not stick as the saved selection.
        if descriptor.promptInjectedValues?.contains(trimmed) == true, isKnown {
            return defaultChoice
        }
        return isKnown ? trimmed : fallback
    }

    private static func present(_ value: String?) -> String? {
        guard let value, !value.isEmpty else { return nil }
        return value
    }
}
