# Design

Saqme (საქმე, "the thing to do") is a list you read many times a day on two very different screens: a
small always-on-top widget on Windows and an iPhone. Both share one set of tokens — [`design/tokens.json`](../design/tokens.json),
from which `scripts/build-tokens.mjs` generates `worker/public/css/tokens.css` and `desktop/tokens.ps1` —
and one bundled typeface. A test fails if the generated files drift from the tokens or if a text colour
drops below WCAG AA.

## Principles

1. **The list is the document.** Rows are lines of a markdown file. Structure comes from type, indentation
   and a few hairlines; a row never gets a box or a shadow of its own. On the desktop the lines sit in
   rounded cards, an inset grouped list like iOS Settings ([Grouped lists](#grouped-lists-windows-widget)).
   Hover and selection tint the whole line, and the selected line gets the 2 px violet edge the widget
   always had.
2. **Colour means state or time, nothing else.** The status chip is the only coloured thing in a normal
   row. Task text stays ink while a task is open, turns quiet when postponed, and quiet + struck through
   when closed. Red and amber appear only when a deadline is overdue or close.
3. **One bold place: the tab strip.** The deep frame colour, the projects as real tabs, and the active tab
   marked with the icon's own violet-to-amber gradient. That gradient appears nowhere else.
4. **Georgian is a first-class script.** The typeface covers Mkhedruli natively (no fallback seam in the
   middle of a list), and line heights leave room for its taller ascenders and descenders.

## Colour

Six named colours per theme. Everything else (hairlines, hover, washes) is derived from them by
mixing, in the generator, so both platforms get identical values.

| Name | Role | Dark ("night") | Light ("paper") |
|---|---|---|---|
| **Surface** | the list | `#1E1A23` plum | `#F6F2EA` warm paper |
| **Frame** | tab strip, sheets, menus | `#15121A` aubergine | `#E9E2D4` linen |
| **Ink** | task text, titles | `#EFEAF4` | `#25211C` |
| **Smoke** | metadata, hints, inactive tabs | `#A39BAE` | `#675F52` |
| **Violet** | links, focus, active edge, primary action | `#C688EE` | `#8930B6` |
| **Amber** | due soon, in progress | `#F2B45A` | `#7F5100` |

Derived: *line* = 12 % ink over surface, *hover* = 5 %, *selected* = 14 % violet, *note* = 4.5 % ink,
*washes* for deadline pills = 16 % (dark) / 13 % (light) of the colour over the surface. *Alert* (overdue)
is `#F2877F` / `#A62B25`.

The cards of a grouped list (desktop) are a step lighter than the surface in both themes, and their rows
derive from the card:

| Name | Derived as | Dark | Light |
|---|---|---|---|
| *card* | 3.5 % ink over surface (dark), 75 % white over surface (light) | `#25212A` | `#FDFCFA` |
| *card hover* | 5 % ink over card | `#2F2B34` | `#F2F1EF` |
| *card pressed* | 9 % ink over card (also the track of a segmented control and of key caps) | `#37333C` | `#EAE8E6` |
| *card selected* | 10 % (dark) / 14 % (light) violet over card | `#352B3E` | `#EDDFF0` |
| *separator* | 11 % ink over card: the hairline between two rows | `#3B3740` | `#E5E4E2` |

The dark card lifts only 3.5 %: more, and closed (struck-through) text and the status chips on a selected row
fall under their contrast minimums. The tests check every text colour on the card at rest, hovered, pressed
and selected, and the chips on all of them.

The tab gradient uses the icon's own endpoints, `#B65CE3 → #F3A14A`, in both themes.

**Status chips** keep their meanings and colours: to do = outlined, in progress = amber half-fill,
done = grey with a check, postponed = blue with a clock, blocked = indigo with "!", failed / rejected =
red with an ×, abandoned = grey with a dash. Text next to them: ink (to do, in progress, blocked), smoke
italic (postponed), *closed* grey struck through (done, failed; abandoned also italic).

All text colours are ≥ 4.5 : 1 on the surface (checked by `worker/test/node/tokens.test.js`); deadline
text is ≥ 4.5 : 1 on its own wash. Status chips, their glyphs and the focus ring are ≥ 3 : 1, also on hovered
and selected rows; the accessibility pass refined six status hex values for that (same hues, same meanings).

## Typeface

**FiraGO** (bBox Type / Carrois, SIL OFL 1.1) — Fira Sans extended with Georgian, Cyrillic, Arabic and more.

- Fira was drawn for small, low-resolution screens (Firefox OS): open apertures, a large x-height, distinct
  `Il1`, and it stays crisp at 12–13 px, where this app's metadata lives.
- It has real tabular figures (`tnum`), switched on for every date, time and count.
- Its Georgian is designed with the Latin, so a list that mixes "Budget review" and "ბიუჯეტის განხილვა"
  reads as one voice instead of switching fonts mid-line.
- It is not a default: no platform ships it, it is not Inter/Roboto, and its humanist shapes are warmer
  than the neo-grotesques most to-do apps use — fitting the paper / plum palette.

Bundled as four subsets (Latin, Cyrillic, Georgian, punctuation, ₾; all OpenType features kept):
Regular, Italic, Medium, SemiBold (`worker/public/fonts`, ~260 kB each; `scripts/dev/subset-fonts.mjs`
rebuilds them). The phone app self-hosts them; the desktop loads the very same files through a file-based
`FontFamily`, falling back to Segoe UI if they are missing. Fallback on the web: `system-ui` and
Noto Sans Georgian.

## Type scale

Same numbers on both platforms (CSS px = WPF device-independent px).

| Role | Size / line | Weight | Used for |
|---|---|---|---|
| display | 22 / 28 | 600 | welcome title |
| title | 18 / 24 | 600 | view headers (Settings, Conflicts) |
| body | 15 / 22 | 400 | task text, inputs, setting names |
| label | 14 / 20 | 500 | tabs, buttons, menu items |
| meta | 13 / 18 | 400, tnum | deadlines, subtask counts, hints |
| small | 12 / 16 | 500, tnum | section labels, tab counts |

No uppercase anywhere; hierarchy comes from size and weight. On touch screens the text editor uses 16 px
so iOS does not zoom into it.

## Spacing and shape

Spacing steps (px): **2, 4, 8, 12, 16, 24, 32**. Rows: 12 px between chip and text, 2 px between a task's
text and its meta line, 20 px indentation per subtask level.

Radius follows hierarchy — bigger containers, rounder corners; content lines, none:

| Element | Radius |
|---|---|
| window, bottom sheet | 14 |
| card of a grouped list (desktop) | 12 |
| tab (top corners) | 10 |
| controls: buttons, inputs, deadline pills, menu items | 7 |
| status chip | 5 |
| list rows | 0 (they are lines; on the desktop the first and last row of a card carry its corners) |

Shadows: the desktop window and phone sheets only. Sheets sit on a dimmed backdrop with a hairline top
edge instead of a soft drop shadow.

## Row anatomy

```
 indent  grip chev chip  text ................................................  ⋯
 ├─20─┤  ┆┆  ›   ◧     Ship the Q4 roadmap draft                                 ⋯    ← body 15/22, ink
                       Today 16:30   1/3   ⛓                                          ← meta 13/18, smoke, tnum
         14  24   26   │← text and meta share one column, so long titles get the full width
```

The columns are the click/touch targets (phone widths shown; the desktop uses 13 / 16 / the chip, for the
mouse); the margins around them are kept small so text gets the width. Phone: the chevron stays 24 px wide
(the minimum target size), the status button is the 18 px chip with 4 px either side.

- **Phone: meta moves under the text** (deadline, subtask progress, notes mark) instead of competing with it on
  the same line. Rows without metadata stay single-line.
- **Desktop: meta sits on the right of the first line**, like the value of an iOS row: notes mark, subtask
  progress, then the deadline at the far right. The task's text wraps only when it must (it is your own
  words), and in a window narrower than 380 px the meta goes back under the text so the text keeps its line.
  On hover the row's tools (deadline, notes, subtask, delete) take the meta's place.
- **Deadline pill only when it matters:** overdue (alert on alert wash) and today/tomorrow (amber on amber
  wash). Later deadlines are plain smoke text ("Fri", "2 Nov").
- Minimum row height: **48 px on touch** (phone), **40 px with a mouse** (desktop task rows; Settings rows
  44 px).
- Grip: shown faintly only on manually ordered rows. Phone: "⋯" at the end opens the task menu
  (long-press works too). Desktop: tools appear on hover over the end of the line, as before.
- Section breaks are sentence-case small labels: "Postponed", "Completed · 2" (a disclosure you can open). On
  the phone a hairline runs from them to the right edge; on the desktop they are the headings of the cards
  under them.
- The add bar is drawn like the next line of the list: its "+" sits in the chip column and "Add a task" in
  the text column (on the desktop in a card of its own at the bottom).
- The "+" for a new project stays next to the last tab; when there are more projects than fit, the tabs
  scroll sideways and fade out at the clipped edge(s) instead of cutting a tab in half, the current project
  is always scrolled into view, and (desktop) a "⌄" button before the "+" lists every project. The tab area
  ends where the sync and window buttons begin; long project names end in "…" (full name in the tooltip).

## Grouped lists (Windows widget)

The desktop's list and every view of its Settings (with Share, Conflicts, Recently deleted, Pair phone and the
keyboard shortcuts) use one pattern, the inset grouped list of iOS Settings:

