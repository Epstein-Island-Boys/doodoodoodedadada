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

// Usernames are stored with whatever case the person picked (so their
// profile still shows "John"), but every lookup — login, search, DMing,
// mute/block, replies — goes through this lowercase column instead so
// "John", "john", and "JOHN" are all the same account.
function usernameLower(u) {
  return String(u).toLowerCase();
}

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
  // Read receipts: NULL until the recipient has opened/seen the message.
  if (!messageColumns.includes("read_at")) {
    await db.execute("ALTER TABLE messages ADD COLUMN read_at TEXT");
  }
  // Editing / replying. (Deleting is a real DELETE now — see below — but the
  // `deleted` column is left in place for any databases that still have old
  // soft-deleted rows in them, cleaned up once just after this block.)
  if (!messageColumns.includes("edited_at")) {
    await db.execute("ALTER TABLE messages ADD COLUMN edited_at TEXT");
  }
  if (!messageColumns.includes("deleted")) {
    await db.execute("ALTER TABLE messages ADD COLUMN deleted INTEGER NOT NULL DEFAULT 0");
  }
  if (!messageColumns.includes("reply_to_id")) {
    await db.execute("ALTER TABLE messages ADD COLUMN reply_to_id INTEGER");
  }
  await db.execute("CREATE INDEX IF NOT EXISTS idx_messages_pair ON messages (sender_id, recipient_id)");

  // One shared room every user can post to and see. Kept as its own table
  // (rather than reusing `messages` with a nullable recipient) since a
  // broadcast message has no single recipient and the existing `messages`
  // table's recipient_id is NOT NULL by design.
  await db.execute(`
    CREATE TABLE IF NOT EXISTS global_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sender_id INTEGER NOT NULL REFERENCES users(id),
      body TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'text',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  const globalCols = await db.execute("PRAGMA table_info(global_messages)");
  const globalMessageColumns = globalCols.rows.map((c) => c.name);
  if (!globalMessageColumns.includes("edited_at")) {
    await db.execute("ALTER TABLE global_messages ADD COLUMN edited_at TEXT");
  }
  if (!globalMessageColumns.includes("deleted")) {
    await db.execute("ALTER TABLE global_messages ADD COLUMN deleted INTEGER NOT NULL DEFAULT 0");
  }
  if (!globalMessageColumns.includes("reply_to_id")) {
    await db.execute("ALTER TABLE global_messages ADD COLUMN reply_to_id INTEGER");
  }

  // One-time cleanup: earlier versions of this app "deleted" a message by
  // blanking its body and flagging it, which still left a "Message deleted"
  // stub behind. Deleting now really deletes the row, so sweep out any old
  // stubs left over from that scheme — after this, `deleted` never gets set
  // again and just sits unused for compatibility.
  await db.execute("DELETE FROM messages WHERE deleted = 1");
  await db.execute("DELETE FROM global_messages WHERE deleted = 1");

  // Mutes/blocks: one row per (owner, target) pair. A user can only have one
  // relation toward another at a time — setting 'blocked' over an existing
  // 'muted' row (or vice versa) replaces it, which matches how most chat
  // apps treat block as a stronger version of mute rather than a separate
  // simultaneous state.
  await db.execute(`
    CREATE TABLE IF NOT EXISTS user_relations (
      owner_id INTEGER NOT NULL REFERENCES users(id),
      target_id INTEGER NOT NULL REFERENCES users(id),
      relation TEXT NOT NULL CHECK (relation IN ('muted', 'blocked')),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (owner_id, target_id)
    )
  `);

  // A conversation someone has hidden from their own inbox. It's per-owner
  // (hiding a chat only affects your view of it) and gets cleared the
  // moment either side sends a new message, so it reappears automatically.
  await db.execute(`
    CREATE TABLE IF NOT EXISTS conversation_hides (
      owner_id INTEGER NOT NULL REFERENCES users(id),
      target_id INTEGER NOT NULL REFERENCES users(id),
      hidden_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (owner_id, target_id)
    )
  `);

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

  // ---- Profile settings: case-insensitive lookups, avatars, name color,
  // and per-theme custom background colors.
  const userCols = await db.execute("PRAGMA table_info(users)");
  const userColumns = userCols.rows.map((c) => c.name);
  if (!userColumns.includes("username_lower")) {
    await db.execute("ALTER TABLE users ADD COLUMN username_lower TEXT");
    await db.execute("UPDATE users SET username_lower = LOWER(username) WHERE username_lower IS NULL");
  }
  await db.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username_lower ON users (username_lower)");
  if (!userColumns.includes("name_color")) {
    await db.execute("ALTER TABLE users ADD COLUMN name_color TEXT");
  }
  if (!userColumns.includes("avatar_image_id")) {
    await db.execute("ALTER TABLE users ADD COLUMN avatar_image_id INTEGER");
  }
  if (!userColumns.includes("theme_light_bg")) {
    await db.execute("ALTER TABLE users ADD COLUMN theme_light_bg TEXT");
  }
  if (!userColumns.includes("theme_dark_bg")) {
    await db.execute("ALTER TABLE users ADD COLUMN theme_dark_bg TEXT");
  }
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
const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;

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

function avatarUrlFor(avatarImageId) {
  return avatarImageId ? "/api/images/" + avatarImageId : null;
}

async function getUserByUsername(username) {
  const result = await db.execute({
    sql: "SELECT id, username, name_color, avatar_image_id FROM users WHERE username_lower = ?",
    args: [usernameLower(username)],
  });
  return result.rows[0] || null;
}

// Clears any "hidden" flag either side of a DM pair has set on the other,
// so a hidden conversation reappears the moment either person sends a
// message — whether that's the person who hid it starting the chat again,
// or the other person messaging them.
async function clearConversationHides(idA, idB) {
  await db.execute({
    sql: `DELETE FROM conversation_hides
          WHERE (owner_id = ? AND target_id = ?) OR (owner_id = ? AND target_id = ?)`,
    args: [idA, idB, idB, idA],
  });
}

// ---- Auth routes ------------------------------------------------------------
app.post("/api/register", async (req, res) => {
  const { username, password } = req.body || {};
  const error = validateCredentials(username, password);
  if (error) return res.status(400).json({ error });

  const existing = await db.execute({
    sql: "SELECT id FROM users WHERE username_lower = ?",
    args: [usernameLower(username)],
  });
  if (existing.rows.length) return res.status(409).json({ error: "That username is taken." });

  const password_hash = await bcrypt.hash(password, 12);
  const info = await db.execute({
    sql: "INSERT INTO users (username, username_lower, password_hash) VALUES (?, ?, ?)",
    args: [username, usernameLower(username), password_hash],
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
    sql: "SELECT * FROM users WHERE username_lower = ?",
    args: [usernameLower(username)],
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

app.get("/api/me", async (req, res) => {
  if (!req.session.userId) return res.json({ loggedIn: false });

  const result = await db.execute({
    sql: "SELECT username, name_color, avatar_image_id, theme_light_bg, theme_dark_bg FROM users WHERE id = ?",
    args: [req.session.userId],
  });
  const user = result.rows[0];
  if (!user) return res.json({ loggedIn: false });

  res.json({
    loggedIn: true,
    username: user.username,
    nameColor: user.name_color || null,
    avatarUrl: avatarUrlFor(user.avatar_image_id),
    themeLightBg: user.theme_light_bg || null,
    themeDarkBg: user.theme_dark_bg || null,
  });
});

// ---- Auth guard for future protected routes --------------------------------
function requireAuth(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: "Not logged in." });
  next();
}

// ---- User lookup ------------------------------------------------------------
// Lets the "type a username to start a message" box confirm the person
// exists before opening a thread for them. Case-insensitive: searching
// "jOHn" finds the account registered as "John".
app.get("/api/users/:username", requireAuth, async (req, res) => {
  const user = await getUserByUsername(req.params.username);
  if (!user) return res.status(404).json({ error: "No user with that username." });
  res.json({
    username: user.username,
    nameColor: user.name_color || null,
    avatarUrl: avatarUrlFor(user.avatar_image_id),
  });
});

// ---- Presence: who's online and actively looking at the tab right now ------
// See the socket.io section near the bottom for how onlineSockets/focus
// tracking is populated; this just reports a snapshot of it over REST for
// the initial page load (afterwards, updates arrive live over the socket).
app.get("/api/presence", requireAuth, async (req, res) => {
  const activeIds = [...onlineSockets.keys()].filter((uid) => isUserActive(uid));
  if (activeIds.length === 0) return res.json({ active: [] });
  const placeholders = activeIds.map(() => "?").join(",");
  const result = await db.execute({
    sql: `SELECT username FROM users WHERE id IN (${placeholders})`,
    args: activeIds,
  });
  res.json({ active: result.rows.map((r) => r.username) });
});

// ---- Account settings --------------------------------------------------------
app.post("/api/account/username", requireAuth, async (req, res) => {
  const { username } = req.body || {};
  if (typeof username !== "string" || !USERNAME_RE.test(username)) {
    return res.status(400).json({ error: "Username must be 3-20 characters: letters, numbers, underscore." });
  }

  const existing = await db.execute({
    sql: "SELECT id FROM users WHERE username_lower = ? AND id != ?",
    args: [usernameLower(username), req.session.userId],
  });
  if (existing.rows.length) return res.status(409).json({ error: "That username is taken." });

  await db.execute({
    sql: "UPDATE users SET username = ?, username_lower = ? WHERE id = ?",
    args: [username, usernameLower(username), req.session.userId],
  });
  req.session.username = username;
  res.json({ ok: true, username });
});

app.post("/api/account/password", requireAuth, async (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (typeof currentPassword !== "string" || typeof newPassword !== "string") {
    return res.status(400).json({ error: "Current and new password are required." });
  }
  if (newPassword.length < 8) {
    return res.status(400).json({ error: "New password must be at least 8 characters." });
  }

  const result = await db.execute({
    sql: "SELECT password_hash FROM users WHERE id = ?",
    args: [req.session.userId],
  });
  const user = result.rows[0];
  if (!user) return res.status(401).json({ error: "Not logged in." });

  const ok = await bcrypt.compare(currentPassword, user.password_hash);
  if (!ok) return res.status(401).json({ error: "Current password is incorrect." });

  const password_hash = await bcrypt.hash(newPassword, 12);
  await db.execute({
    sql: "UPDATE users SET password_hash = ? WHERE id = ?",
    args: [password_hash, req.session.userId],
  });
  res.json({ ok: true });
});

app.post("/api/account/color", requireAuth, async (req, res) => {
  const { color } = req.body || {};
  if (color !== null && !HEX_COLOR_RE.test(color || "")) {
    return res.status(400).json({ error: "Color must be a hex value like #a2582b, or null to reset." });
  }
  await db.execute({
    sql: "UPDATE users SET name_color = ? WHERE id = ?",
    args: [color, req.session.userId],
  });
  res.json({ ok: true, color: color || null });
});

// Custom background per theme. `field` picks which theme it applies to so
// setting one never touches the other.
app.post("/api/account/theme", requireAuth, async (req, res) => {
  const { field, color } = req.body || {};
  if (field !== "light" && field !== "dark") {
    return res.status(400).json({ error: "field must be 'light' or 'dark'." });
  }
  if (color !== null && !HEX_COLOR_RE.test(color || "")) {
    return res.status(400).json({ error: "Color must be a hex value like #f3efe1, or null to reset." });
  }
  const column = field === "light" ? "theme_light_bg" : "theme_dark_bg";
  await db.execute({
    sql: `UPDATE users SET ${column} = ? WHERE id = ?`,
    args: [color, req.session.userId],
  });
  res.json({ ok: true, field, color: color || null });
});

app.post("/api/account/avatar", requireAuth, (req, res) => {
  upload.single("avatar")(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message || "Upload failed." });
    if (!req.file) return res.status(400).json({ error: "No image provided." });

    try {
      const myId = req.session.userId;
      const imageInfo = await db.execute({
        sql: "INSERT INTO images (mime_type, data, uploaded_by) VALUES (?, ?, ?)",
        args: [req.file.mimetype, req.file.buffer, myId],
      });
      const imageId = insertedId(imageInfo);
      await db.execute({
        sql: "UPDATE users SET avatar_image_id = ? WHERE id = ?",
        args: [imageId, myId],
      });
      res.json({ ok: true, avatarUrl: avatarUrlFor(imageId) });
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: "Upload failed." });
    }
  });
});

app.delete("/api/account/avatar", requireAuth, async (req, res) => {
  await db.execute({
    sql: "UPDATE users SET avatar_image_id = NULL WHERE id = ?",
    args: [req.session.userId],
  });
  res.json({ ok: true });
});

// ---- Mute / block relations --------------------------------------------------
// Small helper used both by the /api/relations routes and by the send-message
// route (to check whether the recipient has blocked the sender).
async function getRelation(ownerId, targetId) {
  const result = await db.execute({
    sql: "SELECT relation FROM user_relations WHERE owner_id = ? AND target_id = ?",
    args: [ownerId, targetId],
  });
  return result.rows[0]?.relation || null;
}

app.get("/api/relations", requireAuth, async (req, res) => {
  const result = await db.execute({
    sql: `SELECT u.username, r.relation
          FROM user_relations r
          JOIN users u ON u.id = r.target_id
          WHERE r.owner_id = ?`,
    args: [req.session.userId],
  });
  const muted = result.rows.filter((r) => r.relation === "muted").map((r) => r.username);
  const blocked = result.rows.filter((r) => r.relation === "blocked").map((r) => r.username);
  res.json({ muted, blocked });
});

app.post("/api/relations", requireAuth, async (req, res) => {
  const { target, relation } = req.body || {};
  if (typeof target !== "string") {
    return res.status(400).json({ error: "A target username is required." });
  }
  if (relation !== null && relation !== "muted" && relation !== "blocked") {
    return res.status(400).json({ error: "relation must be 'muted', 'blocked', or null." });
  }
  if (usernameLower(target) === usernameLower(req.session.username)) {
    return res.status(400).json({ error: "You can't mute or block yourself." });
  }

  const targetUser = await getUserByUsername(target);
  if (!targetUser) return res.status(404).json({ error: "No user with that username." });

  if (relation === null) {
    await db.execute({
      sql: "DELETE FROM user_relations WHERE owner_id = ? AND target_id = ?",
      args: [req.session.userId, targetUser.id],
    });
  } else {
    await db.execute({
      sql: `INSERT INTO user_relations (owner_id, target_id, relation) VALUES (?, ?, ?)
            ON CONFLICT (owner_id, target_id) DO UPDATE SET relation = excluded.relation`,
      args: [req.session.userId, targetUser.id, relation],
    });
  }
  res.json({ ok: true, target: targetUser.username, relation });
});

// ---- Hiding a conversation from your own inbox -------------------------------
// This never touches message history — it just adds a per-owner flag that
// /api/conversations filters out, and that flag is cleared automatically
// the next time either person sends a message in that pair.
app.delete("/api/conversations/:username", requireAuth, async (req, res) => {
  const target = await getUserByUsername(req.params.username);
  if (!target) return res.status(404).json({ error: "No user with that username." });

  await db.execute({
    sql: `INSERT INTO conversation_hides (owner_id, target_id) VALUES (?, ?)
          ON CONFLICT (owner_id, target_id) DO UPDATE SET hidden_at = datetime('now')`,
    args: [req.session.userId, target.id],
  });
  res.json({ ok: true });
});

// One row per person you've exchanged messages with, most recent first, plus
// how many of their messages to you are still unread. Conversations you've
// hidden are left out entirely until they're reactivated by a new message.
app.get("/api/conversations", requireAuth, async (req, res) => {
  const myId = req.session.userId;
  const result = await db.execute({
    sql: `SELECT
         CASE WHEN m.sender_id = ? THEN ru.id ELSE su.id END AS other_id,
         CASE WHEN m.sender_id = ? THEN ru.username ELSE su.username END AS username,
         CASE WHEN m.sender_id = ? THEN ru.name_color ELSE su.name_color END AS name_color,
         CASE WHEN m.sender_id = ? THEN ru.avatar_image_id ELSE su.avatar_image_id END AS avatar_image_id,
         m.body,
         m.type,
         m.created_at
       FROM messages m
       JOIN users su ON su.id = m.sender_id
       JOIN users ru ON ru.id = m.recipient_id
       WHERE m.sender_id = ? OR m.recipient_id = ?
       ORDER BY m.created_at DESC`,
    args: [myId, myId, myId, myId, myId, myId],
  });

  const hiddenResult = await db.execute({
    sql: "SELECT target_id FROM conversation_hides WHERE owner_id = ?",
    args: [myId],
  });
  const hiddenIds = new Set(hiddenResult.rows.map((r) => Number(r.target_id)));

  const seen = new Set();
  const conversations = [];
  for (const row of result.rows) {
    if (seen.has(row.username)) continue;
    if (hiddenIds.has(Number(row.other_id))) continue;
    seen.add(row.username);
    conversations.push(row);
  }

  const unreadResult = await db.execute({
    sql: `SELECT sender_id, COUNT(*) AS unread
          FROM messages
          WHERE recipient_id = ? AND read_at IS NULL
          GROUP BY sender_id`,
    args: [myId],
  });
  const unreadByOtherId = new Map(unreadResult.rows.map((r) => [Number(r.sender_id), Number(r.unread)]));

  res.json({
    conversations: conversations.map((c) => ({
      username: c.username,
      body: c.body,
      type: c.type,
      created_at: c.created_at,
      nameColor: c.name_color || null,
      avatarUrl: avatarUrlFor(c.avatar_image_id),
      unread: unreadByOtherId.get(Number(c.other_id)) || 0,
    })),
  });
});

// ---- Message history with one person ----------------------------------------
app.get("/api/messages/:username", requireAuth, async (req, res) => {
  const myId = req.session.userId;
  const other = await getUserByUsername(req.params.username);
  if (!other) return res.status(404).json({ error: "No user with that username." });

  const result = await db.execute({
    sql: `SELECT m.id, m.sender_id, m.body, m.type, m.created_at, m.read_at, m.edited_at,
                 m.reply_to_id, rm.id AS reply_row_id, rm.body AS reply_body, rm.type AS reply_type,
                 rm.sender_id AS reply_sender_id
          FROM messages m
          LEFT JOIN messages rm ON rm.id = m.reply_to_id
          WHERE (m.sender_id = ? AND m.recipient_id = ?)
             OR (m.sender_id = ? AND m.recipient_id = ?)
          ORDER BY m.created_at ASC, m.id ASC`,
    args: [myId, other.id, other.id, myId],
  });

  const messages = result.rows.map((r) => ({
    id: r.id,
    body: r.body,
    type: r.type,
    created_at: r.created_at,
    mine: r.sender_id === myId,
    read: r.read_at != null,
    edited: r.edited_at != null,
    // A reply pointing at a message that's since been unsent still shows a
    // "removed" placeholder in the quote, without needing to keep the
    // original message's row around.
    reply: r.reply_to_id
      ? r.reply_row_id == null
        ? { removed: true }
        : {
            id: r.reply_row_id,
            body: r.reply_body,
            type: r.reply_type,
            sender: r.reply_sender_id === myId ? "me" : other.username,
          }
      : null,
  }));
  res.json({ messages });
});

// ---- Mark all of someone's messages to me as read ----------------------------
app.post("/api/messages/:username/read", requireAuth, async (req, res) => {
  const myId = req.session.userId;
  const other = await getUserByUsername(req.params.username);
  if (!other) return res.status(404).json({ error: "No user with that username." });

  const updated = await db.execute({
    sql: `UPDATE messages SET read_at = datetime('now')
          WHERE sender_id = ? AND recipient_id = ? AND read_at IS NULL`,
    args: [other.id, myId],
  });

  // Let the sender know (live) that their messages in this thread were seen.
  if (updated.rowsAffected > 0) {
    for (const socketId of onlineSockets.get(other.id) || []) {
      io.to(socketId).emit("message-read", { by: req.session.username });
    }
  }
  res.json({ ok: true });
});

// Fetch a DM message plus who it belongs to, used by the edit/delete routes
// below to check ownership and figure out who to notify.
async function getOwnedMessage(id, myId) {
  const result = await db.execute({
    sql: "SELECT id, sender_id, recipient_id, type FROM messages WHERE id = ?",
    args: [id],
  });
  const row = result.rows[0];
  if (!row || row.sender_id !== myId) return null;
  return row;
}

// ---- Send a message ----------------------------------------------------------
app.post("/api/messages", requireAuth, async (req, res) => {
  const myId = req.session.userId;
  const { to, body, replyTo } = req.body || {};

  if (typeof to !== "string" || typeof body !== "string" || !body.trim()) {
    return res.status(400).json({ error: "A recipient and message body are required." });
  }
  if (body.length > 2000) {
    return res.status(400).json({ error: "Messages are limited to 2000 characters." });
  }
  if (usernameLower(to) === usernameLower(req.session.username)) {
    return res.status(400).json({ error: "You can't message yourself." });
  }

  const recipient = await getUserByUsername(to);
  if (!recipient) return res.status(404).json({ error: "No user with that username." });

  const theirRelationToMe = await getRelation(recipient.id, myId);
  if (theirRelationToMe === "blocked") {
    return res.status(403).json({ error: "You can't message this user." });
  }

  let replyToId = null;
  let replyPreview = null;
  if (replyTo != null) {
    const replyResult = await db.execute({
      sql: `SELECT id, sender_id, body, type FROM messages
            WHERE id = ? AND ((sender_id = ? AND recipient_id = ?) OR (sender_id = ? AND recipient_id = ?))`,
      args: [Number(replyTo), myId, recipient.id, recipient.id, myId],
    });
    const replied = replyResult.rows[0];
    if (replied) {
      replyToId = replied.id;
      replyPreview = {
        id: replied.id,
        body: replied.body,
        type: replied.type,
        sender: replied.sender_id === myId ? "me" : recipient.username,
      };
    }
  }

  const trimmedBody = body.trim();
  const info = await db.execute({
    sql: "INSERT INTO messages (sender_id, recipient_id, body, reply_to_id) VALUES (?, ?, ?, ?)",
    args: [myId, recipient.id, trimmedBody, replyToId],
  });
  await clearConversationHides(myId, recipient.id);
  const createdResult = await db.execute({
    sql: "SELECT created_at FROM messages WHERE id = ?",
    args: [insertedId(info)],
  });
  const created_at = createdResult.rows[0].created_at;

  // Push it to the recipient in real time if they're online right now.
  const payload = {
    id: insertedId(info),
    from: req.session.username,
    to: recipient.username,
    body: trimmedBody,
    type: "text",
    created_at,
    reply: replyPreview,
  };
  for (const socketId of onlineSockets.get(recipient.id) || []) {
    io.to(socketId).emit("message", payload);
  }

  res.json({ ok: true, message: payload });
});

// ---- Edit / unsend a DM message -----------------------------------------------
app.patch("/api/messages/:id", requireAuth, async (req, res) => {
  const myId = req.session.userId;
  const id = Number(req.params.id);
  const { body } = req.body || {};
  if (typeof body !== "string" || !body.trim()) {
    return res.status(400).json({ error: "A message body is required." });
  }
  if (body.length > 2000) {
    return res.status(400).json({ error: "Messages are limited to 2000 characters." });
  }

  const msg = await getOwnedMessage(id, myId);
  if (!msg) return res.status(404).json({ error: "Message not found." });
  if (msg.type !== "text") return res.status(400).json({ error: "Only text messages can be edited." });

  const trimmedBody = body.trim();
  await db.execute({
    sql: "UPDATE messages SET body = ?, edited_at = datetime('now') WHERE id = ?",
    args: [trimmedBody, id],
  });

  const payload = { id, body: trimmedBody };
  for (const socketId of onlineSockets.get(msg.recipient_id) || []) {
    io.to(socketId).emit("message-edited", payload);
  }
  res.json({ ok: true, message: payload });
});

// A real unsend: the row is gone, not just blanked out. Any reply that
// quoted it will show a "removed" placeholder instead (see the history
// queries above), rather than a lingering "Message deleted" bubble.
app.delete("/api/messages/:id", requireAuth, async (req, res) => {
  const myId = req.session.userId;
  const id = Number(req.params.id);

  const msg = await getOwnedMessage(id, myId);
  if (!msg) return res.status(404).json({ error: "Message not found." });

  await db.execute({ sql: "DELETE FROM messages WHERE id = ?", args: [id] });

  const payload = { id };
  for (const socketId of onlineSockets.get(msg.recipient_id) || []) {
    io.to(socketId).emit("message-deleted", payload);
  }
  res.json({ ok: true, id });
});

// ---- Send an image message ---------------------------------------------------
// Multipart upload: form fields `to` (recipient username) and `image` (file).
// requireAuth runs first so an unauthenticated request never reaches multer.
// The file is held in memory only long enough to write it into Turso as a
// BLOB row — it's never touched down to local disk. Works equally whether
// the file came from the picker, drag-and-drop, or a clipboard paste — the
// browser hands over a File either way.
app.post("/api/messages/image", requireAuth, (req, res) => {
  upload.single("image")(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message || "Upload failed." });
    if (!req.file) return res.status(400).json({ error: "No image provided." });

    try {
      const myId = req.session.userId;
      const to = (req.body && req.body.to) || "";
      if (usernameLower(to) === usernameLower(req.session.username)) {
        return res.status(400).json({ error: "You can't message yourself." });
      }

      const recipient = await getUserByUsername(to);
      if (!recipient) return res.status(404).json({ error: "No user with that username." });

      const theirRelationToMe = await getRelation(recipient.id, myId);
      if (theirRelationToMe === "blocked") {
        return res.status(403).json({ error: "You can't message this user." });
      }

      const imageInfo = await db.execute({
        sql: "INSERT INTO images (mime_type, data, uploaded_by) VALUES (?, ?, ?)",
        args: [req.file.mimetype, req.file.buffer, myId],
      });
      const url = "/api/images/" + insertedId(imageInfo);

      const info = await db.execute({
        sql: "INSERT INTO messages (sender_id, recipient_id, body, type) VALUES (?, ?, ?, 'image')",
        args: [myId, recipient.id, url],
      });
      await clearConversationHides(myId, recipient.id);
      const createdResult = await db.execute({
        sql: "SELECT created_at FROM messages WHERE id = ?",
        args: [insertedId(info)],
      });
      const created_at = createdResult.rows[0].created_at;

      const payload = {
        id: insertedId(info),
        from: req.session.username,
        to: recipient.username,
        body: url,
        type: "image",
        created_at,
        reply: null,
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

// ---- Global chat --------------------------------------------------------------
// One shared room everyone can post to and read. No block/mute filtering here
// on purpose — those only govern DMs and DM notifications; the global room is
// a public space everyone in it can see in full.
const GLOBAL_HISTORY_LIMIT = 200;

app.get("/api/global/messages", requireAuth, async (req, res) => {
  const result = await db.execute({
    sql: `SELECT g.id, g.sender_id, u.username AS sender, u.name_color, u.avatar_image_id,
                 g.body, g.type, g.created_at, g.edited_at, g.reply_to_id,
                 rg.id AS reply_row_id, rg.body AS reply_body, rg.type AS reply_type,
                 ru.username AS reply_sender
          FROM global_messages g
          JOIN users u ON u.id = g.sender_id
          LEFT JOIN global_messages rg ON rg.id = g.reply_to_id
          LEFT JOIN users ru ON ru.id = rg.sender_id
          ORDER BY g.created_at ASC, g.id ASC
          LIMIT ?`,
    args: [GLOBAL_HISTORY_LIMIT],
  });
  const messages = result.rows.map((r) => ({
    id: r.id,
    sender: r.sender,
    nameColor: r.name_color || null,
    avatarUrl: avatarUrlFor(r.avatar_image_id),
    body: r.body,
    type: r.type,
    created_at: r.created_at,
    edited: r.edited_at != null,
    mine: r.sender === req.session.username,
    reply: r.reply_to_id
      ? r.reply_row_id == null
        ? { removed: true }
        : { id: r.reply_row_id, body: r.reply_body, type: r.reply_type, sender: r.reply_sender }
      : null,
  }));
  res.json({ messages });
});

function broadcastGlobal(payload, exceptUserId) {
  for (const [uid, socketIds] of onlineSockets.entries()) {
    if (uid === exceptUserId) continue;
    for (const socketId of socketIds) io.to(socketId).emit("global-message", payload);
  }
}

// Used for edits/deletes/reads — everyone gets it, including the sender's
// other open tabs, so every view of the global room stays in sync.
function broadcastGlobalAll(event, payload) {
  for (const socketIds of onlineSockets.values()) {
    for (const socketId of socketIds) io.to(socketId).emit(event, payload);
  }
}

app.post("/api/global/messages", requireAuth, async (req, res) => {
  const myId = req.session.userId;
  const { body, replyTo } = req.body || {};
  if (typeof body !== "string" || !body.trim()) {
    return res.status(400).json({ error: "A message body is required." });
  }
  if (body.length > 2000) {
    return res.status(400).json({ error: "Messages are limited to 2000 characters." });
  }

  let replyToId = null;
  let replyPreview = null;
  if (replyTo != null) {
    const replyResult = await db.execute({
      sql: `SELECT g.id, g.body, g.type, u.username AS sender
            FROM global_messages g JOIN users u ON u.id = g.sender_id
            WHERE g.id = ?`,
      args: [Number(replyTo)],
    });
    const replied = replyResult.rows[0];
    if (replied) {
      replyToId = replied.id;
      replyPreview = { id: replied.id, body: replied.body, type: replied.type, sender: replied.sender };
    }
  }

  const trimmedBody = body.trim();
  const info = await db.execute({
    sql: "INSERT INTO global_messages (sender_id, body, reply_to_id) VALUES (?, ?, ?)",
    args: [myId, trimmedBody, replyToId],
  });
  const createdResult = await db.execute({
    sql: "SELECT created_at FROM global_messages WHERE id = ?",
    args: [insertedId(info)],
  });

  const meResult = await db.execute({
    sql: "SELECT name_color, avatar_image_id FROM users WHERE id = ?",
    args: [myId],
  });
  const me = meResult.rows[0] || {};

  const payload = {
    id: insertedId(info),
    sender: req.session.username,
    nameColor: me.name_color || null,
    avatarUrl: avatarUrlFor(me.avatar_image_id),
    body: trimmedBody,
    type: "text",
    created_at: createdResult.rows[0].created_at,
    reply: replyPreview,
  };
  broadcastGlobal(payload, myId);
  res.json({ ok: true, message: payload });
});

// ---- Edit / unsend a global message -------------------------------------------
async function getOwnedGlobalMessage(id, myId) {
  const result = await db.execute({
    sql: "SELECT id, sender_id, type FROM global_messages WHERE id = ?",
    args: [id],
  });
  const row = result.rows[0];
  if (!row || row.sender_id !== myId) return null;
  return row;
}

app.patch("/api/global/messages/:id", requireAuth, async (req, res) => {
  const myId = req.session.userId;
  const id = Number(req.params.id);
  const { body } = req.body || {};
  if (typeof body !== "string" || !body.trim()) {
    return res.status(400).json({ error: "A message body is required." });
  }
  if (body.length > 2000) {
    return res.status(400).json({ error: "Messages are limited to 2000 characters." });
  }

  const msg = await getOwnedGlobalMessage(id, myId);
  if (!msg) return res.status(404).json({ error: "Message not found." });
  if (msg.type !== "text") return res.status(400).json({ error: "Only text messages can be edited." });

  const trimmedBody = body.trim();
  await db.execute({
    sql: "UPDATE global_messages SET body = ?, edited_at = datetime('now') WHERE id = ?",
    args: [trimmedBody, id],
  });

  broadcastGlobalAll("global-message-edited", { id, body: trimmedBody });
  res.json({ ok: true, message: { id, body: trimmedBody } });
});

app.delete("/api/global/messages/:id", requireAuth, async (req, res) => {
  const myId = req.session.userId;
  const id = Number(req.params.id);

  const msg = await getOwnedGlobalMessage(id, myId);
  if (!msg) return res.status(404).json({ error: "Message not found." });

  await db.execute({ sql: "DELETE FROM global_messages WHERE id = ?", args: [id] });

  broadcastGlobalAll("global-message-deleted", { id });
  res.json({ ok: true, id });
});

app.post("/api/global/messages/image", requireAuth, (req, res) => {
  upload.single("image")(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message || "Upload failed." });
    if (!req.file) return res.status(400).json({ error: "No image provided." });

    try {
      const myId = req.session.userId;
      const imageInfo = await db.execute({
        sql: "INSERT INTO images (mime_type, data, uploaded_by) VALUES (?, ?, ?)",
        args: [req.file.mimetype, req.file.buffer, myId],
      });
      const url = "/api/images/" + insertedId(imageInfo);

      const info = await db.execute({
        sql: "INSERT INTO global_messages (sender_id, body, type) VALUES (?, ?, 'image')",
        args: [myId, url],
      });
      const createdResult = await db.execute({
        sql: "SELECT created_at FROM global_messages WHERE id = ?",
        args: [insertedId(info)],
      });

      const meResult = await db.execute({
        sql: "SELECT name_color, avatar_image_id FROM users WHERE id = ?",
        args: [myId],
      });
      const me = meResult.rows[0] || {};

      const payload = {
        id: insertedId(info),
        sender: req.session.username,
        nameColor: me.name_color || null,
        avatarUrl: avatarUrlFor(me.avatar_image_id),
        body: url,
        type: "image",
        created_at: createdResult.rows[0].created_at,
        reply: null,
      };
      broadcastGlobal(payload, myId);
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

// userId -> username, for turning "who's connected right now" into names
// without a DB round-trip. Populated/cleared alongside onlineSockets.
const onlineUserNames = new Map();

// socketId -> whether that particular tab currently has focus. A user
// counts as "actively looking at the tab" (the green presence dot) if ANY
// of their open sockets is focused. This is separate from "online" (merely
// connected) below — online covers the Global Chat headcount, active/focus
// covers the per-contact presence dot.
const socketFocus = new Map();

function isUserActive(userId) {
  const ids = onlineSockets.get(userId);
  if (!ids || ids.size === 0) return false;
  for (const id of ids) {
    if (socketFocus.get(id)) return true;
  }
  return false;
}

function broadcastPresence(username, active) {
  for (const socketIds of onlineSockets.values()) {
    for (const socketId of socketIds) io.to(socketId).emit("presence", { username, active });
  }
}

// Broadcast when someone's connection count crosses 0<->1 — i.e. they
// actually joined or left, not just switched tabs/focus.
function broadcastOnline(username, online) {
  for (const socketIds of onlineSockets.values()) {
    for (const socketId of socketIds) io.to(socketId).emit("online-changed", { username, online });
  }
}

// ---- Who's online right now (for the Global Chat headcount) -----------------
app.get("/api/online", requireAuth, (req, res) => {
  res.json({ online: [...onlineUserNames.values()] });
});

// Looks up a user id by username for relaying a "typing" ping — small and
// used only for that, so it's kept local to the socket handler below.
async function findUserId(username) {
  const result = await db.execute({
    sql: "SELECT id FROM users WHERE username_lower = ?",
    args: [usernameLower(username)],
  });
  return result.rows[0]?.id || null;
}

io.on("connection", (socket) => {
  const session = socket.request.session;
  if (!session || !session.userId) {
    socket.disconnect(true);
    return;
  }
  const userId = session.userId;
  const username = session.username;
  const isFirstConnectionForUser = !onlineSockets.has(userId);
  if (isFirstConnectionForUser) onlineSockets.set(userId, new Set());
  onlineSockets.get(userId).add(socket.id);
  onlineUserNames.set(userId, username);
  if (isFirstConnectionForUser) broadcastOnline(username, true);
  // Assume focused until told otherwise — the client sends its real state
  // right after connecting, this just avoids a flash of "inactive".
  socketFocus.set(socket.id, true);
  broadcastPresence(username, true);

  socket.on("focus-state", ({ focused }) => {
    const wasActive = isUserActive(userId);
    socketFocus.set(socket.id, !!focused);
    const nowActive = isUserActive(userId);
    if (wasActive !== nowActive) broadcastPresence(username, nowActive);
  });

  socket.on("typing", async ({ scope, to, active }) => {
    if (scope === "global") {
      for (const [uid, socketIds] of onlineSockets.entries()) {
        if (uid === userId) continue;
        for (const socketId of socketIds) io.to(socketId).emit("global-typing", { username, active: !!active });
      }
    } else if (scope === "dm" && typeof to === "string") {
      const targetId = await findUserId(to);
      if (!targetId) return;
      for (const socketId of onlineSockets.get(targetId) || []) {
        io.to(socketId).emit("typing", { from: username, active: !!active });
      }
    }
  });

  socket.on("disconnect", () => {
    socketFocus.delete(socket.id);
    onlineSockets.get(userId)?.delete(socket.id);
    if (onlineSockets.get(userId)?.size === 0) {
      onlineSockets.delete(userId);
      onlineUserNames.delete(userId);
      broadcastPresence(username, false);
      broadcastOnline(username, false);
    } else if (!isUserActive(userId)) {
      broadcastPresence(username, false);
    }
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
