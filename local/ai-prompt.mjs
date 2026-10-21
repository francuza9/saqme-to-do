// "Use with AI": the instructions an AI assistant needs to manage the lists folder, with this computer's real
// path filled in. Shown by Settings > Your lists > Use with AI (copy, save as a file) and `saqme ai-prompt`.
// The Windows app has the same text in desktop/rules.ps1 (Get-AiPrompt); shared/fixtures/ai-prompt.json holds
// the expected output for both, so change the wording in both places and in the fixture's .md files.

/** @param {string} listsDir the lists folder as the assistant should open it */
export function aiPrompt(listsDir) {
  return `# My to-do lists (Saqme To Do)

My tasks are plain markdown files, one file per list, in this folder:

\`\`\`
${listsDir}
\`\`\`

A file's name is the list's name (\`Work.md\` is the list "Work"). The Saqme To Do app watches the folder: when you change a file it picks the change up within a few seconds and syncs it to my other devices. So read and edit the files directly; there is nothing else to call.

## Format

A task is one line, \`- [S] text\`, where S is its status:

- \`[ ]\` to do, \`[/]\` in progress, \`[!]\` blocked or waiting
- \`[>]\` postponed
- \`[x]\` done, \`[-]\` failed or rejected, \`[~]\` abandoned

- Subtasks are indented two spaces per level under their parent.
- A deadline ends the text: \` due:YYYY-MM-DD\`, with an optional time, \` due:YYYY-MM-DDTHH:MM\` (24-hour, local time).
- A task's notes are lines starting with \`> \`, right below it and indented one level deeper than the task.
- The id is \` ^xxxxxxxx\` (8 to 32 lowercase letters and digits) at the very end of the line. Sync follows a task by it, so keep it exactly as it is. A new task needs no id: the app adds one.
- Tasks are in the order of their lines. The order of the lists is in \`.order\` (one list name per line); a list that is not in it comes after the others.
- Everything else in a file (the \`# Title\`, other headings, paragraphs, blank lines) is mine: leave it where it is.

Example, \`Work.md\`:

\`\`\`markdown
# Work
- [/] Ship the roadmap due:2026-10-25T14:00 ^k3j9x2ab
  > Draft: https://docs.example.com/roadmap
  - [x] Collect feedback ^p0q1r2s3
  - [ ] Review numbers with finance ^t4u5v6w7
- [>] Clean up the old dashboards ^e2f3g4h5
\`\`\`

## Rules for you

- Never delete, rename or empty a list file. To finish a task, change its mark to \`[x]\`; remove a task's line (with its subtasks and notes) only when I ask.
- Never rewrite a whole file from memory. Read it first and change only the lines you mean to: the app or I may have changed it since you last looked.
- Keep every \`^id\` as it is. To move a task to another list, move its whole block (the line, subtasks and notes) with its ids: add it to the other file and remove it from the first.
- A new list is a new file, \`Name.md\`, starting with \`# Name\`. The name can't contain \`\\ / : * ? " < > |\`.
- Leave the files whose names start with a dot alone, except \`.order\`: they belong to the app.
- Files are UTF-8 and keep their line endings.
- If it is unclear which list or task I mean, ask before you change anything.
`;
}
