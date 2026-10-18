# pi-compact-transcript 

![NPM Downloads](https://img.shields.io/npm/d18m/pi-compact-transcript)

A compact transcript extension for [pi](https://pi.dev). 

## With the extension

<img width="2131" height="552" alt="With the extension" src="assets/with-extension.png" />

## Without the extension

<img width="2135" height="1275" alt="image" src="https://github.com/user-attachments/assets/b6fe8d3b-9170-435c-b353-98a6aa84fe7b" />

What it does:

- Highlights agent commentary with an accent-colored left rail and a blank line before the tools below it, preserving Markdown formatting. Final answers stay unframed.
- Collapses every tool call/result into a dimmed one-line preview with a status diamond: blinking gray `◆` while running, green on success, red on failure. Failed previews retain higher-contrast text. Durations show at a second or longer.
- Consecutive uses of the same tool coalesce into a single row, e.g. `◆ 4× read src/foo.ts {12 lines · 8s}`. Edit and write previews show git-style counts such as `{+3/-1}` and `{+42/-0}` with additions in green and deletions in red; no diff content is rendered. Failed tools always get their own visible row.
- Each agent run ends with a one-line summary, e.g. `Read 6 files, edited 2, ran 3 commands, 1 failed · 42s`.
- Suppresses `Thinking...` markers when thinking is hidden.
- Works with custom/external tools from other extensions; unknown tools preview their most meaningful string argument (command, code, query, path, url, ...) instead of raw JSON.
- Background task notifications from the shared `@4fu` task coordinator also collapse to one line. A single update shows its source, task ID, status and duration; batched updates show task/status counts and retain a red marker if any task failed. `Ctrl+O` restores the provider's original detailed view. Other custom messages and unknown payloads are unchanged.
- In fullscreen, left-click a compact tool row to inspect that result inline. A grouped `N× tool` row first lists its individual calls **below the group header**; click a call to open its original result. Click the header again to collapse. Other calls remain compact, including historical groups from earlier agent turns.
- Left-click a thinking preview to expand only that thinking run; click the expanded thinking block to collapse it. Local choices do not change the global thinking setting. `Ctrl+O` / `Ctrl+T` remain the global controls.
- Expanded tool output still uses pi's original renderer, so custom tool output, streaming updates, images and native detail interactions remain owned by pi/provider renderers.
- Unchanged compact tool rows cache their formatted line for the current width instead of repeating ANSI/Unicode truncation on every streamed token or keystroke. Result updates, resize and invalidation refresh the cache; history and event delivery are unchanged.

## Install

**Fork note:** the background-notification, inline-click and compact-line cache additions described here are on `mishkidreams/pi-compact-transcript`, branch `fix/thinking-row-0.11.1`, loaded directly from a local checkout. The npm/upstream installation examples below do not install those fork-only changes.

```bash
pi install npm:pi-compact-transcript
```

Or from GitHub:

```bash
pi install git:github.com/avhagedorn/pi-compact-transcript
```

Or try it for one run:

```bash
pi -e git:github.com/avhagedorn/pi-compact-transcript
```

Reload or restart pi after installing:

```text
/reload
```

## Recommended settings

Works best with hidden thinking and no output padding — set in `~/.pi/agent/settings.json` or via `/settings`:

```json
{
  "hideThinkingBlock": true,
  "outputPad": 0
}
```

Thinking suppression only applies when `hideThinkingBlock` is on; with it off, pi renders thinking traces normally. Commentary styling works with either setting. A message is identified as commentary once it contains a tool call, so streaming text stays unframed until that tool call arrives.

## Default configuration

The default can be overridden without editing the extension source:

- User-wide: `~/.pi/agent/compact-transcript.json`
- Trusted project: `<project>/.pi/compact-transcript.json`

Example:

```json
{
  "enabled": true,
  "summaryStyle": "quote",
  "highlightToolActions": true
}
```

| Option | Values | Default | Description |
| --- | --- | --- | --- |
| `summaryStyle` | `"plain"`, `"quote"` | `"plain"` | Renders activity summaries as muted text or Markdown blockquotes. |
| `highlightToolActions` | `true`, `false` | `false` | Bolds tool names and shell commands for easier scanning. |

Configuration is resolved in this order (highest priority first): current-session `/compact-transcript on|off`, trusted project configuration, user-wide configuration, then the built-in defaults (`enabled: true`, `summaryStyle: "plain"`, `highlightToolActions: false`). Project configuration is ignored unless Pi reports the project as trusted. Missing files, invalid JSON, and unsupported values are ignored and the next fallback is used. Session toggles remain stored in the existing session entries, and legacy mode values remain supported.

## Commands

```text
/compact-transcript          # toggle on/off
/compact-transcript on|off   # set explicitly
/compact-transcript status   # show current state
```

Toggling re-renders the visible transcript immediately — no reload needed. Write stats are always shown for completed writes. Pre-0.5 mode names (`balanced`, `aggressive`, `debug`, `disabled`) are accepted as legacy aliases for `on`/`off`.

## Notes

This extension changes display only — tool execution is still handled by pi and any other extensions that registered or override tools.

Cooperating child viewers can use the fork's optional **synchronous renderer scopes** to reuse compact tool/group/thinking interactions without sharing the main chat's bursts, call IDs or disclosure state. Shared theme/config changes still apply; the scopes ingest no agent events and write no session/settings data. This paired-viewer addition is currently local, uncommitted work above `70c6121`, not a change already available from npm or the published fork SHA.

Compact rendering uses pi's public exported TUI components where available. Burst compaction, thinking suppression, inline inspection and background notification compaction rely on pi's current TUI internals. Inline inspection needs the current native tool expansion/mouse methods; unsupported components keep their existing rendering/interaction rather than guessing which call to open.

Clicks are routed through pi's fullscreen mouse handling; regular terminal scrollback has no equivalent guarantee. Drag selection is not treated as a click. Native rapid multi-click selection and bottom-follow scrolling are unchanged: this is not a semantic viewport anchor, virtualization or a global-toggle performance fix. Viewing a block does not write a session entry or change model history.

## Tests against an installed host

No second copy of Pi or npm dependencies is required. With Node.js 24 supporting native TypeScript stripping, set `PI_ROOT` to the installed `@earendil-works/pi-coding-agent` directory and run from this checkout:

```powershell
node --import ./tests/host-loader.mjs --test tests/compact-transcript.test.ts tests/background-notifications.test.ts tests/local-click.test.ts tests/cached-line.test.ts tests/scoped-renderer.test.ts
```

The tests exercise real host components and containers with public fixture text, not a model/session or real terminal. They include stock-click controls, individual/grouped/historical calls, independent thinking runs, global-toggle round trips, updates/errors, width recovery, cache invalidation and display-only behavior. A separate offline native SGR/viewport probe was also run against Pi 1.3.0; that is not live user acceptance.
