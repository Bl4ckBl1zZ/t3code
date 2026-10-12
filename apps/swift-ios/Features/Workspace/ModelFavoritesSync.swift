import SwiftUI

/// Model favorites shared through the environment (`ServerSettings.favorites`),
/// mirroring `resolveModelPreferences` and `modelPreferencesMigrationPatch` in
/// `packages/shared/src/serverSettings.ts`.
///
/// The device list under `ModelPickerMemory.favoritesKey` stays the source on
/// servers that predate synced favorites, and while a newer server holds none
/// yet; the first write from this device seeds the server with it.
enum ModelFavoritesSync {
    /// The picker's option id for a favorite.
    static func id(_ favorite: ModelFavorite) -> String {
        DailyUXModelOption.key(providerID: favorite.provider, modelID: favorite.model)
    }

    /// The favorite an option id names. Provider instance ids are slugs, so the
    /// first separator always ends the provider.
    static func favorite(id: String) -> ModelFavorite? {
        guard let range = id.range(of: "::") else { return nil }
        let provider = String(id[..<range.lowerBound])
        let model = String(id[range.upperBound...])
        guard !provider.isEmpty, !model.trimmingCharacters(in: .whitespaces).isEmpty else { return nil }
        return ModelFavorite(provider: provider, model: model)
    }

    /// The favorites a picker shows, in order: the environment's once seeded,
    /// this device's until then, with unsaved toggles laid over either.
    static func ids(
        server: [ModelFavorite]?,
        localStorage: String,
        pending: [String: Bool] = [:]
    ) -> [String] {
        var ids = server.map { $0.map(id) } ?? ModelPickerMemory.ids(in: localStorage)
        for (id, isFavorite) in pending.sorted(by: { $0.key < $1.key }) {
            if isFavorite, !ids.contains(id) { ids.append(id) }
            if !isFavorite { ids.removeAll { $0 == id } }
        }
        return ids
    }

    /// The write for one favorite. While the environment holds no list, the
    /// device's list rides along so this first edit cannot claim the
    /// environment without it.
    static func patch(
        id: String,
        isFavorite: Bool,
        server: [ModelFavorite]?,
        localStorage: String
    ) -> ServerSettingsPatchInput? {
        guard let favorite = favorite(id: id) else { return nil }
        var patch = ServerSettingsPatchInput(setModelFavorites: [ModelFavoriteChange(favorite, isFavorite: isFavorite)])
        if server == nil { patch.migrateModelFavorites = localFavorites(localStorage) }
        return patch
    }

    /// The one-time seed for an environment that syncs favorites but holds
    /// none. An empty device list does not claim it, so another device can
    /// still seed the list it actually has; the server applies the seed only
    /// while still unset, so a late seed cannot undo a later clear.
    static func seedPatch(syncs: Bool, server: [ModelFavorite]?, localStorage: String) -> ServerSettingsPatchInput? {
        guard syncs, server == nil else { return nil }
        let favorites = localFavorites(localStorage)
        return favorites.isEmpty ? nil : ServerSettingsPatchInput(migrateModelFavorites: favorites)
    }

    static func localFavorites(_ storage: String) -> [ModelFavorite] {
        ModelPickerMemory.ids(in: storage).compactMap { favorite(id: $0) }
    }

    static var localStorage: String {
        UserDefaults.standard.string(forKey: ModelPickerMemory.favoritesKey) ?? ""
    }
}

/// One environment's synced favorites as the model pickers read and write
/// them. Absent from the SwiftUI environment where the server keeps no
/// favorites, and the pickers fall back to the device list.
struct ModelFavoritesContext {
    /// The environment's list with unsaved toggles applied, or nil while the
    /// environment holds none and the device list still applies.
    let serverIDs: [String]?
    let setFavorite: @MainActor (_ id: String, _ isFavorite: Bool) -> Void

    func ids(localStorage: String) -> [String] {
        serverIDs ?? ModelPickerMemory.ids(in: localStorage)
    }
}

private struct ModelFavoritesContextKey: EnvironmentKey {
    static let defaultValue: ModelFavoritesContext? = nil
}

extension EnvironmentValues {
    var modelFavorites: ModelFavoritesContext? {
        get { self[ModelFavoritesContextKey.self] }
        set { self[ModelFavoritesContextKey.self] = newValue }
    }
}

extension View {
    /// Points the model pickers below at `environmentID`'s synced favorites.
    func modelFavorites(_ model: FeatureRootModel, environmentID: String?) -> some View {
        environment(\.modelFavorites, environmentID.flatMap { model.modelFavoritesContext(environmentID: $0) })
    }
}

extension FeatureRootModel {
    /// Nil where the environment keeps no favorites (an older server, or one
    /// whose settings have not arrived), so the pickers use the device list.
    func modelFavoritesContext(environmentID: String) -> ModelFavoritesContext? {
        guard let preferences = snapshot.preferencesByEnvironment?[environmentID],
              preferences.syncsModelFavorites == true else { return nil }
        let pending = pendingModelFavorites[environmentID] ?? [:]
        let serverIDs: [String]? = preferences.modelFavorites == nil && pending.isEmpty
            ? nil
            : ModelFavoritesSync.ids(
                server: preferences.modelFavorites,
                localStorage: ModelFavoritesSync.localStorage,
                pending: pending
            )
        return ModelFavoritesContext(serverIDs: serverIDs) { [weak self] id, isFavorite in
            Task { await self?.setModelFavorite(environmentID: environmentID, id: id, isFavorite: isFavorite) }
        }
    }

    func setModelFavorite(environmentID: String, id: String, isFavorite: Bool) async {
        guard let manager = client as? any FeatureServerSettingsManaging,
              let patch = ModelFavoritesSync.patch(
                id: id,
                isFavorite: isFavorite,
                server: snapshot.preferencesByEnvironment?[environmentID]?.modelFavorites,
                localStorage: ModelFavoritesSync.localStorage
              ) else { return }
        pendingModelFavorites[environmentID, default: [:]][id] = isFavorite
        do {
            try await manager.updateServerSettings(environmentID: environmentID, patch: patch)
            reconcileModelFavorites()
        } catch {
            // The star flips back to what the server holds.
            if pendingModelFavorites[environmentID]?[id] == isFavorite {
                pendingModelFavorites[environmentID]?[id] = nil
            }
            PlatformHapticEngine.shared.play(.error)
        }
    }

    /// Drops unsaved toggles the server now agrees with, and seeds each
    /// environment that syncs favorites but holds none from this device, once
    /// per launch. A connection without settings permission refuses the seed
    /// and keeps reading the device list.
    func reconcileModelFavorites() {
        let preferences = snapshot.preferencesByEnvironment ?? [:]
        for (environmentID, pending) in pendingModelFavorites {
            guard let server = preferences[environmentID]?.modelFavorites else { continue }
            let serverIDs = Set(server.map(ModelFavoritesSync.id))
            let remaining = pending.filter { serverIDs.contains($0.key) != $0.value }
            pendingModelFavorites[environmentID] = remaining.isEmpty ? nil : remaining
        }
        guard let manager = client as? any FeatureServerSettingsManaging else { return }
        for (environmentID, value) in preferences where !seededModelFavoriteEnvironments.contains(environmentID) {
            guard let patch = ModelFavoritesSync.seedPatch(
                syncs: value.syncsModelFavorites == true,
                server: value.modelFavorites,
                localStorage: ModelFavoritesSync.localStorage
            ) else { continue }
            seededModelFavoriteEnvironments.insert(environmentID)
            Task { try? await manager.updateServerSettings(environmentID: environmentID, patch: patch) }
        }
    }
}
