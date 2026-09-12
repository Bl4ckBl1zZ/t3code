# Terminal history

Each terminal keeps up to 5,000 lines and 8 MiB of scrollback on its environment
server. T3 Code removes the oldest output when either limit is reached. A long
line can be shortened at the start. New terminal output is not truncated.

These limits apply when you reconnect and when T3 Code restores saved terminal
history. A client can show less scrollback than the server keeps.

On Windows and Linux, **Ctrl+Insert** copies the current terminal selection.

On Linux and BSD, middle-click pastes the selection from that terminal. With no terminal
selection, it does nothing; it does not paste the system clipboard. Applications that
capture mouse input still receive the click themselves.

Web, desktop, and iOS keep a bounded local replay tail. A busy terminal keeps its
live screen and ANSI state as older replay history is discarded. Reconnecting
or falling behind the retained tail restores the current tail once. Hidden web
terminal drawers pause canvas rendering while continuing to receive output and
answer terminal queries; revealing a drawer redraws its current screen.

Terminal activity uses the native resource monitor to detect running commands. If the monitor is unavailable, process scanning falls back automatically and slows down after repeated failures to avoid excessive CPU use. Normal detection resumes when the monitor recovers.
