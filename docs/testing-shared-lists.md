# Trying shared lists with a second person

A checklist for testing shared lists by hand ([how they work](sync.md#shared-lists)). The automated suites
cover the rules; this covers real devices, real browsers and real Workers. Tick what works, and note what
does not with the device, the browser and the time.

**Before you start.** Everyone who has sync of their own runs setup's cloud part once after updating
(`setup.cmd -Cloud` on Windows, `scripts/setup.sh --cloud` on Linux/macOS): it adds the new database tables
and deploys the Worker. Use a test list (say *Groceries*) with a few tasks, one with a deadline 20 minutes
from now.

The people (one person can play several roles on different devices):

- **A**, the owner: Saqme with sync.
- **B**: Saqme with sync, on a computer and a phone (paired with B's own sync).
- **C**: no Saqme at all, a phone browser (iPhone Safari and/or Android Chrome).
- **D**: Saqme on a computer **without** sync (local only).

## 1. Sharing (A)

- [ ] Without sync, **Share…** in a list's menu is greyed out and says why.
- [ ] With sync: Windows, right-click the tab (also the share icon on the current tab while the mouse is over
      it); phone, Linux, macOS, long-press or right-click the list's name at the top, or the list in the lists
      menu. **Share…**. Name the person, pick *Can edit* (hover both choices: the tooltips say what they mean),
      **Create invite link**: the link is copied, shown, and a QR code on desktop.
- [ ] The person shows as *invited, not joined yet*; the list gets a badge (its tab; its name at the top and in
      the lists menu).
- [ ] Opening the same link a second time, after someone joined, says it was already used.

## 2. Someone with no Saqme (C, phone browser)

- [ ] The invite opens a page with three ways: **Use it now, in this browser**, **You have Saqme To Do**
      (Open in Saqme, Copy invite), **Install Saqme To Do** (both one-line installers, the instructions link).
- [ ] **Use it in this browser** > *Join shared list?* (it says no account and no sync are needed) > **Join**:
      the list appears. A shows C as *joined*.
- [ ] C checks off a task and adds one: A sees both within seconds. A edits one: C sees it.
- [ ] Add the page to the Home Screen and open it from there: the list is still there, also offline.
- [ ] **Settings > Notifications**, switch on (iPhone: in the Home Screen app): **Send a test notification**
      arrives. The deadline in 20 minutes reminds C about 15 minutes before and at the time, by C's clock (try C
      in another time zone than A if you can). The daily summary comes at C's **Daily summary** time and lists only
      tasks of this list. A's own reminders still reach A as before, once.
- [ ] The list's menu (long-press its name at the top) has **Leave this list** and **Move to my Saqme app**, no
      Rename or Delete.

## 3. Moving from the browser into Saqme (C, after installing)

- [ ] Install Saqme with the one-liner from the invite page (no sync needed).
- [ ] In the browser: **Move to my Saqme app** shows a one-time link (and a QR code on a computer). Open it
      in Saqme (**Open in Saqme To Do**, or paste it in Settings > Sync & sharing, under Shared lists).
- [ ] The list appears in the app with C's edits. The browser says it moved to the app and the list is gone
      there. A still sees one person C, not two. C gets reminders only from the app now, not twice.

## 4. Someone with Saqme and sync (B)

- [ ] **Computer:** open the invite: the browser offers to open Saqme To Do (Windows, Linux and macOS); the
      app asks before it joins; the list appears as a file `Groceries.md` (or `Groceries (from <A's
      workers.dev name>).md` when B already has a *Groceries*). Editing that file in an editor reaches A.
- [ ] **Phone (paired with B's sync):** a second invite > **Copy invite** > Saqme > Settings > Sync & sharing >
      Shared lists: Paste, Join. The list appears; a second phone paired with B's sync gets it too, without
      an invite. B's phone reminds B of its deadlines (like B's own tasks, at B's time).
- [ ] A's list never shows up among B's own synced lists: B's other computers get it only by joining too.
- [ ] **Leave** on one phone: gone from all of B's phones, still on B's computer (it has its own key).

## 5. Someone without sync (D, computer)

- [ ] Join from the invite (or `saqme join '<link>'` on Linux/macOS): the list syncs with A, nothing else does.
- [ ] Set up sync on D later: D's own lists upload, the shared one stays out of D's sync and keeps syncing
      with A. Turn D's sync off again (Settings > Sync & sharing > Advanced): the
      shared list keeps syncing.

## 6. Everything at once

- [ ] B shares one of B's own lists with A while A's list is shared with B: both badges show, each side
      sees the other's list, and edits never cross into the wrong list.
- [ ] B joins a list called *Groceries* from A and another *Groceries* from a third person: B sees both,
      named apart, plus B's own *Groceries* if there is one.
- [ ] B unpairs a phone: the shared list says it waits; changes made meanwhile arrive at A after pairing again.

## 7. The owner changes things (A)

- [ ] Rename the list: B's file, tabs and lists menus follow (a name B already has gets "(from …)"); C's
      follows.
- [ ] Move a task to another of A's lists: it disappears for the others, without a trace of where it went.
- [ ] Switch someone to **Can view**: from their next sync the list is read-only for them (the phone says
      *View only*). An edit to the file on a computer goes back, and what was typed shows under Conflicts as
      *Not saved*.
- [ ] **Revoke** someone: their list stays with them as their own list, and the app says so (on B's phones:
      one copy, not one per phone). Delete the list on A: it disappears for everyone; restore it: it comes back.

If something fails, note what the screen said and send the logs: Windows `%APPDATA%\SaqmeToDo\sync\sync.log`,
Linux/macOS `local/saqme.log` in the data folder, a phone: the browser's console if you can open it.
