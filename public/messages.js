// messages.js — the actual chat app: conversation list, opening a thread,
// sending messages/images, the emoji picker, and receiving things live over
// the socket.

let me = null;
let activeUsername = null; // who the open thread is with
let conversations = []; // [{username, body, type, created_at}]
const threadCache = new Map(); // username -> messages array, so switching
                                // conversations doesn't re-fetch every time

const els = {
  whoAmI: document.getElementById("who-am-i"),
  convList: document.getElementById("conversation-list"),
  newForm: document.getElementById("new-message-form"),
  newInput: document.getElementById("new-username"),
  newError: document.getElementById("new-message-error"),
  emptyState: document.getElementById("empty-state"),
  threadView: document.getElementById("thread-view"),
  threadTitle: document.getElementById("thread-title"),
  threadWrap: document.getElementById("thread-wrap"),
  thread: document.getElementById("thread"),
  dropHint: document.getElementById("drop-hint"),
  composer: document.getElementById("composer"),
  composerInput: document.getElementById("composer-input"),
  composerError: document.getElementById("composer-error"),
  emojiBtn: document.getElementById("emoji-btn"),
  emojiPanel: document.getElementById("emoji-panel"),
  emojiSearch: document.getElementById("emoji-search"),
  emojiGrid: document.getElementById("emoji-grid"),
  imageBtn: document.getElementById("image-btn"),
  imageInput: document.getElementById("image-input"),
  sidebar: document.getElementById("sidebar"),
  main: document.getElementById("main"),
  backLink: document.getElementById("back-link"),
  logoutLink: document.getElementById("logout-link"),
};

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

function previewFor(body, type) {
  return type === "image" ? "📷 Photo" : body;
}

async function loadConversations() {
  const data = await apiGet("/api/conversations");
  conversations = data.conversations || [];
  renderConversationList();
}

function renderConversationList() {
  if (conversations.length === 0) {
    els.convList.innerHTML = `<p class="chat-sidebar-empty">No conversations yet — start one above.</p>`;
    return;
  }
  els.convList.innerHTML = conversations
    .map(
      (c) => `
      <button class="conversation-item ${c.username === activeUsername ? "active" : ""}" data-username="${escapeHtml(c.username)}">
        <div class="conv-name">${escapeHtml(c.username)}</div>
        <div class="conv-preview">${escapeHtml(previewFor(c.body, c.type))}</div>
      </button>`
    )
    .join("");

  els.convList.querySelectorAll(".conversation-item").forEach((btn) => {
    btn.addEventListener("click", () => openThread(btn.dataset.username));
  });
}

function bumpConversationPreview(username, body, type) {
  const existing = conversations.find((c) => c.username === username);
  if (existing) {
    existing.body = body;
    existing.type = type;
  } else {
    conversations.unshift({ username, body, type, created_at: new Date().toISOString() });
  }
  conversations.sort((a) => (a.username === username ? -1 : 0));
  renderConversationList();
}

async function openThread(username) {
  activeUsername = username;
  els.emptyState.classList.add("is-hidden");
  els.threadView.classList.remove("is-hidden");
  els.threadTitle.textContent = "@" + username;
  els.sidebar.classList.add("hide-on-mobile");
  els.main.classList.remove("hide-on-mobile");
  els.composerError.textContent = "";
  closeEmojiPanel();
  renderConversationList();

  if (!threadCache.has(username)) {
    const data = await apiGet(`/api/messages/${encodeURIComponent(username)}`);
    threadCache.set(username, data.messages || []);
  }
  renderThread();
  els.composerInput.focus();
}

function renderBubble(m) {
  const side = m.mine ? "mine" : "theirs";
  if (m.type === "image") {
    return `<div class="bubble bubble-image ${side}"><img src="${escapeHtml(m.body)}" alt="Image message" loading="lazy" /></div>`;
  }
  return `<div class="bubble ${side}">${escapeHtml(m.body)}</div>`;
}

function renderThread() {
  const messages = threadCache.get(activeUsername) || [];
  els.thread.innerHTML = messages.map(renderBubble).join("");
  els.thread.scrollTop = els.thread.scrollHeight;
}

function appendMessage(username, body, mine, type = "text") {
  const list = threadCache.get(username) || [];
  list.push({ body, mine, type, created_at: new Date().toISOString() });
  threadCache.set(username, list);
  if (username === activeUsername) renderThread();
}

// Swaps a locally-previewed image (a blob: URL shown while uploading) for the
// real hosted URL once the server has it, without re-rendering everything.
function replaceMessageBody(username, oldBody, newBody) {
  const list = threadCache.get(username) || [];
  const msg = [...list].reverse().find((m) => m.body === oldBody && m.mine);
  if (msg) {
    msg.body = newBody;
    if (username === activeUsername) renderThread();
  }
}

// ---- New message ("type a username, it opens/sends to them") --------------
els.newForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  els.newError.textContent = "";
  const username = els.newInput.value.trim();
  if (!username) return;
  if (username === me.username) {
    els.newError.textContent = "You can't message yourself.";
    return;
  }
  try {
    const check = await apiGet(`/api/users/${encodeURIComponent(username)}`);
    if (check.error) throw new Error(check.error);
  } catch {
    els.newError.textContent = "No user with that username.";
    return;
  }
  els.newInput.value = "";
  if (!threadCache.has(username)) threadCache.set(username, []);
  openThread(username);
});

// ---- Sending a text message in the open thread ------------------------------
els.composer.addEventListener("submit", async (e) => {
  e.preventDefault();
  const body = els.composerInput.value.trim();
  if (!body || !activeUsername) return;
  els.composerInput.value = "";
  closeEmojiPanel();
  appendMessage(activeUsername, body, true, "text");
  bumpConversationPreview(activeUsername, body, "text");
  try {
    await apiPost("/api/messages", { to: activeUsername, body });
  } catch (err) {
    appendMessage(activeUsername, `Failed to send: ${err.message}`, false, "text");
  }
});

