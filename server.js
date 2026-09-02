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
const ADMIN_MODE_PASSWORD = process.env.ADMIN_MODE_PASSWORD || "SussyBaka67";

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
  // Used by the archiving sweep below to find old rows quickly instead of a
  // full table scan every run.
  await db.execute("CREATE INDEX IF NOT EXISTS idx_global_messages_created_at ON global_messages (created_at)");

  // Global Chat can run up the row count fast since every user posts into
  // the same table. Rather than deleting old messages (which would break
  // "scroll up as far as you want"), anything older than
  // GLOBAL_ARCHIVE_AFTER_DAYS gets moved into this twin table instead. It
  // has the exact same shape but no extra indexes beyond its primary key, so
  // the hot `global_messages` table — the one every read/write and reply
  // lookup hits — stays small and fast no matter how much history piles up,
  // while old messages stay fully intact and still load when someone scrolls
  // back far enough (see fetchGlobalPage below, which stitches both tables
  // together transparently).
  await db.execute(`
    CREATE TABLE IF NOT EXISTS global_messages_archive (
      id INTEGER PRIMARY KEY,
      sender_id INTEGER NOT NULL REFERENCES users(id),
      body TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'text',
      created_at TEXT NOT NULL,
      edited_at TEXT,
      reply_to_id INTEGER
    )
  `);

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
  // Group chats: DM-like multi-person threads. Started from the same
  // "message a username" box by separating names with commas (see
  // POST /api/groups below). Aesthetically these borrow from Global Chat
  // (sender name + avatar on every bubble) and from DMs (replies, edit/
  // unsend, per-person read tracking).
  await db.execute(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)`);
  await db.execute(`
    CREATE TABLE IF NOT EXISTS group_chats (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT,
      created_by INTEGER NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  await db.execute(`
    CREATE TABLE IF NOT EXISTS group_members (
      group_id INTEGER NOT NULL REFERENCES group_chats(id),
      user_id INTEGER NOT NULL REFERENCES users(id),
      joined_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_read_at TEXT,
      PRIMARY KEY (group_id, user_id)
    )
  `);
  await db.execute("CREATE INDEX IF NOT EXISTS idx_group_members_user ON group_members (user_id)");
  await db.execute(`
    CREATE TABLE IF NOT EXISTS group_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      group_id INTEGER NOT NULL REFERENCES group_chats(id),
      sender_id INTEGER NOT NULL REFERENCES users(id),
      body TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'text',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      edited_at TEXT,
      reply_to_id INTEGER
    )
  `);
  await db.execute("CREATE INDEX IF NOT EXISTS idx_group_messages_group ON group_messages (group_id, created_at)");

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
  if (!userColumns.includes("is_admin")) {
    await db.execute("ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0");
  }
  // Beta Features: an opt-in flag a user flips on in Settings. Right now the
  // only thing gated behind it is DM voice calling — both sides of a DM need
  // it enabled before the call button shows up (see the call: socket
  // handlers near the bottom of this file).
  if (!userColumns.includes("beta_features")) {
    await db.execute("ALTER TABLE users ADD COLUMN beta_features INTEGER NOT NULL DEFAULT 0");
  }

  // Group chat picture — same idea as a user's avatar_image_id, just on
  // group_chats instead of users. Any current member can set it.
  const groupCols = await db.execute("PRAGMA table_info(group_chats)");
  const groupChatColumns = groupCols.rows.map((c) => c.name);
  if (!groupChatColumns.includes("avatar_image_id")) {
    await db.execute("ALTER TABLE group_chats ADD COLUMN avatar_image_id INTEGER");
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

// MediaRecorder's Blob.type (and therefore the multipart Content-Type the
// browser sends) usually carries a codec suffix, e.g. "audio/webm;codecs=opus"
// or "video/webm;codecs=vp9,opus" — not the bare "audio/webm" a naive Set
// lookup would expect. Compare on the base type only so real recordings
// aren't rejected as an "unsupported format".
function baseMimeType(mimeType) {
  return String(mimeType || "").split(";")[0].trim().toLowerCase();
}

// Some browsers (older Android WebViews, a few in-app browsers) don't
// reliably carry the recorded Blob's real `type` through onto the
// multipart part's Content-Type header — multer then reports it as
// "application/octet-stream" or leaves it blank, even though the bytes
// are a perfectly good recording. Treat that the same as "unknown but
// probably fine" rather than bouncing the upload, since this endpoint
// only ever receives what our own recorder produced.
function isGenericMimeType(mimeType) {
  const base = baseMimeType(mimeType);
  return base === "" || base === "application/octet-stream" || base === "binary/octet-stream";
}

// Voice messages, recorded in-browser with MediaRecorder. Kept well under
// the video limit below since these are meant to be quick clips, not long
// recordings.
//
// Rather than hardcode an exact allowlist of container/codec strings — which
// varies by browser and kept rejecting perfectly valid recordings (Firefox,
// Safari and Chrome each report slightly different mimetypes) — accept
// anything the browser genuinely declares as audio/*, plus the generic/blank
// case above. It's an authenticated, same-origin upload; there's no
// meaningful security gain from guessing codec strings, only false
// rejections. Reject only mimetypes that are clearly some other media kind
// (image/*, video/*, etc).
const uploadAudio = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
  fileFilter: (req, file, cb) => {
    if (!baseMimeType(file.mimetype).startsWith("audio/") && !isGenericMimeType(file.mimetype)) {
      return cb(new Error("That audio format isn't supported."));
    }
    cb(null, true);
  },
});

// Selfie-cam video clips, recorded in-browser with MediaRecorder. Different
// browsers (and in some cases the same browser across a redeploy) report
// wildly different strings here — "video/webm;codecs=vp9,opus",
// "video/mp4", "video/x-matroska", occasionally something generic like
// "application/octet-stream" when a webview doesn't carry the Blob's real
// type through to the multipart request at all. Trying to allowlist that
// kept producing false "isn't supported" rejections for perfectly good
// recordings, so this endpoint no longer gates on mimetype at all — it's an
// authenticated, same-origin upload used by nothing but our own recorder,
// so there's no real security benefit to guessing codec strings, only
// broken uploads. Whatever the browser sends is accepted; resolveStoredMimeType
// below still makes sure something *playable* ends up in the DB even when
// what came in was generic.
const uploadVideo = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 }, // 25MB
});

// When a file's mimetype came through as one of the generic values above,
// pick a real, playable media type to store instead — the DB column and
// every <audio>/<video> tag downstream needs a genuine mime type, not
// "application/octet-stream", or playback breaks even though the upload
// itself succeeded. Prefers the mimeType the client sent as a plain form
// field (the Blob's real .type, in case the multipart Content-Type got
// mangled in transit) before falling back to whatever MediaRecorder
// defaults to in the overwhelming majority of browsers for that kind of
// clip.
function resolveStoredMimeType(mimeType, reportedMimeType, expectedPrefix, fallback) {
  if (!isGenericMimeType(mimeType)) return mimeType;
  const reportedBase = baseMimeType(reportedMimeType);
  if (reportedBase.startsWith(expectedPrefix)) return reportedMimeType;
  return fallback;
}

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
    sql: "SELECT username, name_color, avatar_image_id, theme_light_bg, theme_dark_bg, is_admin, beta_features FROM users WHERE id = ?",
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
    isAdmin: Boolean(user.is_admin),
    betaFeatures: Boolean(user.beta_features),
  });
});

