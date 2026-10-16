# @lovelace/tui-components

Generic [pi-tui](https://www.npmjs.com/package/@earendil-works/pi-tui)
components and text helpers. They depend only on pi-tui (a peer dependency)
and follow its conventions: components implement `Component`
(`render(width)`, `invalidate()`, optional `handleMouse`) and take themes as
`(text) => string` style functions. No Lovelace types, palette or state.

| Export | Purpose |
| --- | --- |
| `Card` | Borderless padded surface with an unpainted margin. Like `Box`, but the background resumes after children reset their styles. `Card.contentWidth(width)` gives the children's width. |
| `LinkCard` | A `Card` hyperlinked (OSC 8) to a URL on every row, marked `↗`, or `›` on the selected surface via `setSelected`. Callers validate URLs. |
| `SplitPane` | Two components side by side with a divider, like an `HStack` with one sized pane. Optional drag-to-resize (double-click resets), gap and side. Forwards mouse events to the pane under the pointer in local coordinates and fences OSC 8 links per cell. |
| `Dropdown` | Select field that expands into a fuzzy-filtered list below it (Enter/Space/↓ or typing opens, ↑/↓ move, Enter picks, Esc closes; Tab closes and passes through). Optional typed custom values and click links via the theme. Hosts place `renderField` and `renderList`. |
| `fitEditorLines`, `replaceEditorText`, `PasteTracker` | `Editor` helpers: fit rendered lines to a fixed height around the cursor, replace text without firing `onChange`, and follow bracketed paste across input chunks. |
| `safeText`, `truncate`, `padRight`, `wrap`, `columns`, `columnWidths` | Width-aware text helpers; `safeText` strips terminal sequences and controls from untrusted text. `columns` stacks below `COLUMNS_MIN_WIDTH`. |
| `linkCell`, `LINK_END` | Pad a column cell and close any open OSC 8 link so it cannot bleed into the next. |

```ts
import { Text } from '@earendil-works/pi-tui';
import { Card } from '@lovelace/tui-components';

const card = new Card({ background: text => '\x1b[48;5;236m' + text + '\x1b[0m' });
card.addChild(new Text('Hello', 0, 0));
card.render(40);
```