// ---- Emoji picker -----------------------------------------------------------
function renderEmojiGrid(query) {
  const q = query.trim().toLowerCase();
  const list = q
    ? EMOJI_DATA.filter((e) => e.keywords.some((k) => k.includes(q)))
    : EMOJI_DATA;

  if (list.length === 0) {
    els.emojiGrid.innerHTML = `<p class="emoji-grid-empty">No emoji found.</p>`;
    return;
  }
  els.emojiGrid.innerHTML = list
    .map((e) => `<button type="button" data-emoji="${e.emoji}">${e.emoji}</button>`)
    .join("");
}

function insertAtCursor(input, text) {
  const start = input.selectionStart ?? input.value.length;
  const end = input.selectionEnd ?? input.value.length;
  input.value = input.value.slice(0, start) + text + input.value.slice(end);
  const cursor = start + text.length;
  input.setSelectionRange(cursor, cursor);
}

function openEmojiPanel() {
  els.emojiPanel.classList.remove("is-hidden");
  els.emojiBtn.classList.add("active");
  els.emojiSearch.value = "";
  renderEmojiGrid("");
  els.emojiSearch.focus();
}

function closeEmojiPanel() {
  els.emojiPanel.classList.add("is-hidden");
  els.emojiBtn.classList.remove("active");
}

els.emojiBtn.addEventListener("click", () => {
  if (els.emojiPanel.classList.contains("is-hidden")) openEmojiPanel();
  else closeEmojiPanel();
});

els.emojiSearch.addEventListener("input", () => {
  renderEmojiGrid(els.emojiSearch.value);
});

els.emojiGrid.addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-emoji]");
  if (!btn) return;
  insertAtCursor(els.composerInput, btn.dataset.emoji);
  els.composerInput.focus();
});

document.addEventListener("click", (e) => {
  if (els.emojiPanel.classList.contains("is-hidden")) return;
  if (els.emojiPanel.contains(e.target) || els.emojiBtn.contains(e.target)) return;
  closeEmojiPanel();
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !els.emojiPanel.classList.contains("is-hidden")) closeEmojiPanel();
});

// ---- Sending an image (button picker or drag-and-drop) ----------------------
const ALLOWED_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

async function sendImage(file) {
  els.composerError.textContent = "";
  if (!activeUsername) {
    els.composerError.textContent = "Open a conversation first.";
    return;
  }
  if (!ALLOWED_IMAGE_TYPES.has(file.type)) {
    els.composerError.textContent = "Only PNG, JPEG, GIF, and WEBP images are supported.";
    return;
  }
  if (file.size > MAX_IMAGE_BYTES) {
    els.composerError.textContent = "Images are limited to 5MB.";
    return;
  }

  const previewUrl = URL.createObjectURL(file);
  const to = activeUsername;
  appendMessage(to, previewUrl, true, "image");
  bumpConversationPreview(to, previewUrl, "image");

  const formData = new FormData();
  formData.append("to", to);
  formData.append("image", file);

  try {
    const res = await fetch("/api/messages/image", {
      method: "POST",
      credentials: "same-origin",
      body: formData,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "Upload failed.");
    replaceMessageBody(to, previewUrl, data.message.body);
    bumpConversationPreview(to, data.message.body, "image");
  } catch (err) {
    els.composerError.textContent = err.message;
  } finally {
    URL.revokeObjectURL(previewUrl);
  }
}

els.imageBtn.addEventListener("click", () => {
  if (!activeUsername) {
    els.composerError.textContent = "Open a conversation first.";
    return;
  }
  els.imageInput.click();
});

els.imageInput.addEventListener("change", () => {
  const file = els.imageInput.files[0];
  els.imageInput.value = ""; // allow picking the same file again later
  if (file) sendImage(file);
});

// Drag-and-drop onto the open thread. Uses an enter/leave counter since
// dragenter/dragleave fire repeatedly as the pointer crosses child elements.
let dragCounter = 0;

els.threadWrap.addEventListener("dragenter", (e) => {
  e.preventDefault();
  dragCounter++;
  if (activeUsername) els.dropHint.classList.remove("is-hidden");
});

els.threadWrap.addEventListener("dragover", (e) => {
  e.preventDefault(); // required for drop to fire
});

els.threadWrap.addEventListener("dragleave", () => {
  dragCounter = Math.max(0, dragCounter - 1);
  if (dragCounter === 0) els.dropHint.classList.add("is-hidden");
});

els.threadWrap.addEventListener("drop", (e) => {
  e.preventDefault();
  dragCounter = 0;
  els.dropHint.classList.add("is-hidden");
  const file = e.dataTransfer.files && e.dataTransfer.files[0];
  if (file) sendImage(file);
});

els.backLink.addEventListener("click", () => {
  els.sidebar.classList.remove("hide-on-mobile");
  els.main.classList.add("hide-on-mobile");
});

els.logoutLink.addEventListener("click", async (e) => {
  e.preventDefault();
  await fetch("/api/logout", { method: "POST", credentials: "same-origin" });
  window.location.href = "/index.html";
});

// ---- Boot --------------------------------------------------------------------
(async () => {
  me = await apiGet("/api/me");
  if (!me.loggedIn) {
    window.location.href = "/login.html";
    return;
  }
  els.whoAmI.textContent = "@" + me.username;
  await loadConversations();

  const socket = io({ withCredentials: true });
  socket.on("message", ({ from, body, type }) => {
    appendMessage(from, body, false, type || "text");
    bumpConversationPreview(from, body, type || "text");
  });
})();
