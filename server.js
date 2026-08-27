// server.js — backend for the site
// Handles: username/password accounts, sessions, and the API the frontend
// calls. Messaging/calls/posts routes get added later under the same
// requireAuth pattern used below.

const path = require("path");
const crypto = require("crypto");
const http = require("http");
const express = require("express");
const session = require("express-session");
const bcrypt = require("bcrypt");
const multer = require("multer");
const { Server } = require("socket.io");
const { createClient } = require("@libsql/client");

const PORT = process.env.PORT || 3000;
const SESSION_SECRET = process.env.SESSION_SECRET || "change-this-in-production";

// ---- Database (Turso / libSQL) ---------------------------------------------
// This used to be a local SQLite file, which is why data disappeared on every
// redeploy: most hosts (Render, Railway, Fly, Replit, etc.) give your app a
// fresh, empty filesystem on every restart unless you attach a persistent
// volume. Turso stores the database on its own servers instead, so it
// survives redeploys/restarts no matter what host you use.
//
// Locally (no TURSO_DATABASE_URL set) this falls back to a plain SQLite file
// on disk, so you can still develop without a Turso account. In production,
// set TURSO_DATABASE_URL and TURSO_AUTH_TOKEN as env vars on your host and it
// will use Turso automatically.
const TURSO_URL = process.env.TURSO_DATABASE_URL || `file:${path.join(__dirname, "data.db")}`;
const TURSO_AUTH_TOKEN = process.env.TURSO_AUTH_TOKEN; // not needed for local file mode

const db = createClient({
  url: TURSO_URL,
  authToken: TURSO_AUTH_TOKEN,
});

