# Rich answers in chat

T3 Work and Code conversations support rich answers: Markdown tables,
checklists, highlighted code, images, callouts, expandable details, and
interactive HTML previews.

In Work, the assistant receives formatting guidance in new and existing
conversations, including imported Hermes sessions. This does not depend on
whether the connected Hermes gateway supports T3's MCP tools.

## Generated files

Ask for a saved file when you need to print, download, or share the result.
The assistant is guided to put a descriptive file link near the start of its
answer, rather than hand over a path to copy manually. File actions depend on
the client and connection to the environment that owns the file.

For example, “Create an A4 pickup sign, show me a preview, and link the HTML
file” asks for both an inline preview and the saved deliverable.

## Choosing a format

- Ask for a table when comparing options, or a checklist for a sequence of tasks.
- Ask for an interactive preview to explore a chart, layout, or small demo.
- Ask to put extra detail in an expandable section when you want the main answer kept short.
- Ask for source code with a filename when you want to copy or inspect the implementation.

Interactive previews are self-contained. They cannot fetch remote data or
open local files. A preview is separate from a saved file, and showing one
does not mean the assistant has tested the saved result.

These instructions guide future answers; they do not rewrite earlier messages.

## Inspecting images on iOS

Open an image to view it full screen. Pinch to zoom, drag to pan while zoomed,
or double-tap to toggle zoom. Fit image restores the full image. At its fitted
size, swipe between images in the message's gallery. VoiceOver offers zoom
adjustments and a Fit image action. Saving or sharing keeps the original image.

## Prompt history and diff colors

On web and desktop, press Up in an empty composer to recall your last prompt. Continue
with Up/Down at the first/last visual line to browse older/newer prompts. Down past the
newest prompt clears the composer. Attached context is not recalled.

Choose **Diff colors** in Appearance settings to use red/green or blue/orange additions
and deletions. The native iOS app offers the same choice in its thread appearance settings.
In web and desktop review panels, use **Show changed-file tree** to navigate folders
and files, and the copy control beside a file heading to copy its path.

The sidebar project filter supports searching project names. Open a project's settings
from its gear button or with Shift+F10 while the project is highlighted. Desktop nightly
release notes open on hover or keyboard focus; Tab reaches their full-release links.

Codex file citations open the referenced file and line. Artifact-template results appear
as cards on web, desktop, and iOS. Choose **Use template** to add a prompt to the
composer, then edit and send it when ready.

In the native iOS app, opening a quote's source briefly highlights the matching text
inside the original response, including lists, tables and code blocks. If an edited
response no longer has an unambiguous match, the app opens the response and explains
that it could not mark the exact quote. Your saved quote remains unchanged.

Images keep their proportions while loading when the server can read their size. Explicit HTML
image dimensions take precedence. Local image paths can point outside the workspace when the
connected server supports host-file previews. The iOS transcript keeps a stable media frame;
tap an image to inspect it at full size.

On iOS, expanded tool history remembers where you were reading inside a long result when you
collapse the group or scroll it off screen. Dragging takes control immediately if a saved
position is being restored.

On iOS, open file previews and folder listings refresh after the agent finishes a file edit or
command. A failed refresh keeps the previous preview visible and shows an error. Use **Reload**
to retry or to pick up changes made outside the agent.
