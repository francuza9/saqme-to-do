# Use Saqme with your AI

Connect Claude, ChatGPT or another AI app to your Saqme lists. Then just ask it things like "What's due this
week?" or "Add milk to Groceries", and the changes show up in Saqme.

Open **Settings › Use with AI** in Saqme. The best way for you comes first:

- **Sync on:** *Connect Claude* or *Connect ChatGPT*. Works on the web, on your phone and on your computer.
- **Sync off:** *Connect Claude Desktop*. One click, for Claude's app on this computer. No sync needed.

<!-- SCREENSHOT: Saqme, Settings › Use with AI, with Connect Claude and Connect ChatGPT -->

## Connect Claude

You need Saqme sync turned on (free; [the setup guide](setup.md) shows every step) and a Claude account.

1. In Saqme, open **Settings › Use with AI** and click **Connect Claude**. Saqme copies your link and opens
   Claude's **Connectors** page.
2. Click **Add custom connector**, type **Saqme** as the name, paste the link into the **URL** box and click **Add**.
3. In a new chat, click **+** under the message box, switch **Saqme** on and ask "What's due this week?" Click
   **Allow** when Claude asks to use Saqme.

Saqme then works in the Claude apps on your phone and computer too.

<!-- SCREENSHOT: claude.ai, Settings › Connectors › Add custom connector, filled in -->

## Connect ChatGPT

You need Saqme sync turned on and a paid ChatGPT plan (Developer mode, on chatgpt.com in a browser).

1. In Saqme, open **Settings › Use with AI** and click **Connect ChatGPT**. Saqme copies your link and opens
   ChatGPT's settings at **Apps & Connectors**.
2. Open **Advanced settings** and switch on **Developer mode**. Back in **Apps & Connectors**, click **Create**.
3. Type **Saqme** as the name and paste the link into the **URL** box. Choose **No authentication**, tick **I trust
   this application** and click **Create**.
4. In a new chat, click **+**, then **More › Developer mode**, pick **Saqme** and ask "What's due this week?"

If the settings don't open by themselves, open them yourself: **Settings › Apps & Connectors** (in newer versions
just **Apps**).

<!-- SCREENSHOT: chatgpt.com, the Create window, filled in -->

## Connect Claude Desktop

For Claude's app on your computer (Windows or Mac). No sync needed: it works with the lists on this computer.

1. Install [Claude Desktop](https://claude.ai/download) if you don't have it yet, and sign in. (Saqme shows
   **Install Claude Desktop** until it is there.)
2. In Saqme, open **Settings › Use with AI** and click **Connect Claude Desktop**.
3. Quit Claude Desktop completely and open it again. On Windows: its menu **File › Exit**, or right-click its icon
   next to the clock and choose **Quit**. On a Mac: **Claude › Quit Claude**. Closing the window is not enough.
4. In any chat, ask "What's due this week?" Click **Allow** when Claude asks to use Saqme.

**Disconnect Claude Desktop**, on the same page, takes Saqme out again.

<!-- SCREENSHOT: Saqme, Settings › Use with AI without sync, Connect Claude Desktop first -->

## Other AI apps

If your AI app lets you add a *custom connector* with a link, it works the same way: click **Copy link** in Saqme,
paste it there, and choose no sign-in if it asks.

## What to ask

- "What's due this week?" / "What is overdue?"
- "Add these meeting notes as tasks" (paste them).
- "Break *Plan the launch* into smaller steps."
- "Move everything about the Berlin trip to Travel."
- "Mark the first two as done and set the third for Friday at 2 pm."
- "What have I been putting off?"

## Good to know

- **Keep the link private, like a password.** Anyone who has it can see and change your lists. If it got out, click
  **Make a new link** in Saqme: the old one stops working at once. **Disconnect** turns it off completely.
- **Your AI can't delete a list,** and anything it deletes waits in **Recently deleted** for 30 days, where you can
  bring it back (or ask the AI to).
- **It only does what you ask,** and Claude and ChatGPT ask you before they change anything (unless you tell them
  not to).
- **Lists someone else shares with you** can't be reached through the link: change those in Saqme. Claude Desktop
  can change them if you may edit them, and leaves the view-only ones alone.

---

## Advanced

