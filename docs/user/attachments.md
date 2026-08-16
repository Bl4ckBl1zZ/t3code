# Attachments

Attach files to a message and the agent can open them the same way it opens any other file in your project.

Attachments work in the chat composer on web, desktop, and mobile.

## Attaching files

- **Web and desktop**: drag files onto the composer, paste them, or use **+ → Attach files**.
- **Mobile**: tap the attach button for **Camera**, **Photos**, or **Files**, or share a file into T3 Code from another app.

You can attach up to 8 files per message. Images can be up to 10 MB and other files up to 20 MB. Large images are scaled down to fit rather than rejected.

Any file type works — PDFs, spreadsheets, CSVs, logs, archives, audio, source files. There is no longer a separate list of file types per provider.

## Where your files go

Each file you attach is saved into your project at:

```
.t3code/uploads/<thread>/<file>
```

The agent is told the path and reads the file from there, so it can grep a CSV, open a PDF, unzip an archive, or refer back to the same file in a later message without you re-sending it.

Images are also shown to the agent directly, so it can see a screenshot immediately and still open the file later if it needs the original.

### These files are not committed

T3 Code writes a `.gitignore` inside `.t3code/uploads/` that hides the whole folder from Git. Your uploads will not show up in `git status`, in a pull request, or in a checkpoint. Rolling back to a checkpoint leaves them in place, so paths mentioned earlier in a conversation keep working.

Deleting a thread deletes that thread's uploads.

## Seeing where a file landed

After you send a message, each attachment shows the path it was saved to. Click the path to open the file, or use the menu to copy it.

Conversations that have no project attached show no path — there is nowhere to save the file, so its contents are sent with the message as before. If T3 Code had a project but could not write to it (a read-only checkout, for example), the attachment is marked **Not saved to the workspace** and its contents are sent with the message instead. Either way the message still goes through.
