# Accessibility

What the apps do so that they work from the keyboard, with screen readers and with low vision; how each
part is checked; and what is not verified automatically. Target: WCAG 2.2 level AA.

| | Phone app (iPhone, Android, browsers, and the window of the Linux/macOS app) | Windows widget |
|---|---|---|
| Checked with | `worker/test/ui/pwa-a11y-check.mjs`: axe-core 4 (WCAG 2.2 A/AA + best practices) on every main view, the lists menu and every page of Settings in both themes, plus keyboard, focus, announcement, motion and zoom checks in Chromium | `scripts/dev/uia-check.ps1`: reads the UI Automation tree, which is what Narrator and other Windows screen readers use, in the list, Settings and each of its pages, and the shortcuts view |
| Result | no serious or critical axe findings; all behaviour checks pass | every control named, operable and focusable; structure and Tab order as below |
| Colours | `worker/test/node/tokens.test.js` for both apps: text ≥ 4.5 : 1, status chips, their glyphs and the focus ring ≥ 3 : 1 (also on hovered and selected rows), in both themes | |

## Phone app

- **Structure.** Header (banner) with Settings, the list switcher and sync; the list as the main landmark with a
  hidden heading naming the list, and one list
  per section (tasks, *Postponed*, *Completed*) under real headings. Each task is a list item with
  `aria-level` for nesting, so "level 2" tells a subtask apart. Settings, each of its pages (General,
  Notifications, Sync & sharing, Your lists, Updates in the Linux/macOS window, About), *Keyboard shortcuts*,
  *Recently deleted* and *Conflicts* have a Back button that says where it goes ("Back to Settings") and a
  level-1 heading; their cards have level-2 headings (level 3 in the Share sheet, under its title).
- **The list switcher.** The title is a menu button (`aria-haspopup="menu"`, `aria-expanded`) named by the
  list ("Work", ", shared" for a shared one); its description says it shows your lists and, with the violet
  dot, which other list has something due, so the dot is never colour alone. The lists menu is a `menu`: each
  list a `menuitemradio`, the current one `aria-checked`, its name followed by its open tasks ("Home, 3 open")
  or what is due ("Home, 2 due"; its tooltip and description add how many are overdue), and *New list* a
  `menuitem` in a group of its own. Under the menu the list and the add line are inert. A swipe between lists
  has keyboard and screen-reader ways too: the menu, and Left / Right on the title, which say the new list's
  name through the live region.
- **Names and states.** Every icon button has a label (status, task menu, subtasks, sync). The
  status chip says the status in words ("Status: In progress"); deadlines say "Deadline: Today 16:30" and add
  ", overdue" when they are late; "1/3" is read as "1 of 3 subtasks closed". The subtasks button reports
  `aria-expanded`; the theme choice and the *Completed* toggle report their state.
- **Grouped lists.** The cards and hairlines are drawing only: a screen reader meets each row as one control (a
  page, an action, a switch, a text box with its buttons) or one line of text, and the headings and footnotes
  as text in reading order. A row's name is what it shows ("Sync & sharing Synced 2 min ago"), so voice control
  can say it; what a second line used to say is its description (`aria-description`, also the tooltip) or the
  footnote under its card. The violet "needs a look" dot is never alone: the value next to it says what it is
  about. *Notifications* is a switch (`role="switch"`, `aria-checked`); *Advanced* on Sync & sharing and each
  person in the Share sheet are disclosures (`aria-expanded`); a person's access choices report `aria-pressed`.
  Rows are rebuilt as sync status changes, so their footnotes are not live regions: what happens (a failed
  setup, a toast) is announced once, where it happens.
- **Keyboard.** Everything is a real button, link or field, reachable with Tab. A task's text is a button
  that opens the editor. Up / Down select tasks and move keyboard focus to the task row, which reads as one
  phrase: text, status, deadline, subtasks. Shortcuts (Space done, Ctrl+D deadline, Ctrl+I notes, Ctrl+M menu,
  Alt+Up / Down move) never take Enter or Space away from a focused control. On the title, Left / Right go to the
  previous / next list and Enter, Space or Down open the lists menu (Up opens it on *New list*); the arrows there
  are the title's, not the task selection's. In the menu Up / Down move (round at the ends), Home / End and a
  typed letter jump, Enter switches, Esc closes it, Tab closes it and moves on; Ctrl+M, Shift+F10 or the menu key
  open the focused list's own menu (share, rename, move, delete).
