# Native iOS design system

The SwiftUI client (`apps/swift-ios`) deploys to iOS 17 and builds against the current
iOS SDK. It uses system components wherever they exist, so it picks up Liquid Glass on
iOS 26 and later. Earlier systems get the closest equivalent that shipped before it.
Every iOS 18, 26 or 27 API sits behind `#available`. An unguarded call compiles and then
crashes on older devices.

The shared pieces live in [`T3Theme.swift`](../../apps/swift-ios/DesignSystem/T3Theme.swift)
and [`T3NativeChrome.swift`](../../apps/swift-ios/DesignSystem/T3NativeChrome.swift).
Feature views use these helpers rather than drawing their own chrome.

## Palette

`T3Colors` roles come from the user's selected theme, which may be published by an
environment. Any color that should follow the theme is read through `T3Colors`.

- The brand primary is ink: `primaryAction` with `primaryActionForeground`.
- Accent is for tint, links and selection.
- `danger` is light pink in dark palettes, so never put white text or glyphs on it. Use it as
  the glyph color on a neutral or glass background.

## Chrome

- **Navigation bars.** Bars are glass on iOS 26. `t3NavigationChrome()` is a no-op there,
  and keeps the opaque themed bar on iOS 17–25. Screens keep the system bar: don't hide
  it to draw a custom header.
- **Glass surfaces.** Draw them with `t3GlassEffect`:
  - Pass `interactive: true` when the glass is itself the tap target.
  - `t3GlassRim` draws the 1pt palette rim only before iOS 26, because real glass has its
    own edge.
  - `T3GlassContainer` blends neighbouring glass.
- **Sheet toolbars.** Sheets place their buttons with `t3SheetToolbar`:
  - `.close` for read-only sheets: the `role: .close` xmark on iOS 26, "Done" before.
  - `.cancel` plus a `T3SheetConfirmation` for edit sheets: the cancel xmark and confirm
    checkmark on iOS 26, text buttons before.
  - Commit buttons belong in the toolbar, not in the sheet body.
  - `hasChanges` blocks swipe-to-dismiss and asks before discarding.
  - Apply it inside the sheet's `NavigationStack`. A toolbar attached to the stack itself
    never renders.
- **Nested navigation.** Chevron rows inside a sheet push within that sheet's stack. Don't
  present another sheet on top.
- **Buttons.** A screen has at most one `t3ProminentButtonStyle()` call to action. Secondary
  actions use `t3SecondaryButtonStyle()`. Labels are never uppercased or letter-spaced.
- **Grouped content.** Use an inset-grouped `List` or `Form` with
  `t3GroupedListBackground()` and `t3GroupedRow()`, so the theme still paints it.
  - Explanations go in section footers.
  - Destructive rows sit last, in their own section.
  - Settings and navigation rows use `T3SettingsTile` icons; content lists use plain glyphs.
- **Empty and error states.** Use `ContentUnavailableView`, with an action whenever there's
  a next step.

## Feedback

- Success is never a modal alert. Use a haptic, plus `T3HUD.show` when the result would
  otherwise be invisible, such as a copy. The HUD lives in its own pass-through window, so
  it shows above sheets and is announced to VoiceOver. It plays a success haptic by
  default; pass a different `haptic`, or `nil` when the action already played one.
- Haptics go through `PlatformHapticEngine` or `t3SensoryFeedback`, which both follow
  Settings → Haptics. Don't call the UIKit feedback generators directly.
- Destructive actions confirm with `confirmationDialog`.
- Failure alerts name what failed, e.g. "Couldn't Push", rather than "Something went wrong".

## Motion

Nothing repaints continuously: no `repeatForever`, shimmer, pulsing or decorative
`TimelineView(.animation)`. These keep the GPU awake on ProMotion displays for as long
as they're on screen. Waiting states are static. A state change may play a one-shot
symbol effect.