Everything below is for the curious, and for people who set things up themselves.

### How it works

Your sync service (the Cloudflare Worker that syncs your devices) is also an **MCP server**, the kind of "connector"
Claude, ChatGPT and other AI apps take. The link is its address, `https://saqme.<you>.workers.dev/api/mcp/<key>`; the
last part is a key of its own. The assistant talks to it over MCP's Streamable HTTP transport (protocol versions
2024-11-05 to 2025-11-25, stateless, JSON answers); no OAuth, no headers.

It has these tools. Their descriptions tell the model the statuses, the deadline format and how ids work, so it needs
no instructions from you.

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

There is no tool that deletes a list, and none that renames, reorders or shares one.

**How its changes travel.** The tools write through the same path as your devices' sync (the merge rules of
[sync.md](sync.md), as the device `ai-connector`). Your phone and computers get the changes with their next sync, ids
and all: on a computer the task appears in the list's markdown file with its `^id`, and reminders work for its
deadlines. If you edit the same task on a device at the same moment, the newer edit wins and the other is kept under
**Conflicts**, as between two of your devices.

**Shared lists.** Lists shared with you by someone else live on *their* sync service, so the connector cannot reach
them: `get_lists` names the ones your phone app joined, and tells the model to send you to the app. Lists *you* share
are yours: the connector edits them like any other list, and the people you share them with get the changes through
their sync (a task moved out of the list leaves their copy).

### Security: the link is a key

- Whoever has the link can read and change your lists (not delete a list; deletes stay restorable). Claude and
  ChatGPT keep it in your account's connector settings.
- **Make a new link** (`POST /api/connector/rotate`) replaces it; the old link stops working at once. **Disconnect**
  (`POST /api/connector/disconnect`) turns it off until **Connect your AI** makes a new one.
- It is **not your sync key**, and the sync key cannot be worked out from it. The connector key is
  HMAC-SHA-256(sync key, a random nonce the Worker keeps in D1, table `connector`). D1 holds neither the key nor a
  digest of it; any app with the sync key can show the link again (`GET /api/connector`). A new sync key (setup's
  `-RotateToken`) therefore changes the link too.
- The endpoint accepts nothing else: not your sync key, not the key of a list someone shares with you, no
  `Authorization` header at all. A wrong link costs the Worker one database read, writes nothing, and is answered
  404 (not 401, which would send clients looking for an OAuth sign-in that does not exist).

**Why a link and not a sign-in?** Claude's and ChatGPT's custom connectors take a server with OAuth or with no
authentication. OAuth would add a consent page, client registration and token storage to every Worker, and you would
approve it with a secret only your apps know anyway: a click more, no protection more. A long random link (a
*capability URL*) is the simplest thing that is just as strong, and it can be replaced or turned off any time. If an
AI app you want requires OAuth, it can be added on the same Worker later.

### Limits

- At most **25 deleted tasks an hour** (subtasks count). More is refused with a message that sends you to the app:
  the same care the apps take when many tasks vanish from the lists folder at once (*Deletions paused*,
  [sync.md](sync.md)). A task with more than 25 subtasks is left to the app altogether.
- At most **120 calls a minute**, 50 new tasks per call, 200 tasks per answer (the model narrows its filter when there
  are more). That keeps the Worker well inside Cloudflare's free plan.
- **Text in your lists is text, not orders.** If an assistant also reads web pages or mail, a note copied from there
  could tell it to do something; its instructions say to treat list text as data, but check what it did.

### Set up before this version?

Nothing to do: every sync service gets the connector with its next update (the Worker updates its own database), and
Settings › Use with AI shows the link. One that runs an older version says *Not yet* there until it is updated.

