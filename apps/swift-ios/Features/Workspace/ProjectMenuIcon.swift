import SwiftUI

/// A project's icon for native menu rows, which draw one flat image each and
/// cannot host a `ProjectFaviconBadge`. Same precedence as the badge: the
/// chosen icon, then the repo's favicon, then the name-derived default.
///
/// Favicons are observed so an open menu picks each one up as it lands; drawn
/// icons are deterministic and cached out of observation.
@MainActor
@Observable
final class ProjectMenuIconStore {
    static let shared = ProjectMenuIconStore()

    /// Menu rows size bitmaps by their points, so this matches a row glyph.
    private static let side: CGFloat = 20

    private var favicons: [URL: UIImage] = [:]
    @ObservationIgnored private var drawn: [String: UIImage] = [:]

    func image(for project: FeatureProject, dark: Bool) -> Image {
        let image: UIImage
        if let icon = chosenIcon(project) {
            image = drawnIcon(icon, dark: dark)
        } else if let url = faviconURL(project), let favicon = favicons[url] {
            image = favicon
        } else {
            image = drawnIcon(
                ProjectIconDefaults.select(title: project.name, workspaceRoot: project.path),
                dark: dark
            )
        }
        // Original rendering, or the menu templates it into a monochrome mask.
        return Image(uiImage: image.withRenderingMode(.alwaysOriginal))
    }

    /// Asks the server for each listed project's favicon. Resolution is
    /// cached app-wide, so reopening a menu costs nothing.
    func resolve(_ projects: [FeatureProject]) {
        for project in projects where chosenIcon(project) == nil {
            ProjectFaviconStore.shared.resolve(
                environmentID: project.environmentID,
                workspaceRoot: project.path,
                faviconPath: project.faviconPath
            )
        }
    }

    /// The resolved favicon URLs for `projects`; a view keys its decode task
    /// on this so it reruns as resolutions arrive.
    func faviconURLs(_ projects: [FeatureProject]) -> [URL] {
        projects.compactMap { chosenIcon($0) == nil ? faviconURL($0) : nil }
    }

    func decode(_ urls: [URL]) async {
        for url in urls where favicons[url] == nil {
            guard let image = await NativeIconImageStore.projectFavicons.image(for: url),
                  !Task.isCancelled else { continue }
            favicons[url] = render(
                Image(uiImage: image)
                    .resizable()
                    .scaledToFill()
                    .frame(width: Self.side, height: Self.side)
                    .clipShape(RoundedRectangle(cornerRadius: Self.side * 0.25))
            ) ?? image
        }
    }

    private func chosenIcon(_ project: FeatureProject) -> ProjectIconOverride? {
        guard let icon = project.projectIcon, icon.kind == "emoji" || icon.kind == "lucide" else {
            return nil
        }
        return icon
    }

    private func faviconURL(_ project: FeatureProject) -> URL? {
        ProjectFaviconStore.shared.url(
            environmentID: project.environmentID,
            workspaceRoot: project.path,
            faviconPath: project.faviconPath
        )
    }

    private func drawnIcon(_ icon: ProjectIconOverride, dark: Bool) -> UIImage {
        let key = [icon.kind, icon.name ?? "", icon.emoji ?? "", icon.color ?? "", dark ? "dark" : "light"]
            .joined(separator: "|")
        if let cached = drawn[key] { return cached }
        let image = render(
            NativeProjectIcon(icon: icon, size: Self.side)
                .environment(\.colorScheme, dark ? .dark : .light)
        ) ?? UIImage()
        drawn[key] = image
        return image
    }

    private func render(_ content: some View) -> UIImage? {
        let renderer = ImageRenderer(content: content)
        renderer.scale = 3
        return renderer.uiImage
    }
}
