// server.js — backend for the site
// Handles: username/password accounts, sessions, and the API the frontend
// calls. Messaging/calls/posts routes get added later under the same
// requireAuth pattern used below.

const path = require("path");
const express = require("express");
const session = require("express-session");
const bcrypt = require("bcrypt");
const Database = require("better-sqlite3");

const PORT = process.env.PORT || 3000;
const SESSION_SECRET = process.env.SESSION_SECRET || "change-this-in-production";

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ---- Database -------------------------------------------------------------
// SQLite file lives next to this script. On some hosts (see README) the
// filesystem is wiped on redeploy, so read the hosting notes before you rely
// on this in production.
const db = new Database(path.join(__dirname, "data.db"));
db.pragma("journal_mode = WAL");
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

// ---- Sessions ---------------------------------------------------------------
app.use(
  session({
    name: "sid",
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      // secure:true requires HTTPS — turn on once you deploy behind TLS.
      secure: process.env.NODE_ENV === "production",
      maxAge: 1000 * 60 * 60 * 24 * 30, // 30 days
    },
  })
);

// ---- Validation helpers -----------------------------------------------------
const USERNAME_RE = /^[a-zA-Z0-9_]{3,20}$/;

function validateCredentials(username, password) {
  if (typeof username !== "string" || typeof password !== "string") {
    return "Username and password are required.";
  }
  if (!USERNAME_RE.test(username)) {
    return "Username must be 3-20 characters: letters, numbers, underscore.";
  }
  if (password.length < 8) {
    return "Password must be at least 8 characters.";
  }
  return null;
}

// ---- Auth routes ------------------------------------------------------------
app.post("/api/register", async (req, res) => {
  const { username, password } = req.body || {};
  const error = validateCredentials(username, password);
  if (error) return res.status(400).json({ error });

  const existing = db.prepare("SELECT id FROM users WHERE username = ?").get(username);
  if (existing) return res.status(409).json({ error: "That username is taken." });

  const password_hash = await bcrypt.hash(password, 12);
  const info = db
    .prepare("INSERT INTO users (username, password_hash) VALUES (?, ?)")
    .run(username, password_hash);

  req.session.userId = info.lastInsertRowid;
  req.session.username = username;
  res.json({ ok: true, username });
});

app.post("/api/login", async (req, res) => {
  const { username, password } = req.body || {};
  if (typeof username !== "string" || typeof password !== "string") {
    return res.status(400).json({ error: "Username and password are required." });
  }

  const user = db.prepare("SELECT * FROM users WHERE username = ?").get(username);
  if (!user) return res.status(401).json({ error: "Invalid username or password." });

  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) return res.status(401).json({ error: "Invalid username or password." });

  req.session.userId = user.id;
  req.session.username = user.username;
  res.json({ ok: true, username: user.username });
});

app.post("/api/logout", (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get("/api/me", (req, res) => {
  if (req.session.userId) {
    res.json({ loggedIn: true, username: req.session.username });
  } else {
    res.json({ loggedIn: false });
  }
});

// ---- Auth guard for future protected routes --------------------------------
function requireAuth(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: "Not logged in." });
  next();
}

// Example of how future features get bolted on:
// app.get("/api/messages", requireAuth, (req, res) => { ... });

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
