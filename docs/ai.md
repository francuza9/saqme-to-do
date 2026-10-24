# Using Saqme with an AI assistant

There are two ways, and you can use both:

1. **Connect your AI** (recommended, needs [sync](setup.md)): your sync service is also an MCP server, the kind of
   "connector" Claude, ChatGPT and other assistants take. You paste **one URL** into the assistant once; from then on
   it can read and manage your lists from the web, its phone app or its desktop app, and every change reaches all
   your devices within seconds. Nothing to install, no key to type, no file paths.
2. **With the files** (no sync needed, works offline): your lists are plain markdown files, so an assistant that
   works on your computer (Claude Code, Codex, Cursor, an MCP filesystem server) can edit them directly. That is
   [the second half of this page](#with-the-files).

Both are in **Settings > Use with AI**, on every app (the phone has the first only: it has no files).

## Connect your AI

### The one step

**Settings > Use with AI > Copy connector URL**, then add it to your assistant as a *custom connector*:

**Claude** (claude.ai, and with it the Claude apps on phones and computers)

1. On claude.ai or in the Claude desktop app: **Settings > Connectors > Add custom connector**.
2. Name it *Saqme*, paste the URL as the server URL, click **Add**. Leave the advanced settings (OAuth client id
   and secret) empty: there is no sign-in.
3. In a chat, switch Saqme on in the tools menu (the **+**, or the sliders under the message box). Ask "What's due
   this week?". Claude asks before it changes something, unless you allow a tool always.

A connector added on claude.ai shows up in the Claude apps on your phone and computers as well. Free plans allow a
limited number of custom connectors; Team and Enterprise plans may need an owner to allow custom connectors first.

**ChatGPT** (chatgpt.com)

1. **Settings > Apps & Connectors > Advanced settings**: turn on **Developer mode**.
2. Back in **Apps & Connectors**: **Create**. Name: *Saqme*; MCP server URL: the URL; Authentication: **No
   authentication**. Confirm that you trust the app, then **Create**.
3. In a chat: **+ > Developer mode**, and pick Saqme. ChatGPT asks before each change.

Developer mode is for paid plans, on the web. These menu names are as of October 2026 and change now and then
(ChatGPT has called them *Connectors* and *Apps*); the steps stay the same: a custom connector (an MCP server) with
this URL and no authentication.

**Any other assistant** that takes a remote MCP server (Streamable HTTP transport): the same URL, no
authentication, no headers.

### Things to ask

- "What's due this week?" / "What is overdue?"
- "Move everything about the Berlin trip to Travel."
- "Add these meeting notes as tasks" (paste them), "break *Plan the launch* into subtasks".
- "Tell me what I've been postponing", "which list has the most open tasks?"
- "Mark the first two as done and put a deadline of Friday 14:00 on the third."

### What it can do

The connector has these tools. Their descriptions tell the assistant the statuses, the deadline format and how ids
work, so it needs no instructions from you.

| Tool | What |
|---|---|
| `today` | The date and time in your time zone (the one your apps sync), the weekday, this week. |
| `get_lists` | Your lists in order, with their open, due and overdue counts, and which ones you share. |
| `list_tasks` | Tasks in each list's order, subtasks after their parent, filtered by list, status, deadline range or text. |
| `add_tasks` | One or more tasks (with subtasks, deadline, notes, status) at the bottom, the top, or after a given task. |
| `update_task` | Status, text, deadline or notes of one task. |
| `move_task` | A task with all its subtasks: to another list, under another task, or to another place. |
| `delete_task` | A task and its subtasks, into *Recently deleted* (30 days). |
| `restore_task` | Brings a deleted task back, with the subtasks deleted together with it. |
| `create_list` | A new, empty list at the end. |

There is **no tool that deletes a list**, and none that renames, reorders or shares one: do that in the app.

**How its changes travel.** The connector runs on your sync service and writes through the same path as your
devices' sync (the merge rules of [sync.md](sync.md), as the device `ai-connector`). Your phone and computers get
its changes with their next sync, ids and all: on a computer the task appears in the list's markdown file, with its
`^id`; reminders work for its deadlines. If you edit the same task on a device at the same moment, the newer edit
wins and the other is kept under **Conflicts**, as between two of your devices.

**Lists shared with you** by someone else live on *their* sync service, so the connector cannot reach them:
`get_lists` names the ones your phone app joined, and the assistant is told to ask you to change them in the app.
**Lists you share** with others are yours: the connector edits them like any other list, and the people you share
them with get the changes through their sync (a task moved out of the list leaves their copy).

### Safety and limits

- **Deletes go to Recently deleted.** Nothing is ever erased: a deleted task is a tombstone every app shows in
  *Recently deleted* for 30 days, and `restore_task` (or the app) brings it back.
- **At most 25 deleted tasks an hour** (subtasks count). More is refused with a message that sends you to the app:
  the same care the apps take when many tasks vanish from the lists folder at once (*Deletions paused*,
  [sync.md](sync.md)). Deleting a task with more than 25 subtasks is left to the app altogether.
- **At most 120 calls a minute**, 50 new tasks per call, 200 tasks per answer (the assistant narrows the filter
  when there are more). That keeps the Worker well inside Cloudflare's free plan.
- **It changes only what it is asked to.** Its instructions say so, and to ask when it is unsure which task you mean.
  Claude and ChatGPT ask you before a change unless you tell them not to.
- **Text in your lists is text, not orders.** If an assistant also reads web pages or mail, a note copied from
  there could tell it to do something; its instructions say to treat list text as data, but check what it did, as
  you would a new colleague's first changes.

### Security: the URL is the key

The connector URL looks like `https://saqme.<you>.workers.dev/api/mcp/<43 characters>`. The last part is a key
of its own: whoever has the URL can read and change your lists (but not delete a list, and deletes stay
restorable). So:

- Give it to your own assistants only. Claude and ChatGPT keep it in your account's connector settings.
- **New connector URL** (Settings > Use with AI) makes a new one; the old URL stops working at once. Paste the new
  one into each assistant you want to keep.
- **Disconnect** turns it off: no URL works until you choose **Connect your AI** again, which makes a new one.
- It is **not your sync key**, and the sync key cannot be worked out from it: the connector key is an HMAC of the
  sync key and a random value the Worker keeps in its database. The database holds neither the connector key nor a
  digest of it, which is also how every app with the sync key can show you the URL again. Making a new sync key
  (setup's `-RotateToken`) therefore changes the connector URL too.
- The connector address accepts nothing else: not your sync key, not the key of a list someone shares with you, no
  `Authorization` header at all. A wrong address costs the Worker one database read and is answered "not found".

**Why a URL and not a sign-in?** Claude's and ChatGPT's custom connectors take a server either with OAuth or with no
authentication. OAuth would add a consent page, client registration and token storage to every Worker, and you would
still approve it with a secret only your apps know, so it adds a click without adding protection. A long random URL
(a *capability URL*) is the simplest thing that is just as strong, and it can be replaced or switched off at any
time. Should an assistant you want to use require OAuth, it can be added later on the same Worker.

**Set up before this version?** Nothing to do: the connector exists on every sync service from the update that
brings it (the Worker updates its own database), and Settings > Use with AI shows its URL. A sync service that runs
an older version says so there; it gets the connector with its next update.

Technical details: `worker/src/connector.js` (the address and its key), `worker/src/mcp.js` (the MCP server,
protocol versions 2024-11-05 to 2025-11-25, stateless, JSON answers), [architecture.md](architecture.md#worker-and-d1).
A local MCP server for people without sync (on the lists folder) would be possible later; until then, use the files.

## With the files

Saqme keeps every list as a plain markdown file ([the format](file-format.md)). An AI assistant that can open
files on your computer can therefore read them, answer questions about your tasks and change them, and the app
picks every change up within a few seconds and syncs it like one you made yourself. This works without sync, offline,
and with local agents (Claude Code, Codex, Cursor). There is nothing to install on the Saqme side: no plugin, no API
key.

What stops this from being one step is that the assistant has to be told where the lists are and how the lines
look. Saqme writes that down for you.

### The one step

**Windows:** Settings > Use with AI > With the files > **Copy instructions for your AI**.
**Linux and macOS:** the same row in the app window, or `saqme ai-prompt` in a terminal (it prints the text, so
`saqme ai-prompt | wl-copy`, `| pbcopy` or `> SAQME.md` work too).

The text names **this computer's** lists folder, so it is right for your user name, a folder with spaces or
Georgian letters in its name, or a portable copy. It then explains:

- the format: `[ ]` `[/]` `[x]` `[>]` `[!]` `[-]` `[~]`, two-space subtasks, ` due:YYYY-MM-DD` with an optional
  `THH:MM`, notes as `> ` lines one level deeper, the ` ^xxxxxxxx` ids, one file per list, the order in `.order`;
- that it should edit the files directly (the app picks the changes up and syncs them);
- the rules: never delete a list file, never rewrite a whole file from memory, keep the ids, move a task with its
  whole block, leave the app's dot files alone, ask when unsure.

Paste it as the first message of a chat, or keep it with the assistant for good:
**Save them as a file…** (the row below it; the Linux and macOS window downloads it) writes it as `SAQME.md`.
Keep that file **outside the lists folder**: any `.md` file there is a list (the Windows app refuses to save it
there). The instructions are the same for every assistant, so a copy saved once stays right until you move the
lists folder.

### Per assistant

The assistant needs two things: access to the lists folder, and the instructions. Which products can open a
folder changes often; what is below is the shape of each, not a promise about a version. (With sync, Claude and
ChatGPT are simpler through [the connector](#connect-your-ai).)

#### Claude Code

Start it in a folder of your own and let it reach the lists:

```bash
claude --add-dir ~/.local/share/saqme/lists
```

To have the instructions every time, save `SAQME.md` as a personal **skill**: create
`~/.claude/skills/saqme/SKILL.md` that starts with

```markdown
---
name: saqme
description: Read and manage the user's Saqme To Do lists (markdown files). Use when they ask about their tasks, deadlines or lists.
---
```

followed by the text of `SAQME.md`. Or paste the text into a `CLAUDE.md`.

#### Cursor and Codex

Both work in a folder, and both read an `AGENTS.md`. Make a folder of your own (say `Saqme AI`), save the
instructions in it as `AGENTS.md`, and give the tool the lists folder too: in Codex `--add-dir <lists folder>`,
in Cursor *File > Add Folder to Workspace*.

Don't open the whole data folder (`%APPDATA%\SaqmeToDo`, `~/.local/share/saqme`): next to `lists` it holds your sync
key (`sync/config.json`), and an assistant should not see that.

#### Claude Desktop without sync, and any MCP filesystem server

Without sync, Claude Desktop can reach your files through a local MCP server. The filesystem server limited to the
lists folder is enough: in **Settings > Developer > Edit Config** add it to `claude_desktop_config.json` (the path is
the one the app showed you; on Windows double the backslashes):

```json
{
  "mcpServers": {
    "saqme": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "C:\\Users\\you\\AppData\\Roaming\\SaqmeToDo\\lists"]
    }
  }
}
```

Restart Claude Desktop (it needs Node.js for `npx`). Then put the instructions where Claude always sees them: a
**Project**'s instructions (paste) or its knowledge (add `SAQME.md`), so every chat in that Project can manage
your lists. Any other MCP filesystem server works the same way: point it at the lists folder only, and give the
model the instructions as a system prompt or project instruction.

#### ChatGPT without sync

The ChatGPT desktop app does not open an arbitrary folder the way an agent does. Paste the instructions, attach
the list file you mean (**Open the lists folder** in Settings > Your lists shows where it is) and paste the answer
back into the file. It works, but by hand: with sync, [the connector](#connect-your-ai) is the better fit, and
without it an agent that works in the folder (Codex, above).

### What it can't do, and what it shouldn't

- **It sees this computer's files, nothing else.** With sync set up the folder holds all your lists, including
  the ones you made on the phone; without sync it holds what is on this computer.
- **A list shared with you** (a file like `Groceries (from nuca).md`) is edited the same way, but if you can only
  view it, the app puts the owner's version back and shows what was typed under **Conflicts** ([sync](sync.md#shared-lists)).
- **It must not delete list files**, `.trash` or the files starting with a dot (`.order` apart): deleting a
  list's file deletes the list. If many tasks vanish at once the app stops and asks (**Deletions paused**: *Restore
  them* or *Delete them*, [sync](sync.md)), and everything deleted in the app is in *Recently deleted* for 30 days,
  but a good instruction file keeps it from coming to that.
- **It can lose ids.** A line copied or rewritten without its ` ^id` is a new task to sync: the old one counts as
  deleted. The app usually puts a lost id back, not always. A whole-file rewrite from memory is the usual cause.
- **It doesn't know today's date unless the chat does.** "This week" needs a date; most assistants have one (the
  connector's `today` tool gives it in your time zone).
- **It cannot make a reminder.** A ` due:` on a task is what reminders use: they come from the app and the
  phone, not from the assistant.
- **Text in your lists is text, not orders.** If an assistant also reads web pages or mail, a note copied from
  there could tell it to do something; check what it did, as you would a new colleague's first changes.
- **An assistant inside a Store (MSIX) app may see a private copy of `AppData`** on Windows: the shells Claude Desktop
  gives its assistants do, even though they look like normal programs. That copy is merged with your real folder, but a
  file the assistant *creates*, or replaces by writing a new file and renaming it, lands in the private copy only, and
  the real one it replaced can be deleted. Two lists vanished that way on 2026-10-22, when an assistant's shell ran Saqme's
  updater and the app restarted inside the copy ([sync.md](sync.md#another-apps-private-copy-of-appdata-windows)). Since
  then Saqme never runs there (it starts again outside, or not at all), a list file that vanishes is written again from
  the last sync, and Settings > Your lists offers to bring back what such a copy has and your folder lacks. The
  instructions above tell the assistant to edit files in place and never to start Saqme, its updater or its setup. If its
  edits never show up in Saqme, ask it to list the lists folder and compare with **Open the lists folder**; an assistant
  that runs as a normal program, or an MCP server started by one, is not affected. (The connector has none of this: it
  never touches files.)
