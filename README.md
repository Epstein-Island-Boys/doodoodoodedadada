# Heartwood — starter project

## Run it locally
```
npm install
node server.js
```
Then open http://localhost:3000

## Find the door
The homepage is a small tree-anatomy page. Click the "Heartwood" label in
the diagram. That sets a cookie and reveals the real front door (login /
register). Click "Hide this again" to reset it.

## What's real vs. cosmetic
- The `unlocked` cookie set by reveal.js is just a UI gate — anyone could
  set it by hand in devtools. It is NOT how accounts are protected.
- Real auth is the `sid` session cookie set by the server after a
  successful /api/login or /api/register. It's marked httpOnly so page
  JavaScript can't read or forge it, and it's what any future
  `requireAuth`-protected route (messages, calls, posts) will check.

## Messaging
After logging in you land on `/messages.html`. Type a username in the
"Message a username…" box and hit Start to open a thread with them (you'll
get an error if that username doesn't exist). Type in the composer at the
bottom and hit Send. If the other person is online, the message shows up
in their chat instantly over a websocket — no refresh needed. If they're
offline, it's still saved and waiting for them the next time they open
that conversation.

## Files
- server.js — Express app, SQLite tables (users + messages), session-based
  auth API, and the Socket.io wiring for live delivery
- public/index.html + style.css + reveal.js — the decoy + secret toggle
- public/login.html, register.html — auth pages
- public/messages.html + messages.js — the messaging GUI
- public/auth.js — shared fetch helpers
