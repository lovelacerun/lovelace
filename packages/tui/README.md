# @lovelace/tui

A local workbench with a persistent navigation rail, scrollable details and an
exact-text pi-tui Editor. All backend/provider calls use `@lovelace/client`;
the server drives Herdr, so the TUI does no terminal IO beyond its own screen.

## Running

```sh
lovelace tui
pnpm tui
# Explicit loopback URL, optional left rail, plain Unicode icons and light mode:
tsx packages/tui/bin/lovelace-tui.ts --sidebar left --icons unicode --theme light --url http://127.0.0.1:4747
```

No-argument `lovelace` prints help, not the TUI. Interactive stdin/stdout are
required; help works through pipes. The default address uses the same root
configuration port as the server (`LOVELACE_PORT` overrides it). `LOVELACE_HOST`
sets the host. URLs must be HTTP loopback without credentials. The header
shows the actual configured address on terminals of 80+ columns, including on
first-load failure.

Icons use Nerd Font glyphs by default. Terminals without a Nerd Font, such as
many phone SSH clients, can use `--icons unicode`, `LOVELACE_TUI_ICONS=unicode`
or `"tui": { "icons": "unicode" }` in the config file.

## Theme

The TUI paints its own canvas with a Gruvbox palette, so it looks the same in
any terminal theme. Dark is the default; choose light with `--theme light`,
`LOVELACE_TUI_THEME=light` or `"tui": { "theme": "light" }`. Override any colour
per mode in `.lovelace/config.jsonc` with `#rrggbb`, or `none` for the
terminal's own default (e.g. a transparent background):

```jsonc
"tui": {
  "theme": "dark",
  "colors": {
    "dark": { "background": "none", "accent": "#8ec07c" },
    "light": { "selection": "#ebdbb2" }
  }
}
```

| Token | Used for |
| --- | --- |
| `background`, `foreground` | Page canvas and default text |
| `panel`, `bar`, `card`, `selection` | Sidebar, header/footer, Home cards and dialogs, focused selection |
| `jiraCard`, `prCard` | Attached Jira and pull request cards |
| `muted`, `faint` | Secondary text; separators and counts |
| `accent`, `key`, `special` | Focus and keys, issue keys, agents and merged PRs |
| `success`, `warning`, `danger` | Passed/done, needs attention, failed/offline |

Quick-start appears only on Home: a bottom dock just above the footer with
three visible input lines; longer prompts scroll within it. On terminals
shorter than 18 rows the unfocused dock collapses to one row and expands
when focused (`n` or a click). Below the editor sit **Agent**, **Thinking** and
**Model** select fields, which `Tab` reaches after the editor (or a click
focuses). `Enter`, `Space` or `↓` expands a field into a list below it; typing
filters it, `↑/↓` move, `Enter` chooses and `Esc` closes. Agents are the
harnesses detected on the server and models come from the harness's catalog;
a model name the catalog lacks can be typed and chosen as typed. `default`
keeps the harness's own setting. Narrow docks drop the labels and show a
field's name in place of `default`. The choice, kept per harness, is shared
with the Jira overlay and remembered until the TUI exits; `Enter` in the
editor launches with it.
Work-item details have no prompt input. Jira prompt editing is exclusively in its overlay.

## Keyboard

| Key | Action |
| --- | --- |
| `q` / Ctrl+C | Quit dashboard / quit anywhere |
| `r` | Refresh dashboard and selected details |
| `Tab` / `Shift+Tab` | Next/previous detail item, then sidebar; Home cycles content/sidebar/editor/agent/thinking/model |
| `n` | Focus Home prompt, or open Jira start-work overlay |
| `↑/↓` / `k/j` | Move selection outside editor |
| `Enter` | Open selection (Jira/PR cards open the default browser), or launch from editor |
| `Shift+Enter` / Ctrl+J | Insert newline |
| Backslash + `Enter` | Newline on legacy terminals |
| `Esc` | Cancel confirmation first; otherwise leave editor/back |
| `d/a/c` | Confirm local done/active/cancelled state |
| `y` | Confirm state change or intent discard |
| `x` | Ask to discard an unresolved launch intent |

Jira and PR attachments are borderless, padded cards. Tab through them (or use
↑/↓ in content); the selected card is highlighted. Enter opens its cached web
URL in your default browser. Jira details also offer **Open in browser**.
Missing or unsafe links are not selectable. Browser opening is local client IO,
not a provider API call; no browser is launched by rendering or navigation.

## Mouse

The fullscreen viewport captures the mouse (pi-tui `TuiAltScreen`).

- Click a sidebar row, Home item, session or action to open it, like `Enter`.
- Click a Jira/PR card or Jira URL to open it in the default browser.
- Click a single-key help chip (`q`, `r`, `n`, `Enter`, `Esc`, …) to press it.
- Drag the sidebar divider to resize it for the session; double-click it to
  restore the responsive width.
- The wheel moves the selection in the pane under the pointer.
- Click the quick-start dock to focus it; click the page to leave it.
- In the Jira start overlay, click repositories to toggle them, the filters
  or prompt to focus them, `‹`/`›` to switch templates, and the buttons.
- Dragging elsewhere selects and copies text.

Clickable regions are OSC 8 hyperlinks; in-app targets use a private
`lovelace:` scheme, so pi-tui's own link hit-testing routes every click and no
geometry is tracked beyond the divider and the dock. Reuse the helpers instead
of adding hit tests:

- `clickable(text, target)` (`src/clickable.ts`) marks any rendered text as a
  click target; `linkCell` from `@lovelace/tui-components` pads and fences a
  column so its target cannot bleed.
