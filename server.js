// server.js — backend for the site
// Handles: username/password accounts, sessions, and the API the frontend
// calls. Messaging/calls/posts routes get added later under the same
// requireAuth pattern used below.

const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const http = require("http");
const express = require("express");
const session = require("express-session");
const bcrypt = require("bcrypt");
const Database = require("better-sqlite3");
const multer = require("multer");
const { Server } = require("socket.io");

const PORT = process.env.PORT || 3000;
const SESSION_SECRET = process.env.SESSION_SECRET || "change-this-in-production";

const app = express();
// Most hosts (Render, Railway, Fly, Heroku, etc.) terminate HTTPS at a proxy
// in front of the app and forward plain HTTP to us. Without this, Express
// thinks every request is insecure, so the `secure: true` cookie below never
// actually gets set once NODE_ENV=production — and you get logged in but
// immediately bounced back to the login screen because no session cookie
// ever reaches the browser. This line tells Express to trust the proxy's
// X-Forwarded-Proto header instead.
app.set("trust proxy", 1);
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ---- Image uploads ----------------------------------------------------------
// Sent images are saved to disk (not stored as base64 in SQLite) and served
// back out from here. Same filesystem caveat as the database applies: on
// hosts that wipe the disk on redeploy, uploaded images won't survive it.
const UPLOADS_DIR = path.join(__dirname, "uploads");
fs.mkdirSync(UPLOADS_DIR, { recursive: true });
app.use("/uploads", express.static(UPLOADS_DIR));

const ALLOWED_IMAGE_TYPES = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
};

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOADS_DIR),
    filename: (req, file, cb) => {
      const ext = ALLOWED_IMAGE_TYPES[file.mimetype] || "";
      cb(null, crypto.randomBytes(16).toString("hex") + ext);
    },
  }),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
  fileFilter: (req, file, cb) => {
    if (!ALLOWED_IMAGE_TYPES[file.mimetype]) {
      return cb(new Error("Only PNG, JPEG, GIF, and WEBP images are allowed."));
    }
    cb(null, true);
  },
});

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