```
  Shared lists                                     ← heading: small 12/16 medium, smoke, sentence case
 ╭───────────────────────────────────────────╮
 │  Paste an invite link to join        Join │     ← a row: one line, 44 px (task rows 40 px)
 │  ─────────────────────────────────────────│     ← hairline from where the text starts, to the edge
 │  Groceries (from nuca)   Can edit   Leave │     ← label … value … control / chevron
 ╰───────────────────────────────────────────╯
  Someone shared a list with you? Paste …          ← footnote: meta 13/18, smoke, under the card
```

| Token | Value | What |
|---|---|---|
| `card.inset` | 12 px | window edge to card (the scrollbar is drawn over this margin) |
| `radius.card` | 12 px | the card's corners: on its first and last row, so their hover and pressed tints fit them |
| `card.padding` | 14 px | card edge to a row's text; an icon takes 16 px + 12 px before the text |
| `card.gap` | 20 px | between cards (from a card or its footnote to the next heading or card) |
| `card.rowMin` | 44 px | a Settings row; task rows use `row.minPointer`, 40 px |
| heading | `small`, smoke | 6 px above its card; the list's headings line up with the status chips |
| footnote | `meta`, smoke | 6 px under its card |
| hairline | 1 px *separator* | between two rows; it starts where the lower row's text starts (after the icon, the chip, or a subtask's indent) and runs to the card's right edge; none above the first row or below the last, and none between a task and its open notes |

