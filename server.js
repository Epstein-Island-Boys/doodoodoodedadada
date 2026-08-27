import express from "npm:express@^4.19.2";
import session from "npm:express-session@^1.18.0";
import sqlite3 from "npm:sqlite3@^5.1.7";
import bcrypt from "npm:bcryptjs@^2.4.3";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

// Workaround for __dirname in ES Modules/Deno
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

// Database connection
const dbPath = path.join(__dirname, "database.sqlite");
const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error("Database connection error:", err.message);
  } else {
    console.log("Connected to SQLite database.");
  }
});

// Create tables if they don't exist
db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sender_id INTEGER NOT NULL,
      receiver_id INTEGER NOT NULL,
      content TEXT NOT NULL,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (sender_id) REFERENCES users (id),
      FOREIGN KEY (receiver_id) REFERENCES users (id)
    )
  `);
});

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));

app.use(
  session({
    secret: process.env.SESSION_SECRET || "doodoodoodedadada-secret-key",
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false }
  })
);

// Authentication Middleware
function requireAuth(req, res, next) {
  if (req.session && req.session.userId) {
    return next();
  }
  return res.status(401).json({ error: "Unauthorized" });
}

// Routes

// Register
app.post("/api/register", async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: "Username and password required" });
  }

  try {
    const hashedPassword = await bcrypt.hash(password, 10);
    db.run(
      "INSERT INTO users (username, password) VALUES (?, ?)",
      [username, hashedPassword],
      function (err) {
        if (err) {
          if (err.message.includes("UNIQUE constraint failed")) {
            return res.status(400).json({ error: "Username already exists" });
          }
          return res.status(500).json({ error: "Database error" });
        }
        req.session.userId = this.lastID;
        req.session.username = username;
        res.json({ success: true, userId: this.lastID, username });
      }
    );
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

// Login
app.post("/api/login", (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: "Username and password required" });
  }

  db.get(
    "SELECT * FROM users WHERE username = ?",
    [username],
    async (err, user) => {
      if (err) return res.status(500).json({ error: "Database error" });
      if (!user) return res.status(400).json({ error: "Invalid credentials" });

      const match = await bcrypt.compare(password, user.password);
      if (!match) return res.status(400).json({ error: "Invalid credentials" });

      req.session.userId = user.id;
      req.session.username = user.username;
      res.json({ success: true, userId: user.id, username: user.username });
    }
  );
});

// Logout
app.post("/api/logout", (req, res) => {
  req.session.destroy((err) => {
    if (err) return res.status(500).json({ error: "Could not log out" });
    res.json({ success: true });
  });
});

// Get Current User
app.get("/api/me", (req, res) => {
  if (req.session && req.session.userId) {
    res.json({ userId: req.session.userId, username: req.session.username });
  } else {
    res.status(401).json({ error: "Not authenticated" });
  }
});

// Get Users List (for messaging)
app.get("/api/users", requireAuth, (req, res) => {
  db.all(
    "SELECT id, username FROM users WHERE id != ?",
    [req.session.userId],
    (err, rows) => {
      if (err) return res.status(500).json({ error: "Database error" });
      res.json(rows);
    }
  );
});

// Send Message
app.post("/api/messages", requireAuth, (req, res) => {
  const { receiverId, content } = req.body;
  if (!receiverId || !content) {
    return res.status(400).json({ error: "Receiver and content required" });
  }

  db.run(
    "INSERT INTO messages (sender_id, receiver_id, content) VALUES (?, ?, ?)",
    [req.session.userId, receiverId, content],
    function (err) {
      if (err) return res.status(500).json({ error: "Database error" });
      res.json({ success: true, messageId: this.lastID });
    }
  );
});

// Get Conversation Messages
app.get("/api/messages/:otherUserId", requireAuth, (req, res) => {
  const otherUserId = req.params.otherUserId;
  const currentUserId = req.session.userId;

  db.all(
    `SELECT m.id, m.sender_id, m.receiver_id, m.content, m.timestamp, u.username as sender_name
     FROM messages m
     JOIN users u ON m.sender_id = u.id
     WHERE (m.sender_id = ? AND m.receiver_id = ?) 
        OR (m.sender_id = ? AND m.receiver_id = ?)
     ORDER BY m.timestamp ASC`,
    [currentUserId, otherUserId, otherUserId, currentUserId],
    (err, rows) => {
      if (err) return res.status(500).json({ error: "Database error" });
      res.json(rows);
    }
  );
});

// Fallback to serving index.html
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// Start Server
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
