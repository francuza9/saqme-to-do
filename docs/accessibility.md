# Accessibility

What the apps do so that they work from the keyboard, with screen readers and with low vision; how each
part is checked; and what is not verified automatically. Target: WCAG 2.2 level AA.

| | Phone app (iPhone, Android, browsers, and the window of the Linux/macOS app) | Windows widget |
|---|---|---|
| Checked with | `worker/test/ui/pwa-a11y-check.mjs`: axe-core 4 (WCAG 2.2 A/AA + best practices) on every main view in both themes, plus keyboard, focus, announcement, motion and zoom checks in Chromium | `scripts/dev/uia-check.ps1`: reads the UI Automation tree, which is what Narrator and other Windows screen readers use, in the list, Settings and each of its pages, and the shortcuts view |
| Result | no serious or critical axe findings; all behaviour checks pass | every control named, operable and focusable; structure and Tab order as below |
| Colours | `worker/test/node/tokens.test.js` for both apps: text ≥ 4.5 : 1, status chips, their glyphs and the focus ring ≥ 3 : 1 (also on hovered and selected rows), in both themes | |

## Phone app

- **Structure.** Header (banner) with the project tabs as a navigation landmark (the current one marked
  `aria-current="page"`), the list as the main landmark with a hidden heading naming the project, and one list
  per section (tasks, *Postponed*, *Completed*) under real headings. Each task is a list item with
  `aria-level` for nesting, so "level 2" tells a subtask apart. Settings, *Recently deleted* and *Conflicts*
  have a back button and a level-1 heading; their groups have level-2 headings.
- **Names and states.** Every icon button has a label (status, task menu, subtasks, sync, new project). The
  status chip says the status in words ("Status: In progress"); deadlines say "Deadline: Today 16:30" and add
  ", overdue" when they are late; "1/3" is read as "1 of 3 subtasks closed". The subtasks button reports
  `aria-expanded`; the theme choice and the *Completed* toggle report their state.
- **Keyboard.** Everything is a real button, link or field, reachable with Tab. A task's text is a button
  that opens the editor. Up / Down select tasks and move keyboard focus to the task row, which reads as one
  phrase: text, status, deadline, subtasks. Shortcuts (Space done, Ctrl+D deadline, Ctrl+I notes, Ctrl+M menu,
  Alt+Up / Down move) never take Enter or Space away from a focused control.
- **Focus.** A 2 px violet ring on everything focusable (`:focus-visible`). Sheets (task menu, status,
  deadline, ...) are named modal dialogs: focus moves in, Tab stays in, Escape closes, and focus returns to the
  control that opened them. The page is rebuilt after every change; focus stays on the same control.
- **Announcements.** Messages ("Task deleted. Undo is available.") go to a live region that is always in the
  page; a message with an action stays while it has focus or the pointer.
- **Motion and size.** No transitions with *reduce motion*. Touch targets are at least 24 px (most 44 px).
  At 200 % zoom on a 390 px phone (195 px wide) and at 320 px nothing scrolls sideways or gets cut off; below
  280 px the drag handle column is dropped and the indent halves.
- **Dragging** has alternatives for everyone: *Move up / down*, *Make subtask*, *Move out one level* in the task
  menu, and Alt+Up / Down.

## Windows widget

WPF shows plain shapes to UI Automation only as their text, so a status chip or a tab was invisible as a
control. `desktop/a11y.cs` adds a small `AccessibleBorder`: still the same element for the mouse, but
keyboard-focusable, activated with Enter / Space, and reported with a role and the matching action. The widget
compiles it once with the .NET Framework's own compiler (about 0.2 s; later starts load the cached DLL in
milliseconds) and falls back to the old elements if that ever fails.