**One line of text per row.** A row is an optional small icon, its label, and on the right a short muted
value ("Off", "10:00", "Synced 2 min ago", "1.1.0") and/or a chevron when it opens a page, a switch, a choice
or a small text button. A row never has a second line under its label: an explanation is dropped when it is
obvious, becomes the value when it is a state, or goes to the footnote under the card when it is really
needed. Whatever leaves a row stays in its tooltip and in the description a screen reader reads. The violet
"needs a look" dot sits before the value. Labels and values never wrap (a long one ends in "…", whole in the
tooltip); only your own words wrap: a task's text, its notes.

Rows that do something are whole-row buttons: a page (label, value, chevron), or an action, its label violet
(red when it is risky: *Turn off sync*, *Delete them*). A row with a switch flips it from anywhere on the row.
Text boxes are rows themselves (*Paste an invite link to join*), with their button at the end. The whole row
reacts: *card hover* under the mouse, *card pressed* while pressed. *Advanced* is such a row; open, its rows
follow it in the same card. In the list, the tasks of a list are one card (a heading or a blank line in the
file starts another), subtasks are indented inside it, and *Postponed* and *Completed* are cards under their
own headings (*Completed* opens and closes from its heading).

- Text contrast ≥ 4.5 : 1 in both themes (tested). Status never relies on colour alone: every chip has a
  shape or glyph, closed tasks are also struck through.
- Visible focus: a 2 px violet ring on every focusable control in both apps (`:focus-visible` on the phone,
  a focus visual for keyboard focus on the desktop); the selected task also keeps its tinted line + violet edge.
- Motion only for small state changes (sheet rise, chevron turn) and none at all with
  `prefers-reduced-motion`.
- Touch targets ≥ 44 px on the phone for rows and main controls, never under 24 px.

## Design decisions

- **Violet is rare.** It marks links, keyboard focus, the selected line's edge and the single primary action
  in a sheet. Other buttons are ink on a faint tint.
- **No boxes inside boxes, no shadows.** Sheets use the frame colour with a hairline top edge. On the desktop,
  rows sit in grouped cards: a few rounded shapes on a calm background, hairlines inside, nothing boxed within a
  card (an open task's notes are quiet text, not a box; buttons in a row are text).
- **Settings in a narrow window is a list of pages.** On the desktop, Settings shows one row per page in two
  cards (General, Notifications, Sync & sharing, Your lists; then *App*: Updates, About), each with its icon, a
  short value and a chevron; each page is short, cards of one-line rows again. Places you go to have a chevron,
  actions are violet rows. Rare or risky actions sit at the bottom of their page under *Advanced*, a row that
  opens the rest of its card. A quiet meta line under every Settings view says the version; a violet dot (with
  words) marks what needs a look: an update, a conflict.
- **Pills only when time is short.** A deadline gets a pill when it is overdue, today or tomorrow; later
  ones are plain text, so the list never looks like a tag cloud.
- **Status lives in the chip.** Task text is never tinted by status: the coloured chip already says it, and
  several colours of text in one list read as noise.
- **One line for the task, a quieter one for the rest** (phone). Deadline, progress and the notes marker sit
  under the title, so short tasks never wrap beside a pill on a phone. The desktop window is wider: there they
  are the row's value on the right, and a task is one line.
- **A 4 px grid** keeps phone and desktop aligned; the 12 px chip-to-text gap and the 2 px text-to-meta gap
  group a task's two lines.
- **Quiet labels and numbers.** Section labels are sentence case (never uppercase and tracked); counts use a
  middle dot ("Completed · 2"), not badges; figures are tabular so `1/3` and `16:30` do not jitter.
