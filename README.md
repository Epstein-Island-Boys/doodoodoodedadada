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

## Files
- server.js — Express app, SQLite user table, session-based auth API
- public/index.html + style.css + reveal.js — the decoy + secret toggle
- public/login.html, register.html, dashboard.html — auth pages
- public/auth.js — shared fetch helpers