- **Focus.** A 2 px violet ring on everything focusable (`:focus-visible`; inside a card it is drawn inset,
  so the card's corners never cut it), for the keyboard only: the app keeps the last kind of input on the root
  (`data-input`), and after a tap or a click there is no ring, also on focus the app moves itself (a page's Back
  button) and in a text box, where browsers would draw one. Focus the app moves asks for the ring after keys
  (`focusVisible`). Sheets (task menu, status, deadline, ...) are named modal dialogs: focus
  moves in, Tab stays in, Escape closes, and focus returns to the control that opened them. The lists menu opens
  with focus on the current list and gives it back to the title when it closes (also after a list's own menu
  opened from it). The page is rebuilt
  after every change; focus stays on the same control, and a text box keeps what was typed in it.
- **Settings by keyboard.** Opening a view puts focus on its Back button, so a screen reader says where you
  are. Esc goes back one level (a page to Settings, Recently deleted to Your lists, Settings to the list) and
  focus returns to the row you came from (in the list: the selected task, else the Settings button); Esc in an
  open sheet only closes the sheet. *Keyboard shortcuts* (Settings > General, where there is a keyboard) lists
  them all. In Settings the header is only the Settings button (☰), a toggle button (`aria-pressed`) that is
  pressed there and goes back to the list; the list's name, conflicts and sync are `inert` there (out of Tab's
  and screen readers' reach at once, while they fade). A page that slides in has focus from the start; the page
  leaving is `inert` and `aria-hidden`.
- **Announcements.** Messages ("Task deleted. Undo is available.") go to a live region that is always in the
  page; a message with an action stays while it has focus or the pointer.
- **Motion and size.** No transitions with *reduce motion*: Settings pages change without sliding, a press only
  tints, and a swipe between lists changes the list without it following the finger or sliding in. Nothing waits
  for a move (docs/design.md, "Motion"). Touch targets are at least 24 px (most 44 px).
  At 200 % zoom on a 390 px phone (195 px wide) and at 320 px nothing scrolls sideways or gets cut off (the
  list, the lists menu, Settings and Sync & sharing are checked); below 360 px the rows of Settings wrap their
  labels and values instead of ending them in "…", and below 280 px the drag handle column is dropped and the
  indent halves. The title ends a long list name in "…"; the lists menu always shows it whole (it wraps).
- **Dragging** has alternatives for everyone: *Move up / down*, *Make subtask*, *Move out one level* in the task
  menu, and Alt+Up / Down.

## Windows widget

WPF shows plain shapes to UI Automation only as their text, so a status chip or a tab was invisible as a
control. `desktop/a11y.cs` adds a small `AccessibleBorder`: still the same element for the mouse, but
keyboard-focusable, activated with Enter / Space, and reported with a role and the matching action. The widget
compiles it once with the .NET Framework's own compiler (about 0.2 s; later starts load the cached DLL in
milliseconds) and falls back to the old elements if that ever fails.

- **The list switcher.** The title is a button with Invoke and ExpandCollapse (a menu button: Narrator says
  "Work, collapsed" and "expanded" while the menu is open), named by the list (", shared" for a shared one);
  its description says it shows your lists and, with the violet dot, which other list has something due, so the
  dot is never colour alone. The lists menu is a popup of radio buttons, one per list, the current one selected,
  named like "Home, 2 due, 1 overdue" or "Home, 3 open", and *New list* a button after them. Up / Down, Home /
  End, Enter, Esc and Tab work in it, and focus goes back to the title; Left / Right on the title switch lists
  and Down opens the menu. A list's own menu (Share, Rename, Move up / down, Delete, Leave) is the context menu of a row and of
  the title (Shift+F10). `scripts/dev/uia-check.ps1` expands and collapses the title through UI Automation and
  reads the rows.
- **Roles.** Tasks are a list of
  items named with their text, status in words, deadline (with "overdue"), subtasks and notes; the selected one
  is reported as selected. Status chips, chevrons and deadlines inside a task are buttons ("Status: Blocked /
  waiting", "Expand subtasks and notes", "Deadline: 17 Oct, overdue"). The theme choice is three radio buttons;
  *Start with Windows* is a check box with its state; all other controls are named buttons, including the
  window buttons. The settings button (☰) is a toggle button (Invoke and Toggle): on while Settings are open,
  when the list's name, sync and Options are hidden from the tree. Every text box has a name and a hint (placeholders are
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
  only: it is visible only while the keyboard is in use (the last input, also with Windows' *Underline access
  keys* on), never after a click or a tap; the selected task keeps its tinted line and violet edge. While a
  Settings page slides in, the one leaving takes no clicks or Tab. After every change the widget puts focus back
  on the selected task. Opening a Settings view puts focus on its title, so a screen reader says where you are;
  going back puts it on the row you came from (or, back in the list with no task selected, on the Settings
  button); a view rebuilt in place (sync status, a switch flipped) keeps focus on the same control.

## Colour and contrast

All in `design/tokens.json`, shared by both apps and tested on every run:

- Text ≥ 4.5 : 1 on everything it sits on (surface, frame, hovered and selected rows, deadline washes, notes,
  and the cards at rest, hovered, pressed and selected). Closed grey is the exception on a selected row (3.9 : 1
  dark, 4.3 : 1 light), so the phone app draws a selected closed task in smoke; the Windows widget still uses
  closed grey there.
- The phone app's switch: off, a smoke track (≥ 3 : 1 on the card) with a knob of the card's colour; on, a
  violet track with an on-violet knob (≥ 3 : 1).
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
  iOS 15.5); its accessibility tree was not inspected. WebKit draws a focus ring after a tap in more places than
  Chromium (focus the app moves): the app's own input flag hides it whatever the browser decides, which the checks
  test in Chromium (with a text box, which Chromium also rings) but nobody saw on an iPhone.
- **The desktop focus ring on screen.** It is a standard WPF focus visual with a tested colour; the self-check
  tests that it follows the kind of input (keys, a click), but the check window runs off-screen without taking
  focus (so it never disturbs your desktop), so the ring was not seen. For a moment while a Settings page slides
  in (280 ms), UI Automation still lists the page that leaves.
- **Windows High Contrast themes** are not supported: the widget keeps its own colours (tested for contrast
  above, Settings included). Larger text works through Windows display scaling, not through the separate *Text
  size* setting.
- **iOS Dynamic Type** does not change the phone app's text size (it uses fixed sizes); page zoom does.

## Running the checks

```bash
cd worker && npm install && npx playwright install chromium   # once (Playwright and axe-core are devDependencies)
npm run dev                                         # another terminal, fresh database
node test/ui/pwa-a11y-check.mjs
npx vitest run test/node/tokens.test.js             # contrast (also part of npm test)
```

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\dev\uia-check.ps1   # writes the full tree to %TEMP%\saqme-uia
```