- **Roles.** Project tabs are a tab list with selectable tabs ("Work, 7 open", selected). Tasks are a list of
  items named with their text, status in words, deadline (with "overdue"), subtasks and notes; the selected one
  is reported as selected. Status chips, chevrons and deadlines inside a task are buttons ("Status: Blocked /
  waiting", "Expand subtasks and notes", "Deadline: 17 Oct, overdue"). The theme choice is three radio buttons;
  *Start with Windows* is a check box with its state; all other controls are named buttons, including the
  window buttons and the settings button (the logo). Every text box has a name and a hint (placeholders are
  not labels). Decorative glyphs and placeholders are hidden from screen readers; hidden hover tools are not
  in the tree.
- **Settings.** A list of pages, each a button whose name says the page and how it stands ("Sync & sharing,
  Synced 2 min ago, 1 conflict") and whose description says what is on it. Every view's title is its Back button
  and names where it goes ("General - back to Settings"). *Advanced* on Sync & sharing is a disclosure: a button
  that reports expanded or collapsed (UI Automation's ExpandCollapse) and says in its hint what is inside. The
  version line under the Settings views is read as text; when an update needs a look it becomes a link that says
  so ("Saqme To Do 1.1.0. Update available: 1.2.0") and opens Updates. The violet "needs a look" dot is never
  alone: the words next to it say what it is about.
- **Grouped lists.** The cards and hairlines of the desktop's look are drawing only: a screen reader meets each
  row as one control (a page, an action, a switch, a text box) or one line of text, and the card headings and
  footnotes as text in reading order. What a row used to say on a second line is in its control's description
  (and tooltip) or in the footnote under the card. *Completed* in the list is a disclosure that reports whether
  the completed tasks are shown.
- **Keyboard and Tab order.** Tab moves through the window: Settings, the current project tab (Left / Right
  switch projects), New project, sync and conflicts when shown, Options, Minimize, Fullscreen, Close, the task
  list (one stop: the selected task), the *Completed* toggle, the new-task box. Enter / Space use the focused
  control. In the list, Up / Down move the selection and keyboard focus together, so Narrator reads each
  task; Enter edits, Space marks done, Ctrl+M opens the task menu (now with *Change status...*), Shift+F10 the
  menu of the focused tab or task. The keyboard shortcuts page (Settings > General) lists them all. In Settings,
  Tab goes from the window buttons to the view's title (Back), then down the page, and last to the version line
  when it is a link; Esc goes back one level (a page to Settings, Settings to the list), and Ctrl+, opens or
  closes Settings.
- **Focus.** A 2 px violet ring (the theme's accent, ≥ 3 : 1) on the focused control, shown for keyboard focus
  only; the selected task keeps its tinted line and violet edge. After every change the widget puts focus back
  on the selected task. Opening a Settings view puts focus on its title, so a screen reader says where you are;
  going back puts it on the row you came from (or, back in the list with no task selected, on the Settings
  button); a view rebuilt in place (sync status, a switch flipped) keeps focus on the same control.

## Colour and contrast

All in `design/tokens.json`, shared by both apps and tested on every run:

- Text ≥ 4.5 : 1 on everything it sits on (surface, frame, hovered and selected rows, deadline washes, notes,
  and the desktop's cards at rest, hovered, pressed and selected).
- Status chips (WCAG 1.4.11) ≥ 3 : 1 against the list, a hovered row and the selected row (on the phone's
  surface and on the desktop's cards); the glyphs on filled
  chips ≥ 3 : 1 against the chip; the focus ring ≥ 3 : 1. Six status colours are a little darker or lighter
  than their first versions to get there, with the same hue and meaning:

  | Status | Dark theme | Light theme |
  |---|---|---|
  | to do (outline) | `#7A7386` → `#7C7589` | `#9A9282` → `#827A69` |
  | in progress (amber half) | `#E8A23A` (kept) | `#E39B2D` → `#A86E16` |
  | done (grey, check) | `#5A5364` → `#7E758C` | `#B9B2A3` → `#847A65` |
  | postponed (blue, clock) | `#4F86C6` (kept) | `#4F86C6` → `#427DC2` |
  | blocked (purple, !) | `#6E62C8` → `#776BCB` | `#6E62C8` (kept) |
  | failed (red, ×) | `#D94B45` (kept) | `#D94B45` → `#D94943` |
  | abandoned (grey, dash) | `#655E70` → `#7D748A` | `#8F8899` → `#7F788B` |

- **Never colour alone.** Each status has its own shape or glyph (outline, half fill, check, clock, !, ×, dash)
  and its name in words for screen readers; closed tasks are also struck through, postponed ones italic.
  Overdue and due-soon deadlines are said in words, not only shown in red and amber.

## Not verified automatically

- **Real screen readers.** The checks read the same information Narrator, VoiceOver and TalkBack use (UI
  Automation, the browser's accessibility tree through axe-core), but no one listened to them. Worth a session
  with Narrator on Windows and VoiceOver on an iPhone before claiming more.
- **Safari and WebKit.** The phone checks run in Chromium. Safari supports the same features (`inert` from
  iOS 15.5); its accessibility tree was not inspected.
- **The desktop focus ring on screen.** It is a standard WPF focus visual with a tested colour, but the check
  window runs off-screen without taking focus (so it never disturbs your desktop), so the ring was not seen.
- **Windows High Contrast themes** are not supported: the widget keeps its own colours (tested for contrast
  above, Settings included). Larger text works through Windows display scaling, not through the separate *Text
  size* setting.
- **iOS Dynamic Type** does not change the phone app's text size (it uses fixed sizes); page zoom does.

## Running the checks

```bash
cd worker && npm i --no-save playwright@1 axe-core@4 && npx playwright install chromium   # once
npm run dev                                         # another terminal, fresh database
node test/ui/pwa-a11y-check.mjs
npx vitest run test/node/tokens.test.js             # contrast (also part of npm test)
```

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\dev\uia-check.ps1   # writes the full tree to %TEMP%\saqme-uia
```