db.exec(`
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sender_id INTEGER NOT NULL REFERENCES users(id),
    recipient_id INTEGER NOT NULL REFERENCES users(id),
    body TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'text',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);
// Migration for databases created before the `type` column existed —
// CREATE TABLE IF NOT EXISTS above won't add it to an already-existing table.
const messageColumns = db.prepare("PRAGMA table_info(messages)").all().map((c) => c.name);
if (!messageColumns.includes("type")) {
  db.exec("ALTER TABLE messages ADD COLUMN type TEXT NOT NULL DEFAULT 'text'");
}
db.exec(`CREATE INDEX IF NOT EXISTS idx_messages_pair ON messages (sender_id, recipient_id)`);

// ---- Sessions ---------------------------------------------------------------
// Kept in its own variable so the same middleware instance can also run
// on socket.io connections below — that's what lets a socket see who's
// logged in without a separate login step.
const sessionMiddleware = session({
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
});
app.use(sessionMiddleware);

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

// ---- User lookup ------------------------------------------------------------
// Lets the "type a username to start a message" box confirm the person
// exists before opening a thread for them.
app.get("/api/users/:username", requireAuth, (req, res) => {
  const user = db
    .prepare("SELECT username FROM users WHERE username = ?")
    .get(req.params.username);
  if (!user) return res.status(404).json({ error: "No user with that username." });
  res.json({ username: user.username });
});

// ---- Conversations ----------------------------------------------------------
// One row per person you've exchanged messages with, most recent first.
app.get("/api/conversations", requireAuth, (req, res) => {
  const myId = req.session.userId;
  const rows = db
    .prepare(
      `SELECT
         CASE WHEN m.sender_id = ? THEN ru.username ELSE su.username END AS username,
         m.body,
         m.type,
         m.created_at
       FROM messages m
       JOIN users su ON su.id = m.sender_id
       JOIN users ru ON ru.id = m.recipient_id
       WHERE m.sender_id = ? OR m.recipient_id = ?
       ORDER BY m.created_at DESC`
    )
    .all(myId, myId, myId);

  const seen = new Set();
  const conversations = [];
  for (const row of rows) {
    if (seen.has(row.username)) continue;
    seen.add(row.username);
    conversations.push(row);
  }
  res.json({ conversations });
});

// ---- Message history with one person ----------------------------------------
app.get("/api/messages/:username", requireAuth, (req, res) => {
  const myId = req.session.userId;
  const other = db
    .prepare("SELECT id, username FROM users WHERE username = ?")
    .get(req.params.username);
  if (!other) return res.status(404).json({ error: "No user with that username." });

  const rows = db
    .prepare(
      `SELECT sender_id, body, type, created_at FROM messages
       WHERE (sender_id = ? AND recipient_id = ?)
          OR (sender_id = ? AND recipient_id = ?)
       ORDER BY created_at ASC`
    )
    .all(myId, other.id, other.id, myId);

  const messages = rows.map((r) => ({
    body: r.body,
    type: r.type,
    created_at: r.created_at,
    mine: r.sender_id === myId,
  }));
  res.json({ messages });
});

// ---- Send a message ----------------------------------------------------------
app.post("/api/messages", requireAuth, (req, res) => {
  const myId = req.session.userId;
  const { to, body } = req.body || {};

  if (typeof to !== "string" || typeof body !== "string" || !body.trim()) {
    return res.status(400).json({ error: "A recipient and message body are required." });
  }
  if (body.length > 2000) {
    return res.status(400).json({ error: "Messages are limited to 2000 characters." });
  }
  if (to === req.session.username) {
    return res.status(400).json({ error: "You can't message yourself." });
  }

  const recipient = db.prepare("SELECT id, username FROM users WHERE username = ?").get(to);
  if (!recipient) return res.status(404).json({ error: "No user with that username." });

  const trimmedBody = body.trim();
  const info = db
    .prepare("INSERT INTO messages (sender_id, recipient_id, body) VALUES (?, ?, ?)")
    .run(myId, recipient.id, trimmedBody);
  const created_at = db
    .prepare("SELECT created_at FROM messages WHERE id = ?")
    .get(info.lastInsertRowid).created_at;

  // Push it to the recipient in real time if they're online right now.
  const payload = {
    from: req.session.username,
    to: recipient.username,
    body: trimmedBody,
    type: "text",
    created_at,
  };
  for (const socketId of onlineSockets.get(recipient.id) || []) {
    io.to(socketId).emit("message", payload);
  }

  res.json({ ok: true, message: payload });
});

// ---- Send an image message ---------------------------------------------------
// Multipart upload: form fields `to` (recipient username) and `image` (file).
// requireAuth runs first so an unauthenticated request never reaches multer.
app.post("/api/messages/image", requireAuth, (req, res) => {
  upload.single("image")(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message || "Upload failed." });
    if (!req.file) return res.status(400).json({ error: "No image provided." });

    const cleanup = () => fs.unlink(req.file.path, () => {});

    const myId = req.session.userId;
    const to = (req.body && req.body.to) || "";
    if (to === req.session.username) {
      cleanup();
      return res.status(400).json({ error: "You can't message yourself." });
    }

    const recipient = db.prepare("SELECT id, username FROM users WHERE username = ?").get(to);
    if (!recipient) {
      cleanup();
      return res.status(404).json({ error: "No user with that username." });
    }

    const url = "/uploads/" + req.file.filename;
    const info = db
      .prepare("INSERT INTO messages (sender_id, recipient_id, body, type) VALUES (?, ?, ?, 'image')")
      .run(myId, recipient.id, url);
    const created_at = db
      .prepare("SELECT created_at FROM messages WHERE id = ?")
      .get(info.lastInsertRowid).created_at;

    const payload = {
      from: req.session.username,
      to: recipient.username,
      body: url,
      type: "image",
      created_at,
    };
    for (const socketId of onlineSockets.get(recipient.id) || []) {
      io.to(socketId).emit("message", payload);
    }

    res.json({ ok: true, message: payload });
  });
});

const server = http.createServer(app);
const io = new Server(server);

// Run the same session parsing socket.io connections go through so a
// socket knows who's logged in — no separate login step for sockets.
io.engine.use(sessionMiddleware);

// userId -> Set of live socket ids, so someone logged in on two tabs/
// devices gets the message pushed to both.
const onlineSockets = new Map();

io.on("connection", (socket) => {
  const session = socket.request.session;
  if (!session || !session.userId) {
    socket.disconnect(true);
    return;
  }
  const userId = session.userId;
  if (!onlineSockets.has(userId)) onlineSockets.set(userId, new Set());
  onlineSockets.get(userId).add(socket.id);

  socket.on("disconnect", () => {
    onlineSockets.get(userId)?.delete(socket.id);
    if (onlineSockets.get(userId)?.size === 0) onlineSockets.delete(userId);
  });
});

server.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