- `keyChip(key, label)` / `keyHint(text, key)` (`src/key-hints.ts`) render
  hints that press a key.
- `SplitPane` from `@lovelace/tui-components` lays out the global sidebar and
  the Jira overlay columns, forwards mouse events to the pane under the
  pointer and owns the draggable sidebar divider.
- Provider URLs use pi-tui's `hyperlink(text, url)` and open in the browser.

Generic pi-tui components (split panes, cards, link cards and text helpers) live in [`@lovelace/tui-components`](../tui-components/README.md);
this package keeps the palette and application glue.

## Starting Jira work

Open a pending Jira issue and choose **Start work**. One native pi-tui overlay
opens above the unchanged Jira page:

- **Left:** repository multi-select with separate name and topic filters.
  `Space`/`Enter` toggles a repository; `/` focuses name search and `t` topics.
  Name terms intersect; comma-separated topics are alternatives. Topics start
  with the server's `github.repositoryTopics` from `.lovelace/config.jsonc`
  (default: none); clear the field to show all topics.
  **Select all** (`Ctrl+A` in the list) adds every filtered match, including off-screen
  matches; **Unselect all** (`Ctrl+U`) clears the entire selection, including hidden
  repositories. `Tab` from topics focuses these buttons; `←/→`, then `Enter` applies.
  Narrow layouts label them **All / None**. At most 100 repositories can be selected;
  exceeding the limit leaves the selection unchanged.
  Hidden selections remain selected. Archived repositories are hidden by
  default; `a` includes them. `r` refreshes the catalog through the server.
- **Right:** a template select field, a large editable prompt preview and,
  below it, the shared agent/thinking/model fields (as on Home). The template
  field expands like those fields and chooses built-in, overridden/custom, or
  manual prompts.
  Existing edited drafts are preserved on reopen; an empty draft starts with
  Implement. In the prompt box, `Enter` inserts a newline, never launches.
- **Bottom:** Start work / Cancel. `Tab`/`Shift+Tab` cycles controls;
  `Ctrl+S` or `Ctrl+Enter` starts explicitly. `Esc` closes just the overlay,
  retaining the draft/selection and the underlying page.

The catalog comes from authenticated GitHub access across organizations, with
both viewer and owner affiliations included. Names and topics are cached on
the server; clients never query GitHub. Each issue keeps its own draft and
selection. Start submits a durable launch request; the overlay closes as soon
as the server accepts it, rather than waiting for repositories or agent startup.
The saved work item shows preparation phases and repository progress, then
its session. Home quick-start stays repository-free and also returns on acceptance.

You can start another task while earlier work prepares. Work-item progress is
polled every second while launching, and the dashboard every two seconds while
any launch is pending (otherwise seven seconds). Background completion never
changes your selection or focuses Herdr. Read failures retain last-known state;
quitting stops client polling, not server preparation/startup.

Validation errors stay in the setup dialog. Later preparation/startup failures
appear on the saved work item with **Retry saved prompt**. It uses the exact
server-owned prompt, template/repositories and harness options, a fresh request
UUID and the same work item; ready worktrees are reused. After a server restart,
uncertain launches require inspecting Herdr before deliberately starting another
session. Progress is restored from server state when revisiting/reopening the TUI.

## Sessions in Herdr

Launches start the agent in the work item's Herdr workspace without focusing
it. Selecting a session asks the server to open it: Herdr focuses a live
session's tab, and an ended session continues its exact recorded conversation
and is focused. There is no confirmation step; the selection is the request.
Sessions without a recorded native conversation report why they cannot be
continued. Inactive work needs explicit reactivation first. Session states
(`working`, `idle`, `done`, `blocked`, `ended`) come from Herdr; `blocked` and
`done` are highlighted. Quitting cancels client IO, not the agents.

## Resilience and rendering

- The right sidebar stays visible during loading/offline, including Home and
  unavailable sections. A left-side override remains available. Below 80
  columns it hides, Home lists active work instead and Tab skips it.
- Shaded header/footer bars and navigation panel, a `▌` selection bar and
  Home entries as padded two-row cards; under 26 body rows views fall back to
  one row per entry. Layouts fit from 36×10 (phone SSH) up; the Jira start overlay
  shows one pane at a time when narrow, following focus.
- Polling coalesces refreshes; read failures retain actual last-good data. The
  header and footer distinguish last-known data from no data, never inventing
  a cache.
- Submission preserves Unicode, blank lines and boundary/pasted whitespace.
  Empty validation alone uses trim. Paste chunks never trigger commands.
- Drafts are isolated by work/Jira/Home. Launch failures retain exact text.
  Confirmed failure retries with a new UUID on the same work item.
- Launch uncertainty freezes endpoint, body and request UUID, so an explicit
  retry replays the same server operation instead of launching again. Lost
  HTTP replies never retry automatically. After closing an uncertain Jira
  launch dialog, **Retry exact saved launch** replays its frozen request;
  changing templates/repositories first requires explicitly discarding it.
- `Esc`, then `x`/`y` discards an unresolved local intent, not upstream work.

## Tests

```sh
pnpm --filter @lovelace/tui build
pnpm --filter @lovelace/tui test
```

Tests inject API IO and use isolated temporary config and loopback fixtures.
They exercise real Editor input/paste, launch uncertainty, session open,
stable drafts, cancellation and viewport bounds.
Browser launchers are injected: tests never open browser windows. Reusable
cards live in `@lovelace/tui-components`; provider status wording stays in views.
No live agents, providers or operator panes are used.
