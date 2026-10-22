# Using Saqme with an AI assistant

Saqme keeps every list as a plain markdown file ([the format](file-format.md)). An AI assistant that can open
files on your computer can therefore read them, answer questions about your tasks and change them, and the app
picks every change up within a few seconds and syncs it like one you made yourself. There is nothing to install
on the Saqme side: no plugin, no API key.

What stops this from being one step is that the assistant has to be told where the lists are and how the lines
look. Saqme writes that down for you.

## The one step

**Windows:** Settings > Your lists > **Copy instructions for your AI**.
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

## Things to ask

- "What's due this week?" / "What is overdue?"
- "Move everything about the Berlin trip to Travel."
- "Add these meeting notes as tasks" (paste them), "break *Plan the launch* into subtasks".
- "Tell me what I've been postponing", "which list has the most open tasks?"
- "Mark the first two as done and put a deadline of Friday 14:00 on the third."

## Per assistant

The assistant needs two things: access to the lists folder, and the instructions. Which products can open a
folder changes often; what is below is the shape of each, not a promise about a version.

### Claude Desktop and Claude Projects

Claude Desktop reaches your files through an MCP server. The filesystem server limited to the lists folder is
enough: in **Settings > Developer > Edit Config** add it to `claude_desktop_config.json` (the path is the one
the app showed you; on Windows double the backslashes):

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
your lists.

### Claude Code

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

### ChatGPT

The ChatGPT desktop app can work with some apps and attached files, but it does not open an arbitrary folder
the way an agent does. If yours can't, paste the instructions, attach the list file you mean (the app's
**Open the lists folder** row shows where it is) and paste the answer back into the file. It works, but by hand,
so for edits an agent that works in the folder (Codex, below) is the better fit.

### Cursor and Codex

Both work in a folder, and both read an `AGENTS.md`. Make a folder of your own (say `Saqme AI`), save the
instructions in it as `AGENTS.md`, and give the tool the lists folder too: in Codex `--add-dir <lists folder>`,
in Cursor *File > Add Folder to Workspace*.

Don't open the whole data folder (`%APPDATA%\SaqmeToDo`, `~/.local/share/saqme`): next to `lists` it holds your sync
key (`sync/config.json`), and an assistant should not see that.

### Any MCP filesystem server

Point it at the lists folder only (as in the Claude Desktop example) and give the model the instructions as a
system prompt or project instruction.

## What it can't do, and what it shouldn't

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
  the last sync, and Settings > Your lists offers to bring back what such a copy has and your folder lacks. The
  instructions above tell the assistant to edit files in place and never to start Saqme, its updater or its setup. If its
  edits never show up in Saqme, ask it to list the lists folder and compare with **Open the lists folder**; an assistant
  that runs as a normal program, or an MCP server started by one, is not affected.