async function initDb() {
  await db.execute(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  await db.execute(`
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
  const cols = await db.execute("PRAGMA table_info(messages)");
  const messageColumns = cols.rows.map((c) => c.name);
  if (!messageColumns.includes("type")) {
    await db.execute("ALTER TABLE messages ADD COLUMN type TEXT NOT NULL DEFAULT 'text'");
  }
  await db.execute("CREATE INDEX IF NOT EXISTS idx_messages_pair ON messages (sender_id, recipient_id)");

  // Images now live in Turso too (as blobs), instead of the local /uploads
  // folder, which had the same disappears-on-redeploy problem as the old
  // sqlite file did.
  await db.execute(`
    CREATE TABLE IF NOT EXISTS images (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      mime_type TEXT NOT NULL,
      data BLOB NOT NULL,
      uploaded_by INTEGER NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
}

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
// Images are received in memory and written straight into Turso as a BLOB
// row, then served back out from /api/images/:id. Nothing is written to the
// local disk, so there's no folder to lose on redeploy.
const ALLOWED_IMAGE_TYPES = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
  fileFilter: (req, file, cb) => {
    if (!ALLOWED_IMAGE_TYPES[file.mimetype]) {
      return cb(new Error("Only PNG, JPEG, GIF, and WEBP images are allowed."));
    }
    cb(null, true);
  },
});

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

// Small helper: libSQL returns lastInsertRowid as a BigInt. Our ids never get
// anywhere near large enough for that to matter, so convert to a plain
// Number for convenience everywhere else in this file.
function insertedId(result) {
  return Number(result.lastInsertRowid);
}

// ---- Auth routes ------------------------------------------------------------
app.post("/api/register", async (req, res) => {
  const { username, password } = req.body || {};
  const error = validateCredentials(username, password);
  if (error) return res.status(400).json({ error });

  const existing = await db.execute({
    sql: "SELECT id FROM users WHERE username = ?",
    args: [username],
  });
  if (existing.rows.length) return res.status(409).json({ error: "That username is taken." });

  const password_hash = await bcrypt.hash(password, 12);
  const info = await db.execute({
    sql: "INSERT INTO users (username, password_hash) VALUES (?, ?)",
    args: [username, password_hash],
  });

  req.session.userId = insertedId(info);
  req.session.username = username;
  res.json({ ok: true, username });
});

app.post("/api/login", async (req, res) => {
  const { username, password } = req.body || {};
  if (typeof username !== "string" || typeof password !== "string") {
    return res.status(400).json({ error: "Username and password are required." });
  }

  const result = await db.execute({
    sql: "SELECT * FROM users WHERE username = ?",
    args: [username],
  });
  const user = result.rows[0];
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
app.get("/api/users/:username", requireAuth, async (req, res) => {
  const result = await db.execute({
    sql: "SELECT username FROM users WHERE username = ?",
    args: [req.params.username],
  });
  const user = result.rows[0];
  if (!user) return res.status(404).json({ error: "No user with that username." });
  res.json({ username: user.username });
});

// ---- Conversations ----------------------------------------------------------
// One row per person you've exchanged messages with, most recent first.
app.get("/api/conversations", requireAuth, async (req, res) => {
  const myId = req.session.userId;
  const result = await db.execute({
    sql: `SELECT
         CASE WHEN m.sender_id = ? THEN ru.username ELSE su.username END AS username,
         m.body,
         m.type,
         m.created_at
       FROM messages m
       JOIN users su ON su.id = m.sender_id
       JOIN users ru ON ru.id = m.recipient_id
       WHERE m.sender_id = ? OR m.recipient_id = ?
       ORDER BY m.created_at DESC`,
    args: [myId, myId, myId],
  });

  const seen = new Set();
  const conversations = [];
  for (const row of result.rows) {
    if (seen.has(row.username)) continue;
    seen.add(row.username);
    conversations.push(row);
  }
  res.json({ conversations });
});

// ---- Message history with one person ----------------------------------------
app.get("/api/messages/:username", requireAuth, async (req, res) => {
  const myId = req.session.userId;
  const otherResult = await db.execute({
    sql: "SELECT id, username FROM users WHERE username = ?",
    args: [req.params.username],
  });
  const other = otherResult.rows[0];
  if (!other) return res.status(404).json({ error: "No user with that username." });

  const result = await db.execute({
    sql: `SELECT sender_id, body, type, created_at FROM messages
       WHERE (sender_id = ? AND recipient_id = ?)
          OR (sender_id = ? AND recipient_id = ?)
       ORDER BY created_at ASC`,
    args: [myId, other.id, other.id, myId],
  });

  const messages = result.rows.map((r) => ({
    body: r.body,
    type: r.type,
    created_at: r.created_at,
    mine: r.sender_id === myId,
  }));
  res.json({ messages });
});

// ---- Send a message ----------------------------------------------------------
app.post("/api/messages", requireAuth, async (req, res) => {
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

  const recipientResult = await db.execute({
    sql: "SELECT id, username FROM users WHERE username = ?",
    args: [to],
  });
  const recipient = recipientResult.rows[0];
  if (!recipient) return res.status(404).json({ error: "No user with that username." });

  const trimmedBody = body.trim();
  const info = await db.execute({
    sql: "INSERT INTO messages (sender_id, recipient_id, body) VALUES (?, ?, ?)",
    args: [myId, recipient.id, trimmedBody],
  });
  const createdResult = await db.execute({
    sql: "SELECT created_at FROM messages WHERE id = ?",
    args: [insertedId(info)],
  });
  const created_at = createdResult.rows[0].created_at;

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
// The file is held in memory only long enough to write it into Turso as a
// BLOB row — it's never touched down to local disk.
app.post("/api/messages/image", requireAuth, (req, res) => {
  upload.single("image")(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message || "Upload failed." });
    if (!req.file) return res.status(400).json({ error: "No image provided." });

    try {
      const myId = req.session.userId;
      const to = (req.body && req.body.to) || "";
      if (to === req.session.username) {
        return res.status(400).json({ error: "You can't message yourself." });
      }

      const recipientResult = await db.execute({
        sql: "SELECT id, username FROM users WHERE username = ?",
        args: [to],
      });
      const recipient = recipientResult.rows[0];
      if (!recipient) return res.status(404).json({ error: "No user with that username." });

      const imageInfo = await db.execute({
        sql: "INSERT INTO images (mime_type, data, uploaded_by) VALUES (?, ?, ?)",
        args: [req.file.mimetype, req.file.buffer, myId],
      });
      const url = "/api/images/" + insertedId(imageInfo);

      const info = await db.execute({
        sql: "INSERT INTO messages (sender_id, recipient_id, body, type) VALUES (?, ?, ?, 'image')",
        args: [myId, recipient.id, url],
      });
      const createdResult = await db.execute({
        sql: "SELECT created_at FROM messages WHERE id = ?",
        args: [insertedId(info)],
      });
      const created_at = createdResult.rows[0].created_at;

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
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: "Upload failed." });
    }
  });
});

// ---- Serve an image back out of Turso ----------------------------------------
// Images aren't behind requireAuth: the frontend renders them via a plain
// <img src="..."> tag, which can't send session-aware fetch headers. The id
// is a random-order autoincrement integer, not guessable in practice, but if
// you want this locked down further, swap it for a random token column.
app.get("/api/images/:id", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(404).end();

  const result = await db.execute({
    sql: "SELECT mime_type, data FROM images WHERE id = ?",
    args: [id],
  });
  const row = result.rows[0];
  if (!row) return res.status(404).end();

  res.set("Content-Type", row.mime_type);
  res.set("Cache-Control", "private, max-age=31536000, immutable");
  res.send(Buffer.from(row.data));
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

initDb()
  .then(() => {
    server.listen(PORT, () => {
      console.log(`Server running at http://localhost:${PORT}`);
    });
  })
  .catch((err) => {
    console.error("Failed to initialize database:", err);
    process.exit(1);
  });
