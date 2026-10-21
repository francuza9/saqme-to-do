// The page an invite link opens: https://<owner's sync server>/join#code=<one-time code> (worker/src/shares.js);
// "Move to my Saqme app" makes the same kind of link. It only offers the ways in; the code is used up by the app
// that joins:
//   - this server's own copy of the app, in the browser: /#join=<code> (nothing to install, no sync of one's own)
//   - the installed app (setup registers saqme: links on Windows, macOS and Linux): saqme://join?server=<this
//     origin>&code=... (tried right away in Chromium browsers on computers: where nothing is registered, nothing
//     happens)
//   - copying the invite, to paste into the app: an app on an iPhone's Home Screen can't be opened by a link
//   - installing Saqme (the one-line installers)
// The code stays after the '#': browsers never send that part to a server.
import { parseInviteLink } from './pairing.js';

const $ = (id) => document.getElementById(id);
const invite = `${location.origin}/join${location.hash}`;
const inv = parseInviteLink(invite);

if (!inv) {
  $('what').textContent = 'This invite link is incomplete. Copy the whole link from the message you got, including the part after #code=.';
  $('note').hidden = true;
} else {
  const app = `saqme://join?server=${encodeURIComponent(inv.server)}&code=${inv.code}`;
  $('openApp').href = app;
  $('openBrowser').href = `${inv.server}/#join=${inv.code}`;
  $('ways').hidden = false;
  $('copy').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(invite); $('status').textContent = 'Invite copied. Paste it in Saqme: Settings › Sync & sharing › Shared lists.'; } catch { $('status').textContent = invite; }
  });
  const ua = navigator.userAgent;
  const desktop = /Windows NT|Macintosh|Linux x86_64|X11/.test(ua) && !/Android|Mobile|iPad|iPhone/.test(ua) && !(navigator.maxTouchPoints > 1 && /Macintosh/.test(ua));
  const chromium = /Chrome\/|Edg\//.test(ua) && !/Firefox\//.test(ua);
  const key = `saqme.tried.${inv.code.slice(0, 12)}`;
  if (desktop && chromium && !sessionStorage.getItem(key)) {
    sessionStorage.setItem(key, '1');
    location.href = app;   // the browser asks whether to open Saqme To Do, where it is installed
  }
}