// ---- Beta Features toggle ----------------------------------------------------
// Purely opt-in and self-service (unlike admin mode, no password gate) —
// right now it just unlocks the DM voice call button once both sides of a
// DM have it turned on.
app.post("/api/account/beta-features", requireAuth, async (req, res) => {
  const enabled = Boolean(req.body && req.body.enabled);
  await db.execute({
    sql: "UPDATE users SET beta_features = ? WHERE id = ?",
    args: [enabled ? 1 : 0, req.session.userId],
  });
  res.json({ ok: true, betaFeatures: enabled });
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
  const betaResult = await db.execute({ sql: "SELECT beta_features FROM users WHERE id = ?", args: [user.id] });
  res.json({
    username: user.username,
    nameColor: user.name_color || null,
    avatarUrl: avatarUrlFor(user.avatar_image_id),
    betaFeatures: Boolean(betaResult.rows[0]?.beta_features),
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

// GIF search / proxy -----------------------------------------------------------
// Tenor's public API was shut down on June 30, 2026.  Keep Tenor support by
// using the public Tenor search/view pages server-side, so clients never need
// to reach Tenor directly.  If KLIPY_API_KEY is configured, KLIPY is preferred
// for search and Tenor-page scraping remains the fallback.
const KLIPY_API_KEY=process.env.KLIPY_API_KEY||"";
const TENOR_HOSTS=new Set(["tenor.com","www.tenor.com","media.tenor.com"]);
function isTenorUrl(raw){try{const u=new URL(raw);return /^https?:$/.test(u.protocol)&&TENOR_HOSTS.has(u.hostname.toLowerCase())}catch{return false}}
function extractTenorMediaUrls(html){
  const text=String(html||"").replace(/\\u002F/g,"/").replace(/\\\//g,"/").replace(/&amp;/g,"&");
  const urls=new Set();
  const re=/https?:\/\/media\.tenor\.com\/[^"'\\s<>]+/gi;
  for(const m of text.match(re)||[]){
    let u=m.replace(/\\\\/g,"/");
    u=u.replace(/[),.;]+$/g,"");
    if(/\.(?:gif|webp)(?:[?#]|$)/i.test(u)) urls.add(u);
  }
  return [...urls].slice(0,30);
}
async function fetchTenorPage(url){
  if(!isTenorUrl(url)) throw Error("Only Tenor URLs are supported.");
  const rr=await fetch(url,{redirect:"follow",signal:AbortSignal.timeout(12000),headers:{"user-agent":"Mozilla/5.0 (compatible; HeartwoodChat/1.0)"}});
  if(!rr.ok) throw Error(`Tenor returned HTTP ${rr.status}.`);
  return await rr.text();
}
async function tenorSearch(q){
  const url=`https://tenor.com/search/${encodeURIComponent(q).replace(/%20/g,"-")}-gifs`;
  const html=await fetchTenorPage(url);
  return extractTenorMediaUrls(html).map((gifUrl,i)=>({id:`tenor-${i}-${Buffer.from(gifUrl).toString("base64url").slice(0,18)}`,title:"Tenor GIF",previewUrl:gifUrl,gifUrl}));
}
app.get("/api/gifs/search",requireAuth,async(req,res)=>{
  const q=String(req.query.q||"").trim().slice(0,100);
  if(!q)return res.json({results:[]});
  // Preferred provider when configured.
  if(KLIPY_API_KEY){
    try{
      const u=new URL("https://api.klipy.com/v2/search");
      u.searchParams.set("q",q);u.searchParams.set("key",KLIPY_API_KEY);u.searchParams.set("limit","12");u.searchParams.set("media_filter","tinygif,gif");u.searchParams.set("contentfilter","medium");u.searchParams.set("country","US");u.searchParams.set("locale","en_US");
      const rr=await fetch(u,{signal:AbortSignal.timeout(10000)}),d=await rr.json();
      if(rr.ok){
        const results=(d.results||[]).map(x=>({id:x.id,title:x.content_description||x.title||"GIF",previewUrl:x.media_formats?.tinygif?.url||x.media_formats?.preview?.url||x.media_formats?.gif?.url,gifUrl:x.media_formats?.gif?.url||x.media_formats?.tinygif?.url})).filter(x=>x.gifUrl);
        if(results.length)return res.json({results,provider:"klipy"});
      }
    }catch{}
  }
  // No Tenor API key is required for this fallback: fetch the public Tenor
  // search page from the server and extract its media URLs.
  try{return res.json({results:await tenorSearch(q),provider:"tenor-page"});}
  catch(e){return res.status(502).json({error:"GIF search is unavailable right now. Tenor search could not be reached from the server."});}
});

// Browser-side Tenor links are proxied through this server. This is important
// for networks that block Tenor, and also lets ordinary tenor.com/view links
// embed even though they are not direct .gif files.
app.get("/api/gifs/tenor-proxy",requireAuth,async(req,res)=>{
  const raw=String(req.query.url||"");
  if(!isTenorUrl(raw))return res.status(400).json({error:"Invalid Tenor URL."});
  try{
    let mediaUrl=raw;
    if(new URL(raw).hostname.toLowerCase()!=="media.tenor.com"){
      const html=await fetchTenorPage(raw);
      mediaUrl=extractTenorMediaUrls(html)[0];
      if(!mediaUrl)return res.status(404).json({error:"No GIF media was found in that Tenor page."});
    }
    const rr=await fetch(mediaUrl,{redirect:"follow",signal:AbortSignal.timeout(15000),headers:{"user-agent":"Mozilla/5.0 (compatible; HeartwoodChat/1.0)"}});
    if(!rr.ok)return res.status(502).json({error:"Could not fetch the Tenor GIF."});
    const ct=(rr.headers.get("content-type")||"").split(";")[0];
    if(!/^image\/(gif|webp|png|jpeg)$/.test(ct))return res.status(415).json({error:"Tenor did not return an image."});
    res.set("Content-Type",ct);res.set("Cache-Control","public, max-age=86400");res.set("X-Content-Type-Options","nosniff");
    res.send(Buffer.from(await rr.arrayBuffer()));
  }catch(e){res.status(502).json({error:e.message||"Tenor proxy failed."});}
});

async function storeRemoteGif(url,userId){
  const u=new URL(url);if(!/^https?:$/.test(u.protocol))throw Error("Invalid GIF URL.");
  let fetchUrl=url;
  if(isTenorUrl(url) && u.hostname.toLowerCase()!=="media.tenor.com"){
    const html=await fetchTenorPage(url);fetchUrl=extractTenorMediaUrls(html)[0];if(!fetchUrl)throw Error("No GIF media was found in that Tenor page.");
  }
  const rr=await fetch(fetchUrl,{redirect:"follow",signal:AbortSignal.timeout(15000),headers:{"user-agent":"Mozilla/5.0 (compatible; HeartwoodChat/1.0)"}});
  if(!rr.ok)throw Error("Could not fetch GIF.");
  const ct=(rr.headers.get("content-type")||"").split(";")[0];
  if(ct!=="image/gif")throw Error("That URL is not a GIF.");
  const b=Buffer.from(await rr.arrayBuffer());if(b.length>8*1024*1024)throw Error("GIF is too large (8MB max).");
  const info=await db.execute({sql:"INSERT INTO images(mime_type,data,uploaded_by) VALUES(?,?,?)",args:[ct,b,userId]});return "/api/images/"+insertedId(info);
}
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

  const { rows, hasMore } = await fetchMessagePage({
    selectSql: `SELECT m.id, m.sender_id, m.body, m.type, m.created_at, m.read_at, m.edited_at,
                 m.reply_to_id, rm.id AS reply_row_id, rm.body AS reply_body, rm.type AS reply_type,
                 rm.sender_id AS reply_sender_id
          FROM messages m
          LEFT JOIN messages rm ON rm.id = m.reply_to_id
          WHERE ((m.sender_id = ? AND m.recipient_id = ?) OR (m.sender_id = ? AND m.recipient_id = ?))`,
    args: [myId, other.id, other.id, myId],
    idExpr: "m.id",
    before: req.query.before != null ? Number(req.query.before) : null,
    after: req.query.after != null ? Number(req.query.after) : null,
    limit: req.query.limit,
  });

  const messages = rows.map((r) => ({
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
  res.json({ messages, hasMore });
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
  const requestedType = ["text", "youtube", "gif"].includes(req.body?.type) ? req.body.type : "text";

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

  let trimmedBody = body.trim();
  const messageType = requestedType;
  if (messageType === "gif") trimmedBody = await storeRemoteGif(trimmedBody, myId);
  const info = await db.execute({
    sql: "INSERT INTO messages (sender_id, recipient_id, body, type, reply_to_id) VALUES (?, ?, ?, ?, ?)",
    args: [myId, recipient.id, trimmedBody, messageType, replyToId],
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
    type: messageType,
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

// Shared by the audio/video DM, group, and global routes below — stores the
// recorded clip as a BLOB the same way `/api/messages/image` stores photos
// (see the `images` table above, which is generic enough to hold any
// mime-typed blob), and hands back the URL to reference it from a message
// row. Served back out through /api/media/:id rather than /api/images/:id
// so a voice or video message URL doesn't read like a photo.
async function storeMediaBlob(mimeType, buffer, uploaderId) {
  const info = await db.execute({
    sql: "INSERT INTO images (mime_type, data, uploaded_by) VALUES (?, ?, ?)",
    args: [mimeType, buffer, uploaderId],
  });
  return "/api/media/" + insertedId(info);
}

// ---- Send a voice message ------------------------------------------------
app.post("/api/messages/audio", requireAuth, (req, res) => {
  uploadAudio.single("audio")(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message || "Upload failed." });
    if (!req.file) return res.status(400).json({ error: "No recording provided." });

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

      const url = await storeMediaBlob(resolveStoredMimeType(req.file.mimetype, req.body && req.body.mimeType, "audio/", "audio/webm"), req.file.buffer, myId);

      const info = await db.execute({
        sql: "INSERT INTO messages (sender_id, recipient_id, body, type) VALUES (?, ?, ?, 'audio')",
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
        type: "audio",
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

// ---- Send a selfie-cam video message -----------------------------------------
app.post("/api/messages/video", requireAuth, (req, res) => {
  uploadVideo.single("video")(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message || "Upload failed." });
    if (!req.file) return res.status(400).json({ error: "No recording provided." });

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

      const url = await storeMediaBlob(resolveStoredMimeType(req.file.mimetype, req.body && req.body.mimeType, "video/", "video/webm"), req.file.buffer, myId);

      const info = await db.execute({
        sql: "INSERT INTO messages (sender_id, recipient_id, body, type) VALUES (?, ?, ?, 'video')",
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
        type: "video",
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

// ---- Group chats ----------------------------------------------------------
async function isGroupMember(groupId, userId) {
  if (!Number.isInteger(groupId)) return false;
  const r = await db.execute({
    sql: "SELECT 1 FROM group_members WHERE group_id = ? AND user_id = ?",
    args: [groupId, userId],
  });
  return r.rows.length > 0;
}

async function getGroupMembers(groupId) {
  const r = await db.execute({
    sql: `SELECT u.id, u.username, u.name_color, u.avatar_image_id
          FROM group_members gm JOIN users u ON u.id = gm.user_id
          WHERE gm.group_id = ?
          ORDER BY u.username COLLATE NOCASE`,
    args: [groupId],
  });
  return r.rows;
}

async function getGroupAvatarUrl(groupId) {
  const r = await db.execute({ sql: "SELECT avatar_image_id FROM group_chats WHERE id = ?", args: [groupId] });
  return avatarUrlFor(r.rows[0]?.avatar_image_id);
}

function groupMemberSummary(members) {
  return members.map((m) => ({
    username: m.username,
    nameColor: m.name_color || null,
    avatarUrl: avatarUrlFor(m.avatar_image_id),
  }));
}

// Sends `event` to every current member's live sockets (all their open
// tabs/devices), optionally skipping one user id — the same pattern DMs use
// for pushing a message straight to the recipient.
async function broadcastToGroup(groupId, event, payload, exceptUserId) {
  const members = await getGroupMembers(groupId);
  for (const m of members) {
    if (exceptUserId != null && m.id === exceptUserId) continue;
    for (const socketId of onlineSockets.get(m.id) || []) {
      io.to(socketId).emit(event, payload);
    }
  }
}

// A lightweight "X added Y" / "X renamed the group" / "X left" line, stored
// as a real row (type 'system') so it sits in history in order like any
// other message, but rendered without a bubble or actions on the client.
async function insertGroupSystemMessage(groupId, actingUserId, body) {
  const info = await db.execute({
    sql: "INSERT INTO group_messages (group_id, sender_id, body, type) VALUES (?, ?, ?, 'system')",
    args: [groupId, actingUserId, body],
  });
  const createdResult = await db.execute({
    sql: "SELECT created_at FROM group_messages WHERE id = ?",
    args: [insertedId(info)],
  });
  return { id: insertedId(info), created_at: createdResult.rows[0].created_at, body };
}

async function broadcastGroupSystemMessage(groupId, actingUserId, body) {
  const sys = await insertGroupSystemMessage(groupId, actingUserId, body);
  await broadcastToGroup(groupId, "group-message", {
    groupId,
    id: sys.id,
    sender: null,
    nameColor: null,
    avatarUrl: null,
    body: sys.body,
    type: "system",
    created_at: sys.created_at,
    reply: null,
  });
}

// ---- Create a group chat ----------------------------------------------------
// Called from the same "message a username" box: separating names with
// commas turns a DM into a group instead. Requires at least two other
// people (one other person is just a DM).
app.post("/api/groups", requireAuth, async (req, res) => {
  const myId = req.session.userId;
  const { usernames } = req.body || {};
  if (!Array.isArray(usernames)) {
    return res.status(400).json({ error: "A list of usernames is required." });
  }
  const wanted = [
    ...new Map(
      usernames
        .map((u) => String(u || "").trim())
        .filter(Boolean)
        .map((u) => [usernameLower(u), u])
    ).values(),
  ].filter((u) => usernameLower(u) !== usernameLower(req.session.username));
  if (wanted.length < 2) {
    return res.status(400).json({ error: "Add at least two other people to start a group." });
  }

  const found = [];
  const missing = [];
  for (const uname of wanted) {
    const u = await getUserByUsername(uname);
    if (u) found.push(u);
    else missing.push(uname);
  }
  if (missing.length) {
    return res.status(404).json({ error: `No user${missing.length > 1 ? "s" : ""} named ${missing.join(", ")}.` });
  }

  const info = await db.execute({
    sql: "INSERT INTO group_chats (name, created_by) VALUES (NULL, ?)",
    args: [myId],
  });
  const groupId = insertedId(info);

  for (const uid of [myId, ...found.map((u) => u.id)]) {
    await db.execute({
      sql: "INSERT OR IGNORE INTO group_members (group_id, user_id) VALUES (?, ?)",
      args: [groupId, uid],
    });
  }

  const members = await getGroupMembers(groupId);
  const payload = { id: groupId, name: null, avatarUrl: null, members: groupMemberSummary(members) };

  // Push the new group into everyone else's sidebar live.
  await broadcastToGroup(groupId, "group-updated", payload, myId);
  await broadcastGroupSystemMessage(groupId, myId, `${req.session.username} started the group.`);

  res.json({ ok: true, group: payload });
});

// One row per group the caller is in, most recently active first, with a
// last-message preview and unread count — mirrors /api/conversations.
app.get("/api/groups", requireAuth, async (req, res) => {
  const myId = req.session.userId;
  const rowsResult = await db.execute({
    sql: `SELECT gc.id, gc.name, gc.avatar_image_id, gm.last_read_at
          FROM group_chats gc JOIN group_members gm ON gm.group_id = gc.id
          WHERE gm.user_id = ?`,
    args: [myId],
  });

  const groups = [];
  for (const row of rowsResult.rows) {
    const members = await getGroupMembers(row.id);
    const lastResult = await db.execute({
      sql: "SELECT body, type, created_at FROM group_messages WHERE group_id = ? ORDER BY created_at DESC, id DESC LIMIT 1",
      args: [row.id],
    });
    const last = lastResult.rows[0] || null;
    const unreadResult = await db.execute({
      sql: row.last_read_at
        ? "SELECT COUNT(*) AS c FROM group_messages WHERE group_id = ? AND sender_id != ? AND type != 'system' AND created_at > ?"
        : "SELECT COUNT(*) AS c FROM group_messages WHERE group_id = ? AND sender_id != ? AND type != 'system'",
      args: row.last_read_at ? [row.id, myId, row.last_read_at] : [row.id, myId],
    });
    groups.push({
      id: row.id,
      name: row.name || null,
      avatarUrl: avatarUrlFor(row.avatar_image_id),
      members: groupMemberSummary(members),
      lastMessage: last ? { body: last.body, type: last.type, created_at: last.created_at } : null,
      unread: Number(unreadResult.rows[0]?.c || 0),
    });
  }

  groups.sort((a, b) => (b.lastMessage?.created_at || "").localeCompare(a.lastMessage?.created_at || ""));
  res.json({ groups });
});

app.get("/api/groups/:id", requireAuth, async (req, res) => {
  const groupId = Number(req.params.id);
  if (!(await isGroupMember(groupId, req.session.userId))) return res.status(404).json({ error: "Group not found." });
  const gResult = await db.execute({ sql: "SELECT id, name, avatar_image_id FROM group_chats WHERE id = ?", args: [groupId] });
  const g = gResult.rows[0];
  if (!g) return res.status(404).json({ error: "Group not found." });
  const members = await getGroupMembers(groupId);
  res.json({ id: g.id, name: g.name || null, avatarUrl: avatarUrlFor(g.avatar_image_id), members: groupMemberSummary(members) });
});

// ---- Rename a group -----------------------------------------------------------
app.patch("/api/groups/:id", requireAuth, async (req, res) => {
  const groupId = Number(req.params.id);
  const myId = req.session.userId;
  if (!(await isGroupMember(groupId, myId))) return res.status(404).json({ error: "Group not found." });

  let { name } = req.body || {};
  if (name != null) {
    name = String(name).trim().slice(0, 60);
    if (!name) name = null;
  }
  await db.execute({ sql: "UPDATE group_chats SET name = ? WHERE id = ?", args: [name, groupId] });

  const members = await getGroupMembers(groupId);
  const avatarUrl = await getGroupAvatarUrl(groupId);
  const payload = { id: groupId, name: name || null, avatarUrl, members: groupMemberSummary(members) };
  await broadcastToGroup(groupId, "group-updated", payload);
  await broadcastGroupSystemMessage(
    groupId,
    myId,
    name ? `${req.session.username} renamed the group to "${name}".` : `${req.session.username} reset the group name.`
  );

  res.json({ ok: true, name: name || null });
});

// ---- Add people to a group -----------------------------------------------------
app.post("/api/groups/:id/members", requireAuth, async (req, res) => {
  const groupId = Number(req.params.id);
  const myId = req.session.userId;
  if (!(await isGroupMember(groupId, myId))) return res.status(404).json({ error: "Group not found." });

  const { usernames } = req.body || {};
  if (!Array.isArray(usernames) || !usernames.length) {
    return res.status(400).json({ error: "At least one username is required." });
  }

  const existing = await getGroupMembers(groupId);
  const existingLower = new Set(existing.map((m) => usernameLower(m.username)));
  const wanted = [...new Set(usernames.map((u) => String(u || "").trim()).filter(Boolean))];

  const added = [];
  const missing = [];
  for (const uname of wanted) {
    if (existingLower.has(usernameLower(uname))) continue;
    const u = await getUserByUsername(uname);
    if (!u) {
      missing.push(uname);
      continue;
    }
    await db.execute({
      sql: "INSERT OR IGNORE INTO group_members (group_id, user_id) VALUES (?, ?)",
      args: [groupId, u.id],
    });
    added.push(u.username);
    existingLower.add(usernameLower(u.username));
  }
  if (missing.length) {
    return res.status(404).json({ error: `No user${missing.length > 1 ? "s" : ""} named ${missing.join(", ")}.` });
  }
  if (!added.length) {
    return res.status(400).json({ error: "Everyone listed is already in this group." });
  }

  const members = await getGroupMembers(groupId);
  const gResult = await db.execute({ sql: "SELECT name, avatar_image_id FROM group_chats WHERE id = ?", args: [groupId] });
  const payload = {
    id: groupId,
    name: gResult.rows[0]?.name || null,
    avatarUrl: avatarUrlFor(gResult.rows[0]?.avatar_image_id),
    members: groupMemberSummary(members),
  };
  await broadcastToGroup(groupId, "group-updated", payload);
  await broadcastGroupSystemMessage(groupId, myId, `${req.session.username} added ${added.join(", ")} to the group.`);

  res.json({ ok: true, added, group: payload });
});

// ---- Change or remove a group's picture ----------------------------------------
// Any current member can set it — same permission level as renaming.
app.post("/api/groups/:id/avatar", requireAuth, (req, res) => {
  upload.single("avatar")(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message || "Upload failed." });
    if (!req.file) return res.status(400).json({ error: "No image provided." });

    try {
      const groupId = Number(req.params.id);
      const myId = req.session.userId;
      if (!(await isGroupMember(groupId, myId))) return res.status(404).json({ error: "Group not found." });

      const imageInfo = await db.execute({
        sql: "INSERT INTO images (mime_type, data, uploaded_by) VALUES (?, ?, ?)",
        args: [req.file.mimetype, req.file.buffer, myId],
      });
      const imageId = insertedId(imageInfo);
      await db.execute({ sql: "UPDATE group_chats SET avatar_image_id = ? WHERE id = ?", args: [imageId, groupId] });

      const members = await getGroupMembers(groupId);
      const gResult = await db.execute({ sql: "SELECT name FROM group_chats WHERE id = ?", args: [groupId] });
      const payload = {
        id: groupId,
        name: gResult.rows[0]?.name || null,
        avatarUrl: avatarUrlFor(imageId),
        members: groupMemberSummary(members),
      };
      await broadcastToGroup(groupId, "group-updated", payload);
      res.json({ ok: true, avatarUrl: payload.avatarUrl, group: payload });
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: "Upload failed." });
    }
  });
});

app.delete("/api/groups/:id/avatar", requireAuth, async (req, res) => {
  const groupId = Number(req.params.id);
  const myId = req.session.userId;
  if (!(await isGroupMember(groupId, myId))) return res.status(404).json({ error: "Group not found." });

  await db.execute({ sql: "UPDATE group_chats SET avatar_image_id = NULL WHERE id = ?", args: [groupId] });
  const members = await getGroupMembers(groupId);
  const gResult = await db.execute({ sql: "SELECT name FROM group_chats WHERE id = ?", args: [groupId] });
  const payload = { id: groupId, name: gResult.rows[0]?.name || null, avatarUrl: null, members: groupMemberSummary(members) };
  await broadcastToGroup(groupId, "group-updated", payload);
  res.json({ ok: true, group: payload });
});

// ---- Leave a group --------------------------------------------------------------
app.post("/api/groups/:id/leave", requireAuth, async (req, res) => {
  const groupId = Number(req.params.id);
  const myId = req.session.userId;
  if (!(await isGroupMember(groupId, myId))) return res.status(404).json({ error: "Group not found." });

  await db.execute({ sql: "DELETE FROM group_members WHERE group_id = ? AND user_id = ?", args: [groupId, myId] });
  const remaining = await getGroupMembers(groupId);

  if (remaining.length === 0) {
    // Nobody left in it — clean the group up entirely rather than leaving
    // an orphaned, invisible group and its messages behind forever.
    await db.execute({ sql: "DELETE FROM group_messages WHERE group_id = ?", args: [groupId] });
    await db.execute({ sql: "DELETE FROM group_chats WHERE id = ?", args: [groupId] });
    return res.json({ ok: true });
  }

  await broadcastToGroup(groupId, "group-member-left", {
    id: groupId,
    username: req.session.username,
    members: groupMemberSummary(remaining),
  });
  await broadcastGroupSystemMessage(groupId, myId, `${req.session.username} left the group.`);

  res.json({ ok: true });
});

// ---- Group message history -------------------------------------------------------
app.get("/api/groups/:id/messages", requireAuth, async (req, res) => {
  const groupId = Number(req.params.id);
  const myId = req.session.userId;
  if (!(await isGroupMember(groupId, myId))) return res.status(404).json({ error: "Group not found." });

  const { rows, hasMore } = await fetchMessagePage({
    selectSql: `SELECT gm.id, gm.sender_id, su.username AS sender, su.name_color, su.avatar_image_id,
                 gm.body, gm.type, gm.created_at, gm.edited_at, gm.reply_to_id,
                 rg.id AS reply_row_id, rg.body AS reply_body, rg.type AS reply_type, ru.username AS reply_sender
          FROM group_messages gm
          LEFT JOIN users su ON su.id = gm.sender_id
          LEFT JOIN group_messages rg ON rg.id = gm.reply_to_id
          LEFT JOIN users ru ON ru.id = rg.sender_id
          WHERE gm.group_id = ?`,
    args: [groupId],
    idExpr: "gm.id",
    before: req.query.before != null ? Number(req.query.before) : null,
    after: req.query.after != null ? Number(req.query.after) : null,
    limit: req.query.limit,
  });

  const messages = rows.map((r) => ({
    id: r.id,
    sender: r.type === "system" ? null : r.sender,
    nameColor: r.name_color || null,
    avatarUrl: avatarUrlFor(r.avatar_image_id),
    body: r.body,
    type: r.type,
    created_at: r.created_at,
    edited: r.edited_at != null,
    mine: r.type !== "system" && r.sender === req.session.username,
    reply: r.reply_to_id
      ? r.reply_row_id == null
        ? { removed: true }
        : { id: r.reply_row_id, body: r.reply_body, type: r.reply_type, sender: r.reply_sender === req.session.username ? "me" : r.reply_sender }
      : null,
  }));
  res.json({ messages, hasMore });
});

app.post("/api/groups/:id/read", requireAuth, async (req, res) => {
  const groupId = Number(req.params.id);
  const myId = req.session.userId;
  if (!(await isGroupMember(groupId, myId))) return res.status(404).json({ error: "Group not found." });
  await db.execute({
    sql: "UPDATE group_members SET last_read_at = datetime('now') WHERE group_id = ? AND user_id = ?",
    args: [groupId, myId],
  });
  res.json({ ok: true });
});

// ---- Send a group message --------------------------------------------------------
app.post("/api/groups/:id/messages", requireAuth, async (req, res) => {
  const groupId = Number(req.params.id);
  const myId = req.session.userId;
  if (!(await isGroupMember(groupId, myId))) return res.status(404).json({ error: "Group not found." });

  const { body, replyTo } = req.body || {};
  const requestedType = ["text", "youtube", "gif"].includes(req.body?.type) ? req.body.type : "text";
  if (typeof body !== "string" || !body.trim()) return res.status(400).json({ error: "A message body is required." });
  if (body.length > 2000) return res.status(400).json({ error: "Messages are limited to 2000 characters." });

  let replyToId = null;
  let replyPreview = null;
  if (replyTo != null) {
    const replyResult = await db.execute({
      sql: `SELECT gm.id, gm.body, gm.type, u.username AS sender
            FROM group_messages gm LEFT JOIN users u ON u.id = gm.sender_id
            WHERE gm.id = ? AND gm.group_id = ?`,
      args: [Number(replyTo), groupId],
    });
    const replied = replyResult.rows[0];
    if (replied) {
      replyToId = replied.id;
      replyPreview = {
        id: replied.id,
        body: replied.body,
        type: replied.type,
        sender: replied.sender === req.session.username ? "me" : replied.sender,
      };
    }
  }

  let trimmedBody = body.trim();
  const messageType = requestedType;
  if (messageType === "gif") trimmedBody = await storeRemoteGif(trimmedBody, myId);
  const info = await db.execute({
    sql: "INSERT INTO group_messages (group_id, sender_id, body, type, reply_to_id) VALUES (?, ?, ?, ?, ?)",
    args: [groupId, myId, trimmedBody, messageType, replyToId],
  });
  const createdResult = await db.execute({ sql: "SELECT created_at FROM group_messages WHERE id = ?", args: [insertedId(info)] });
  const meRow = await getUserByUsername(req.session.username);

  const payload = {
    groupId,
    id: insertedId(info),
    sender: req.session.username,
    nameColor: meRow?.name_color || null,
    avatarUrl: avatarUrlFor(meRow?.avatar_image_id),
    body: trimmedBody,
    type: messageType,
    created_at: createdResult.rows[0].created_at,
    reply: replyPreview,
  };
  await broadcastToGroup(groupId, "group-message", payload, myId);
  res.json({ ok: true, message: payload });
});

async function getOwnedGroupMessage(groupId, id, myId) {
  const result = await db.execute({
    sql: "SELECT id, sender_id, type FROM group_messages WHERE id = ? AND group_id = ?",
    args: [id, groupId],
  });
  const row = result.rows[0];
  if (!row || row.sender_id !== myId) return null;
  return row;
}

app.patch("/api/groups/:id/messages/:msgId", requireAuth, async (req, res) => {
  const groupId = Number(req.params.id);
  const myId = req.session.userId;
  if (!(await isGroupMember(groupId, myId))) return res.status(404).json({ error: "Group not found." });

  const id = Number(req.params.msgId);
  const { body } = req.body || {};
  if (typeof body !== "string" || !body.trim()) return res.status(400).json({ error: "A message body is required." });
  if (body.length > 2000) return res.status(400).json({ error: "Messages are limited to 2000 characters." });

  const msg = await getOwnedGroupMessage(groupId, id, myId);
  if (!msg) return res.status(404).json({ error: "Message not found." });
  if (msg.type !== "text") return res.status(400).json({ error: "Only text messages can be edited." });

  const trimmedBody = body.trim();
  await db.execute({ sql: "UPDATE group_messages SET body = ?, edited_at = datetime('now') WHERE id = ?", args: [trimmedBody, id] });
  await broadcastToGroup(groupId, "group-message-edited", { groupId, id, body: trimmedBody });
  res.json({ ok: true, message: { id, body: trimmedBody } });
});

app.delete("/api/groups/:id/messages/:msgId", requireAuth, async (req, res) => {
  const groupId = Number(req.params.id);
  const myId = req.session.userId;
  if (!(await isGroupMember(groupId, myId))) return res.status(404).json({ error: "Group not found." });

  const id = Number(req.params.msgId);
  const msg = await getOwnedGroupMessage(groupId, id, myId);
  if (!msg) return res.status(404).json({ error: "Message not found." });

  await db.execute({ sql: "DELETE FROM group_messages WHERE id = ?", args: [id] });
  await broadcastToGroup(groupId, "group-message-deleted", { groupId, id });
  res.json({ ok: true, id });
});

// ---- Send a group image message --------------------------------------------------
app.post("/api/groups/:id/messages/image", requireAuth, (req, res) => {
  upload.single("image")(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message || "Upload failed." });
    if (!req.file) return res.status(400).json({ error: "No image provided." });

    const groupId = Number(req.params.id);
    const myId = req.session.userId;
    try {
      if (!(await isGroupMember(groupId, myId))) return res.status(404).json({ error: "Group not found." });

      const imageInfo = await db.execute({
        sql: "INSERT INTO images (mime_type, data, uploaded_by) VALUES (?, ?, ?)",
        args: [req.file.mimetype, req.file.buffer, myId],
      });
      const url = "/api/images/" + insertedId(imageInfo);

      const info = await db.execute({
        sql: "INSERT INTO group_messages (group_id, sender_id, body, type) VALUES (?, ?, ?, 'image')",
        args: [groupId, myId, url],
      });
      const createdResult = await db.execute({ sql: "SELECT created_at FROM group_messages WHERE id = ?", args: [insertedId(info)] });
      const meRow = await getUserByUsername(req.session.username);

      const payload = {
        groupId,
        id: insertedId(info),
        sender: req.session.username,
        nameColor: meRow?.name_color || null,
        avatarUrl: avatarUrlFor(meRow?.avatar_image_id),
        body: url,
        type: "image",
        created_at: createdResult.rows[0].created_at,
        reply: null,
      };
      await broadcastToGroup(groupId, "group-message", payload, myId);
      res.json({ ok: true, message: payload });
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: "Upload failed." });
    }
  });
});

app.post("/api/groups/:id/messages/audio", requireAuth, (req, res) => {
  uploadAudio.single("audio")(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message || "Upload failed." });
    if (!req.file) return res.status(400).json({ error: "No recording provided." });

    const groupId = Number(req.params.id);
    const myId = req.session.userId;
    try {
      if (!(await isGroupMember(groupId, myId))) return res.status(404).json({ error: "Group not found." });

      const url = await storeMediaBlob(resolveStoredMimeType(req.file.mimetype, req.body && req.body.mimeType, "audio/", "audio/webm"), req.file.buffer, myId);

      const info = await db.execute({
        sql: "INSERT INTO group_messages (group_id, sender_id, body, type) VALUES (?, ?, ?, 'audio')",
        args: [groupId, myId, url],
      });
      const createdResult = await db.execute({ sql: "SELECT created_at FROM group_messages WHERE id = ?", args: [insertedId(info)] });
      const meRow = await getUserByUsername(req.session.username);

      const payload = {
        groupId,
        id: insertedId(info),
        sender: req.session.username,
        nameColor: meRow?.name_color || null,
        avatarUrl: avatarUrlFor(meRow?.avatar_image_id),
        body: url,
        type: "audio",
        created_at: createdResult.rows[0].created_at,
        reply: null,
      };
      await broadcastToGroup(groupId, "group-message", payload, myId);
      res.json({ ok: true, message: payload });
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: "Upload failed." });
    }
  });
});

app.post("/api/groups/:id/messages/video", requireAuth, (req, res) => {
  uploadVideo.single("video")(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message || "Upload failed." });
    if (!req.file) return res.status(400).json({ error: "No recording provided." });

    const groupId = Number(req.params.id);
    const myId = req.session.userId;
    try {
      if (!(await isGroupMember(groupId, myId))) return res.status(404).json({ error: "Group not found." });

      const url = await storeMediaBlob(resolveStoredMimeType(req.file.mimetype, req.body && req.body.mimeType, "video/", "video/webm"), req.file.buffer, myId);

      const info = await db.execute({
        sql: "INSERT INTO group_messages (group_id, sender_id, body, type) VALUES (?, ?, ?, 'video')",
        args: [groupId, myId, url],
      });
      const createdResult = await db.execute({ sql: "SELECT created_at FROM group_messages WHERE id = ?", args: [insertedId(info)] });
      const meRow = await getUserByUsername(req.session.username);

      const payload = {
        groupId,
        id: insertedId(info),
        sender: req.session.username,
        nameColor: meRow?.name_color || null,
        avatarUrl: avatarUrlFor(meRow?.avatar_image_id),
        body: url,
        type: "video",
        created_at: createdResult.rows[0].created_at,
        reply: null,
      };
      await broadcastToGroup(groupId, "group-message", payload, myId);
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
//
// History is no longer pruned/deleted server-side. Instead the client keeps
// a sliding window of at most HISTORY_INITIAL_LIMIT messages loaded at a
// time (see fetchMessagePage below and the windowing logic in messages.js),
// paging further back in HISTORY_PAGE_LIMIT-sized chunks as the user scrolls
// up, and unloading the far end of the window as it goes. Same windowing is
// used for DMs and group chats.
const HISTORY_INITIAL_LIMIT = 300; // default page size for the first load of a thread
const HISTORY_PAGE_LIMIT = 200; // default page size for a "load more" scroll page
const HISTORY_MAX_LIMIT = 300; // hard ceiling on whatever limit a client requests

// Fetches one page of messages for a thread (global room, a DM, or a group),
// keyed off a message id cursor instead of offset-based paging so results
// stay stable even as new messages keep arriving.
//   - No cursor: the newest `limit` messages.
//   - `before`: the newest `limit` messages older than that id (scrolling up).
//   - `after`: the oldest `limit` messages newer than that id (scrolling back down).
// Always returns rows in ascending (oldest-first) order, plus `hasMore`
// telling the caller whether there's another page in that direction.
async function fetchMessagePage({ selectSql, args, idExpr, before, after, limit }) {
  const clampedLimit = Math.min(Math.max(Number(limit) || HISTORY_INITIAL_LIMIT, 1), HISTORY_MAX_LIMIT);
  let sql = selectSql;
  const finalArgs = [...args];
  if (before != null && Number.isFinite(before)) {
    sql += ` AND ${idExpr} < ?`;
    finalArgs.push(before);
  } else if (after != null && Number.isFinite(after)) {
    sql += ` AND ${idExpr} > ?`;
    finalArgs.push(after);
  }
  const goingForward = after != null && Number.isFinite(after);
  sql += ` ORDER BY ${idExpr} ${goingForward ? "ASC" : "DESC"} LIMIT ?`;
  finalArgs.push(clampedLimit + 1);

  const result = await db.execute({ sql, args: finalArgs });
  const hasMore = result.rows.length > clampedLimit;
  let rows = hasMore ? result.rows.slice(0, clampedLimit) : result.rows;
  if (!goingForward) rows = rows.reverse(); // newest-first fetch -> oldest-first for display
  return { rows, hasMore };
}

// ---- Global chat archiving --------------------------------------------------
// Anything older than this moves from `global_messages` into
// `global_messages_archive` (see initDb for why). Message ids are assigned
// in insertion order and never reused, and archiving always sweeps the
// oldest rows first, so at any moment every archived id is smaller than
// every id still in the live table — the paging logic below leans on that.
const GLOBAL_ARCHIVE_AFTER_DAYS = 7;
const GLOBAL_ARCHIVE_SWEEP_INTERVAL_MS = 60 * 60 * 1000; // re-check hourly

async function archiveOldGlobalMessages() {
  const cutoffSql = `datetime('now', '-${GLOBAL_ARCHIVE_AFTER_DAYS} days')`;
  const due = await db.execute(`SELECT COUNT(*) AS n FROM global_messages WHERE created_at < ${cutoffSql}`);
  const count = Number(due.rows[0]?.n || 0);
  if (count === 0) return;
  await db.batch(
    [
      `INSERT INTO global_messages_archive (id, sender_id, body, type, created_at, edited_at, reply_to_id)
       SELECT id, sender_id, body, type, created_at, edited_at, reply_to_id
       FROM global_messages WHERE created_at < ${cutoffSql}`,
      `DELETE FROM global_messages WHERE created_at < ${cutoffSql}`,
    ],
    "write"
  );
  console.log(`Archived ${count} global message(s) older than ${GLOBAL_ARCHIVE_AFTER_DAYS} days.`);
}

async function archiveHasAnyRows() {
  const r = await db.execute("SELECT EXISTS(SELECT 1 FROM global_messages_archive) AS has");
  return Boolean(r.rows[0]?.has);
}

// Builds the same shaped SELECT against either the live or archive table.
// Reply lookups check both tables (a live message can reply to one that's
// since been archived), via a small UNION'd subquery.
function globalSelectSql(table) {
  return `SELECT g.id, g.sender_id, u.username AS sender, u.name_color, u.avatar_image_id,
             g.body, g.type, g.created_at, g.edited_at, g.reply_to_id,
             rg.id AS reply_row_id, rg.body AS reply_body, rg.type AS reply_type,
             ru.username AS reply_sender
          FROM ${table} g
          JOIN users u ON u.id = g.sender_id
          LEFT JOIN (
            SELECT id, sender_id, body, type FROM global_messages
            UNION ALL
            SELECT id, sender_id, body, type FROM global_messages_archive
          ) rg ON rg.id = g.reply_to_id
          LEFT JOIN users ru ON ru.id = rg.sender_id
          WHERE 1=1`;
}

// Pages through Global Chat history across the live + archive tables as one
// continuous timeline, so "scroll up forever" keeps working exactly as
// before even once old messages have been archived off.
async function fetchGlobalPage({ before, after, limit }) {
  const clampedLimit = Math.min(Math.max(Number(limit) || HISTORY_INITIAL_LIMIT, 1), HISTORY_MAX_LIMIT);
  const pageFromTable = (table, opts) =>
    fetchMessagePage({ selectSql: globalSelectSql(table), args: [], idExpr: "g.id", limit: clampedLimit, ...opts });

  if (before != null && Number.isFinite(before)) {
    const live = await pageFromTable("global_messages", { before });
    if (live.rows.length >= clampedLimit) {
      return { rows: live.rows, hasMore: live.hasMore || (await archiveHasAnyRows()) };
    }
    const archiveBefore = live.rows.length ? live.rows[0].id : before;
    const archive = await pageFromTable("global_messages_archive", { before: archiveBefore, limit: clampedLimit - live.rows.length });
    return { rows: [...archive.rows, ...live.rows], hasMore: archive.hasMore };
  }

  if (after != null && Number.isFinite(after)) {
    const archive = await pageFromTable("global_messages_archive", { after });
    if (archive.rows.length >= clampedLimit) {
      return { rows: archive.rows, hasMore: true }; // the whole live table is still ahead
    }
    const liveAfter = archive.rows.length ? archive.rows[archive.rows.length - 1].id : after;
    const live = await pageFromTable("global_messages", { after: liveAfter, limit: clampedLimit - archive.rows.length });
    return { rows: [...archive.rows, ...live.rows], hasMore: live.hasMore };
  }

  // No cursor: newest messages. Almost always satisfied entirely by the
  // live table; only a young/quiet room needs archive rows to fill the page.
  const live = await pageFromTable("global_messages", {});
  if (live.rows.length >= clampedLimit) {
    return { rows: live.rows, hasMore: live.hasMore || (await archiveHasAnyRows()) };
  }
  const archiveBefore = live.rows.length ? live.rows[0].id : null;
  const archive = await pageFromTable("global_messages_archive", { before: archiveBefore, limit: clampedLimit - live.rows.length });
  return { rows: [...archive.rows, ...live.rows], hasMore: archive.hasMore };
}

app.get("/api/global/messages", requireAuth, async (req, res) => {
  const { rows, hasMore } = await fetchGlobalPage({
    before: req.query.before != null ? Number(req.query.before) : null,
    after: req.query.after != null ? Number(req.query.after) : null,
    limit: req.query.limit,
  });
  const messages = rows.map((r) => ({
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
  res.json({ messages, hasMore });
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
  const requestedType = ["text", "youtube", "gif"].includes(req.body?.type) ? req.body.type : "text";
  if (typeof body !== "string" || !body.trim()) {
    return res.status(400).json({ error: "A message body is required." });
  }
  if (body.length > 2000) {
    return res.status(400).json({ error: "Messages are limited to 2000 characters." });
  }

  let replyToId = null;
  let replyPreview = null;
  if (replyTo != null) {
    // The message being replied to may have aged into the archive table by
    // now, so check both.
    const replyResult = await db.execute({
      sql: `SELECT g.id, g.body, g.type, u.username AS sender
            FROM (
              SELECT id, sender_id, body, type FROM global_messages
              UNION ALL
              SELECT id, sender_id, body, type FROM global_messages_archive
            ) g JOIN users u ON u.id = g.sender_id
            WHERE g.id = ?`,
      args: [Number(replyTo)],
    });
    const replied = replyResult.rows[0];
    if (replied) {
      replyToId = replied.id;
      replyPreview = { id: replied.id, body: replied.body, type: replied.type, sender: replied.sender };
    }
  }

  let trimmedBody = body.trim();
  const messageType = requestedType;
  if (messageType === "gif") trimmedBody = await storeRemoteGif(trimmedBody, myId);
  const info = await db.execute({
    sql: "INSERT INTO global_messages (sender_id, body, type, reply_to_id) VALUES (?, ?, ?, ?)",
    args: [myId, trimmedBody, messageType, replyToId],
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
    type: messageType,
    created_at: createdResult.rows[0].created_at,
    reply: replyPreview,
  };
  broadcastGlobal(payload, myId);
  res.json({ ok: true, message: payload });
});

// ---- Edit / unsend a global message -------------------------------------------
async function getGlobalMessageForManager(id, myId) {
  const result = await db.execute({
    sql: "SELECT id, sender_id, type FROM global_messages WHERE id = ?",
    args: [id],
  });
  const row = result.rows[0];
  if (!row) return null;
  const meResult = await db.execute({ sql: "SELECT is_admin FROM users WHERE id = ?", args: [myId] });
  const isAdmin = Boolean(meResult.rows[0]?.is_admin);
  if (row.sender_id !== myId && !isAdmin) return null;
  return row;
}

async function getOwnedGlobalMessage(id, myId) {
  const result = await db.execute({
    sql: "SELECT id, sender_id, type FROM global_messages WHERE id = ?",
    args: [id],
  });
  const row = result.rows[0];
  if (!row || row.sender_id !== myId) return null;
  return row;
}

app.post("/api/admin-mode", requireAuth, async (req, res) => {
  const password = req.body?.password;
  if (typeof password !== "string" || password.length !== ADMIN_MODE_PASSWORD.length ||
      !crypto.timingSafeEqual(Buffer.from(password), Buffer.from(ADMIN_MODE_PASSWORD))) {
    return res.status(403).json({ error: "Incorrect admin mode password." });
  }
  await db.execute({ sql: "UPDATE users SET is_admin = 1 WHERE id = ?", args: [req.session.userId] });
  res.json({ ok: true, isAdmin: true });
});

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

  const msg = await getGlobalMessageForManager(id, myId);
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

  const msg = await getGlobalMessageForManager(id, myId);
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

app.post("/api/global/messages/audio", requireAuth, (req, res) => {
  uploadAudio.single("audio")(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message || "Upload failed." });
    if (!req.file) return res.status(400).json({ error: "No recording provided." });

    try {
      const myId = req.session.userId;
      const url = await storeMediaBlob(resolveStoredMimeType(req.file.mimetype, req.body && req.body.mimeType, "audio/", "audio/webm"), req.file.buffer, myId);

      const info = await db.execute({
        sql: "INSERT INTO global_messages (sender_id, body, type) VALUES (?, ?, 'audio')",
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
        type: "audio",
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

app.post("/api/global/messages/video", requireAuth, (req, res) => {
  uploadVideo.single("video")(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message || "Upload failed." });
    if (!req.file) return res.status(400).json({ error: "No recording provided." });

    try {
      const myId = req.session.userId;
      const url = await storeMediaBlob(resolveStoredMimeType(req.file.mimetype, req.body && req.body.mimeType, "video/", "video/webm"), req.file.buffer, myId);

      const info = await db.execute({
        sql: "INSERT INTO global_messages (sender_id, body, type) VALUES (?, ?, 'video')",
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
        type: "video",
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

// Mirrors the client-side EXTENSION_BY_MIME map in messages.js. Used so a
// saved/downloaded clip has a real extension — without one, the OS and other
// apps have no way to tell what the file is, even though the bytes and the
// Content-Type served alongside them are perfectly fine.
const EXTENSION_BY_MIME = {
  "audio/webm": "webm",
  "audio/ogg": "ogg",
  "audio/mp4": "m4a",
  "audio/mpeg": "mp3",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "video/webm": "webm",
  "video/mp4": "mp4",
  "video/x-matroska": "mkv",
  "video/quicktime": "mov",
};

function filenameForMime(mimeType, id) {
  const base = baseMimeType(mimeType);
  const ext = EXTENSION_BY_MIME[base] || base.split("/")[1] || "bin";
  return `media-${id}.${ext}`;
}

// ---- Serve a voice/video clip back out of Turso -------------------------------
// Same shape and reasoning as the image route below — no auth gate, since an
// <audio>/<video> tag's src request can't carry the app's session-aware
// fetch headers.
app.get("/api/media/:id", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(404).end();

  const result = await db.execute({
    sql: "SELECT mime_type, data FROM images WHERE id = ?",
    args: [id],
  });
  const row = result.rows[0];
  if (!row) return res.status(404).end();

  const buffer = Buffer.from(row.data);
  const total = buffer.length;

  res.set("Content-Type", row.mime_type);
  res.set("Accept-Ranges", "bytes");
  res.set("Cache-Control", "private, max-age=31536000, immutable");
  res.set("Content-Disposition", `inline; filename="${filenameForMime(row.mime_type, id)}"`);

  // <audio>/<video> elements probe with a Range request before they'll play
  // anything — Safari and iOS in particular refuse to play at all if the
  // server advertises "Accept-Ranges: bytes" (above) but then ignores the
  // Range header and always sends the whole file back with a plain 200.
  // So a real 206 Partial Content response is required here, not optional.
  const range = req.headers.range;
  if (!range) {
    res.status(200);
    res.set("Content-Length", total);
    return res.send(buffer);
  }

  const match = /^bytes=(\d*)-(\d*)$/.exec(range);
  if (!match) {
    res.status(416).set("Content-Range", `bytes */${total}`).end();
    return;
  }

  let start = match[1] ? parseInt(match[1], 10) : 0;
  let end = match[2] ? parseInt(match[2], 10) : total - 1;
  if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= total) {
    res.status(416).set("Content-Range", `bytes */${total}`).end();
    return;
  }
  end = Math.min(end, total - 1);

  res.status(206);
  res.set("Content-Range", `bytes ${start}-${end}/${total}`);
  res.set("Content-Length", end - start + 1);
  res.send(buffer.subarray(start, end + 1));
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

// ---- Beta: DM voice calls ----------------------------------------------------
// callId -> { callerId, callerUsername, calleeId, calleeUsername, status }
// status is "ringing" until the callee accepts, then "active" until either
// side ends it. userId -> callId lets us quickly tell if someone's already
// on/ringing a call, and clean things up if their socket drops mid-call.
const activeCalls = new Map();
const userCallId = new Map();

function endCall(callId, reason) {
  const call = activeCalls.get(callId);
  if (!call) return;
  activeCalls.delete(callId);
  userCallId.delete(call.callerId);
  userCallId.delete(call.calleeId);
  for (const uid of [call.callerId, call.calleeId]) {
    for (const socketId of onlineSockets.get(uid) || []) {
      io.to(socketId).emit("call:ended", { callId, reason });
    }
  }
}

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
    } else if (scope === "group") {
      const groupId = Number(to);
      if (!Number.isInteger(groupId)) return;
      if (!(await isGroupMember(groupId, userId))) return;
      await broadcastToGroup(groupId, "group-typing", { groupId, username, active: !!active }, userId);
    }
  });

  // ---- Beta: DM voice calls ---------------------------------------------------
  // DM-only by design — there's no group/global equivalent of these events,
  // so a call can never be started from those threads.
  socket.on("call:invite", async ({ to, type } = {}, cb) => {
    if (typeof cb !== "function") return;
    try {
      const callType = type === "video" ? "video" : "voice";
      if (typeof to !== "string" || !to.trim()) return cb({ error: "Invalid request." });
      if (usernameLower(to) === usernameLower(username)) return cb({ error: "You can't call yourself." });

      const target = await getUserByUsername(to);
      if (!target) return cb({ error: "No user with that username." });

      // Voice calls are a regular feature now — only video calls are still
      // gated behind Beta Features, and need both sides opted in.
      if (callType === "video") {
        const meRow = await db.execute({ sql: "SELECT beta_features FROM users WHERE id = ?", args: [userId] });
        if (!meRow.rows[0]?.beta_features) return cb({ error: "Turn on Beta Features in Settings to make video calls." });

        const targetRow = await db.execute({ sql: "SELECT beta_features FROM users WHERE id = ?", args: [target.id] });
        if (!targetRow.rows[0]?.beta_features) {
          return cb({ error: `${target.username} hasn't turned on Beta Features.` });
        }
      }

      const theirRelationToMe = await getRelation(target.id, userId);
      if (theirRelationToMe === "blocked") return cb({ error: "You can't call this user." });

      if (!onlineSockets.has(target.id)) return cb({ error: `${target.username} is offline.` });
      if (userCallId.has(userId)) return cb({ error: "You're already in a call." });
      if (userCallId.has(target.id)) return cb({ error: `${target.username} is already in a call.` });

      const callId = crypto.randomUUID();
      activeCalls.set(callId, {
        callerId: userId,
        callerUsername: username,
        calleeId: target.id,
        calleeUsername: target.username,
        status: "ringing",
        type: callType,
      });
      userCallId.set(userId, callId);
      userCallId.set(target.id, callId);

      for (const socketId of onlineSockets.get(target.id) || []) {
        io.to(socketId).emit("call:incoming", { callId, from: username, type: callType });
      }

      // Missed-call timeout — if nobody answers, tear it down so both sides
      // free up and can call/be called again.
      setTimeout(() => {
        const call = activeCalls.get(callId);
        if (call && call.status === "ringing") endCall(callId, "missed");
      }, 45000);

      cb({ ok: true, callId });
    } catch (e) {
      console.error(e);
      cb({ error: "Call failed to start." });
    }
  });

  socket.on("call:accept", ({ callId }, cb) => {
    const call = activeCalls.get(callId);
    if (!call || call.calleeId !== userId) return cb && cb({ error: "Call not found." });
    call.status = "active";
    for (const socketId of onlineSockets.get(call.callerId) || []) {
      io.to(socketId).emit("call:accepted", { callId });
    }
    cb && cb({ ok: true });
  });

  socket.on("call:decline", ({ callId } = {}) => {
    const call = activeCalls.get(callId);
    if (!call || call.calleeId !== userId) return;
    endCall(callId, "declined");
  });

  socket.on("call:end", ({ callId } = {}) => {
    const call = activeCalls.get(callId);
    if (!call || (call.callerId !== userId && call.calleeId !== userId)) return;
    endCall(callId, "ended");
  });

  // Generic relay for WebRTC offer/answer/ICE candidates — the server never
  // looks inside `data`, it just forwards it to the other side of the call.
  socket.on("call:signal", ({ callId, data } = {}) => {
    const call = activeCalls.get(callId);
    if (!call || (call.callerId !== userId && call.calleeId !== userId)) return;
    const otherId = call.callerId === userId ? call.calleeId : call.callerId;
    for (const socketId of onlineSockets.get(otherId) || []) {
      io.to(socketId).emit("call:signal", { callId, data });
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
      const callId = userCallId.get(userId);
      if (callId) endCall(callId, "disconnected");
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
    // Sweep once at boot, then keep checking hourly — cheap when nothing's
    // due (see the COUNT(*) check at the top of archiveOldGlobalMessages).
    archiveOldGlobalMessages().catch((err) => console.error("Global chat archive sweep failed:", err));
    setInterval(() => {
      archiveOldGlobalMessages().catch((err) => console.error("Global chat archive sweep failed:", err));
    }, GLOBAL_ARCHIVE_SWEEP_INTERVAL_MS);
  })
  .catch((err) => {
    console.error("Failed to initialize database:", err);
    process.exit(1);
  });