Code: `worker/src/connector.js` (the link and its key), `worker/src/mcp.js` (the MCP server and its tools); see also
[architecture.md](architecture.md#worker-and-d1). A local MCP server for people without sync would be possible later;
until then, use the files (below).

---

## Other ways

### Let an AI app on your computer edit your list files

Saqme keeps every list as a plain markdown file ([the format](file-format.md)). An AI app that can open files on your
computer can therefore read them, answer questions about your tasks and change them, and Saqme picks every change up
within a few seconds and syncs it like one you made yourself. This works **without sync**, offline, and with local
agents (Claude Code, Codex, Cursor). There is nothing to install on the Saqme side.

The AI has to be told where the lists are and how the lines look. Saqme writes that down for you:

**Windows:** Settings › Use with AI › Other ways › **Copy instructions for your AI**.
**Linux and macOS:** the same row in the app window, or `saqme ai-prompt` in a terminal (it prints the text, so
`saqme ai-prompt | wl-copy`, `| pbcopy` or `> SAQME.md` work too).

The text names **this computer's** lists folder, so it is right for your user name, a folder with spaces or
Georgian letters in its name, or a portable copy. It then explains:

- the format: `[ ]` `[/]` `[x]` `[>]` `[!]` `[-]` `[~]`, two-space subtasks, ` due:YYYY-MM-DD` with an optional
  `THH:MM`, notes as `> ` lines one level deeper, the ` ^xxxxxxxx` ids, one file per list, the order in `.order`;
- that it should edit the files directly (the app picks the changes up and syncs them);
- the rules: never delete a list file, never rewrite a whole file from memory, keep the ids, move a task with its
  whole block, leave the app's dot files alone, ask when unsure.

Paste it as the first message of a chat, or keep it with the assistant for good: **Save them as a file…** (the row
below it; the Linux and macOS window downloads it) writes it as `SAQME.md`. Keep that file **outside the lists
folder**: any `.md` file there is a list (the Windows app refuses to save it there). The instructions are the same for
every assistant, so a copy saved once stays right until you move the lists folder.

#### Per app

The assistant needs two things: access to the lists folder, and the instructions. Which products can open a folder
changes often; what is below is the shape of each, not a promise about a version.

**Claude Code.** Start it in a folder of your own and let it reach the lists:

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

**Cursor and Codex.** Both work in a folder, and both read an `AGENTS.md`. Make a folder of your own (say `Saqme AI`),
save the instructions in it as `AGENTS.md`, and give the tool the lists folder too: in Codex `--add-dir <lists
folder>`, in Cursor *File > Add Folder to Workspace*.

Don't open the whole data folder (`%APPDATA%\SaqmeToDo`, `~/.local/share/saqme`): next to `lists` it holds your sync
key (`sync/config.json`), and an assistant should not see that.

**Claude Desktop:** use [Connect Claude Desktop](#connect-claude-desktop): one click, no Node.js, Saqme's rules built
in. What follows is for **any other MCP filesystem server**, or for doing it by hand. The filesystem server limited
to the lists folder is enough: in **Settings > Developer > Edit Config** add it to `claude_desktop_config.json` (the
path is the one the app showed you; on Windows double the backslashes; Connect Claude Desktop later replaces an entry
named `saqme`):

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

Restart Claude Desktop (it needs Node.js for `npx`). On Windows, if Claude Desktop is the Microsoft Store version, a
server it starts this way sees its private copy of AppData (see the last point below): Connect Claude Desktop is the
safe way there. Then put the instructions where Claude always sees them: a
**Project**'s instructions (paste) or its knowledge (add `SAQME.md`). Any other MCP filesystem server works the same
way: point it at the lists folder only, and give the model the instructions as a system prompt.

**ChatGPT without sync.** The ChatGPT desktop app does not open an arbitrary folder the way an agent does. Paste the
instructions, attach the list file you mean (**Open the lists folder** in Settings › Your lists shows where it is)
and paste the answer back into the file. It works, but by hand: with sync, [connecting ChatGPT](#connect-chatgpt) is
the better fit.

#### What it can't do, and what it shouldn't

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
- **It doesn't know today's date unless the chat does.** "This week" needs a date; most assistants have one.
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
  the last sync, and Settings › Your lists offers to bring back what such a copy has and your folder lacks. The
  instructions above tell the assistant to edit files in place and never to start Saqme, its updater or its setup. If its
  edits never show up in Saqme, ask it to list the lists folder and compare with **Open the lists folder**; an assistant
  that runs as a normal program, or an MCP server started by one, is not affected (an MCP server started by the Store
  version of Claude Desktop is). Connecting by link has none of this (it never touches files), and **Connect Claude
  Desktop** does its work outside the copy ([how](#connect-claude-desktop-how-it-works)).
