// messages.js — the chat app: conversation list, the global room, opening a
// thread, sending messages/images, the emoji picker, mute/block, read
// receipts, desktop notifications, and receiving things live over the socket.

let me = null;
let activeConversation = null; // { type: "dm", username } | { type: "global" } | null
let conversations = []; // [{username, body, type, created_at}]
const threadCache = new Map(); // username -> messages array
let globalMessages = null; // null until first loaded
let globalPreview = "Say hello to everyone.";
const mutedUsers = new Set();
const blockedUsers = new Set();

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
  globalBtn: document.getElementById("global-chat-btn"),
  globalPreview: document.getElementById("global-chat-preview"),
  notifBanner: document.getElementById("notif-banner"),
  notifEnableBtn: document.getElementById("notif-enable-btn"),
  notifDismissBtn: document.getElementById("notif-dismiss-btn"),
  contextMenu: document.getElementById("conv-menu"),
  menuMuteBtn: document.getElementById("conv-menu-mute"),
  menuBlockBtn: document.getElementById("conv-menu-block"),
};

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

function previewFor(body, type) {
  return type === "image" ? "📷 Photo" : body;
}

function isActiveDm(username) {
  return activeConversation && activeConversation.type === "dm" && activeConversation.username === username;
}

// ---- Conversation list (DMs) -------------------------------------------------
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
    .map((c) => {
      const active = isActiveDm(c.username) ? "active" : "";
      const badge = blockedUsers.has(c.username)
        ? `<span class="relation-badge relation-badge-blocked">Blocked</span>`
        : mutedUsers.has(c.username)
        ? `<span class="relation-badge">Muted</span>`
        : "";
      return `
      <div class="conversation-item ${active}">
        <button class="conv-open" data-username="${escapeHtml(c.username)}">
          <div class="conv-name">${escapeHtml(c.username)} ${badge}</div>
          <div class="conv-preview">${escapeHtml(previewFor(c.body, c.type))}</div>
        </button>
        <button type="button" class="conv-menu-btn" data-username="${escapeHtml(c.username)}" aria-label="Options for ${escapeHtml(c.username)}" aria-haspopup="true">⋮</button>
      </div>`;
    })
    .join("");

  els.convList.querySelectorAll(".conv-open").forEach((btn) => {
    btn.addEventListener("click", () => openThread(btn.dataset.username));
  });
  els.convList.querySelectorAll(".conv-menu-btn").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      openContextMenu(btn.dataset.username, btn);
    });
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

// ---- Mute / block context menu -----------------------------------------------
function openContextMenu(username, anchorEl) {
  els.contextMenu.dataset.target = username;
  els.menuMuteBtn.textContent = mutedUsers.has(username) ? "Unmute" : "Mute";
  els.menuBlockBtn.textContent = blockedUsers.has(username) ? "Unblock" : "Block";

  const rect = anchorEl.getBoundingClientRect();
  els.contextMenu.style.top = rect.bottom + 4 + "px";
  els.contextMenu.style.left = Math.max(8, rect.right - 160) + "px";
  els.contextMenu.classList.remove("is-hidden");
}

function closeContextMenu() {
  els.contextMenu.classList.add("is-hidden");
  delete els.contextMenu.dataset.target;
}

async function setRelation(target, relation) {
  await apiPost("/api/relations", { target, relation });
  if (relation === "muted") {
    mutedUsers.add(target);
    blockedUsers.delete(target);
  } else if (relation === "blocked") {
    blockedUsers.add(target);
    mutedUsers.delete(target);
  } else {
    mutedUsers.delete(target);
    blockedUsers.delete(target);
  }
  renderConversationList();
}

els.menuMuteBtn.addEventListener("click", async () => {
  const target = els.contextMenu.dataset.target;
  closeContextMenu();
  if (!target) return;
  await setRelation(target, mutedUsers.has(target) ? null : "muted");
});

els.menuBlockBtn.addEventListener("click", async () => {
  const target = els.contextMenu.dataset.target;
  closeContextMenu();
  if (!target) return;
  await setRelation(target, blockedUsers.has(target) ? null : "blocked");
});

document.addEventListener("click", (e) => {
  if (els.contextMenu.classList.contains("is-hidden")) return;
  if (els.contextMenu.contains(e.target)) return;
  closeContextMenu();
});

// ---- Opening a DM thread ------------------------------------------------------
async function openThread(username) {
  activeConversation = { type: "dm", username };
  els.emptyState.classList.add("is-hidden");
  els.threadView.classList.remove("is-hidden");
  els.threadTitle.textContent = "@" + username;
  els.sidebar.classList.add("hide-on-mobile");
  els.main.classList.remove("hide-on-mobile");
  els.composerError.textContent = "";
  closeEmojiPanel();
  els.globalBtn.classList.remove("active");
  renderConversationList();

  if (!threadCache.has(username)) {
    const data = await apiGet(`/api/messages/${encodeURIComponent(username)}`);
    threadCache.set(username, data.messages || []);
  }
  renderThread();
  els.composerInput.focus();
  markRead(username);
}

async function markRead(username) {
  try {
    await apiPost(`/api/messages/${encodeURIComponent(username)}/read`, {});
  } catch {
    // Non-critical — worst case the seen-tick just doesn't update this round.
  }
}

// ---- Opening the global room --------------------------------------------------
async function openGlobal() {
  activeConversation = { type: "global" };
  els.emptyState.classList.add("is-hidden");
  els.threadView.classList.remove("is-hidden");
  els.threadTitle.textContent = "🌐 Global Chat";
  els.sidebar.classList.add("hide-on-mobile");
  els.main.classList.remove("hide-on-mobile");
  els.composerError.textContent = "";
  closeEmojiPanel();
  els.globalBtn.classList.add("active");
  renderConversationList();

  if (globalMessages === null) {
    const data = await apiGet("/api/global/messages");
    globalMessages = data.messages || [];
  }
  renderThread();
  els.composerInput.focus();
}

els.globalBtn.addEventListener("click", openGlobal);

// ---- Rendering ------------------------------------------------------------------
function renderBubble(m, isGlobal) {
  const side = m.mine ? "mine" : "theirs";
  const senderLabel = isGlobal && !m.mine ? `<div class="bubble-sender">${escapeHtml(m.sender)}</div>` : "";
  const seen =
    !isGlobal && m.mine
      ? `<div class="seen-indicator">${m.read ? "Seen" : "Sent"}</div>`
      : "";

  if (m.type === "image") {
    return `<div class="bubble-group ${side}">${senderLabel}<div class="bubble bubble-image ${side}"><img src="${escapeHtml(m.body)}" alt="Image message" loading="lazy" /></div>${seen}</div>`;
  }
  return `<div class="bubble-group ${side}">${senderLabel}<div class="bubble ${side}">${escapeHtml(m.body)}</div>${seen}</div>`;
}

function renderThread() {
  const isGlobal = activeConversation && activeConversation.type === "global";
  const messages = isGlobal
    ? globalMessages || []
    : activeConversation
    ? threadCache.get(activeConversation.username) || []
    : [];
  els.thread.innerHTML = messages.map((m) => renderBubble(m, isGlobal)).join("");
  els.thread.scrollTop = els.thread.scrollHeight;
}

function appendMessage(username, body, mine, type = "text") {
  const list = threadCache.get(username) || [];
  list.push({ body, mine, type, created_at: new Date().toISOString(), read: false });
  threadCache.set(username, list);
  if (isActiveDm(username)) renderThread();
}

function appendGlobalMessage(sender, body, mine, type = "text") {
  if (globalMessages === null) globalMessages = [];
  globalMessages.push({ sender, body, mine, type, created_at: new Date().toISOString() });
  globalPreview = previewFor(body, type);
  els.globalPreview.textContent = mine ? `You: ${globalPreview}` : `${sender}: ${globalPreview}`;
  if (activeConversation && activeConversation.type === "global") renderThread();
}

// Swaps a locally-previewed image (a blob: URL shown while uploading) for the
// real hosted URL once the server has it, without re-rendering everything.
function replaceMessageBody(username, oldBody, newBody) {
  const list = threadCache.get(username) || [];
  const msg = [...list].reverse().find((m) => m.body === oldBody && m.mine);
  if (msg) {
    msg.body = newBody;
    if (isActiveDm(username)) renderThread();
  }
}

function replaceGlobalMessageBody(oldBody, newBody) {
  if (!globalMessages) return;
  const msg = [...globalMessages].reverse().find((m) => m.body === oldBody && m.mine);
  if (msg) {
    msg.body = newBody;
    if (activeConversation && activeConversation.type === "global") renderThread();
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
  if (!body || !activeConversation) return;
  els.composerInput.value = "";
  closeEmojiPanel();

  if (activeConversation.type === "global") {
    appendGlobalMessage(me.username, body, true, "text");
    try {
      await apiPost("/api/global/messages", { body });
    } catch (err) {
      appendGlobalMessage(me.username, `Failed to send: ${err.message}`, false, "text");
    }
    return;
  }

  const to = activeConversation.username;
  appendMessage(to, body, true, "text");
  bumpConversationPreview(to, body, "text");
  try {
    await apiPost("/api/messages", { to, body });
  } catch (err) {
    appendMessage(to, `Failed to send: ${err.message}`, false, "text");
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
  if (!activeConversation) {
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
  const isGlobal = activeConversation.type === "global";
  const to = isGlobal ? null : activeConversation.username;

  if (isGlobal) appendGlobalMessage(me.username, previewUrl, true, "image");
  else {
    appendMessage(to, previewUrl, true, "image");
    bumpConversationPreview(to, previewUrl, "image");
  }

  const formData = new FormData();
  if (to) formData.append("to", to);
  formData.append("image", file);

  try {
    const res = await fetch(isGlobal ? "/api/global/messages/image" : "/api/messages/image", {
      method: "POST",
      credentials: "same-origin",
      body: formData,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "Upload failed.");
    if (isGlobal) {
      replaceGlobalMessageBody(previewUrl, data.message.body);
    } else {
      replaceMessageBody(to, previewUrl, data.message.body);
      bumpConversationPreview(to, data.message.body, "image");
    }
  } catch (err) {
    els.composerError.textContent = err.message;
  } finally {
    URL.revokeObjectURL(previewUrl);
  }
}

els.imageBtn.addEventListener("click", () => {
  if (!activeConversation) {
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
  if (activeConversation) els.dropHint.classList.remove("is-hidden");
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

// ---- Desktop notifications ----------------------------------------------------
function updateNotifBanner() {
  const supported = "Notification" in window;
  const shouldShow = supported && Notification.permission === "default";
  els.notifBanner.classList.toggle("is-hidden", !shouldShow);
}

els.notifEnableBtn?.addEventListener("click", async () => {
  try {
    await Notification.requestPermission();
  } catch {
    // Older browsers use the callback form; requestPermission() without a
    // callback still works fine there via its return-value fallback path.
  }
  updateNotifBanner();
});

els.notifDismissBtn?.addEventListener("click", () => {
  els.notifBanner.classList.add("is-hidden");
});

function notifyNewMessage(from, body, type) {
  if (!("Notification" in window)) return;
  if (Notification.permission !== "granted") return;
  if (mutedUsers.has(from) || blockedUsers.has(from)) return;
  // Don't interrupt with a notification for a thread the person is already
  // actively looking at.
  if (isActiveDm(from) && document.hasFocus()) return;

  const n = new Notification(`New message from @${from}`, {
    body: type === "image" ? "📷 Sent a photo" : body,
    tag: `dm-${from}`,
  });
  n.onclick = () => {
    window.focus();
    openThread(from);
  };
}

// ---- Boot --------------------------------------------------------------------
(async () => {
  me = await apiGet("/api/me");
  if (!me.loggedIn) {
    window.location.href = "/login.html";
    return;
  }
  els.whoAmI.textContent = "@" + me.username;

  updateNotifBanner();

  const relations = await apiGet("/api/relations");
  (relations.muted || []).forEach((u) => mutedUsers.add(u));
  (relations.blocked || []).forEach((u) => blockedUsers.add(u));

  await loadConversations();

  const socket = io({ withCredentials: true });

  socket.on("message", ({ from, body, type }) => {
    appendMessage(from, body, false, type || "text");
    bumpConversationPreview(from, body, type || "text");
    notifyNewMessage(from, body, type || "text");
    if (isActiveDm(from) && document.hasFocus()) markRead(from);
  });

  socket.on("global-message", ({ sender, body, type }) => {
    appendGlobalMessage(sender, body, false, type || "text");
  });

  socket.on("message-read", ({ by }) => {
    const list = threadCache.get(by);
    if (!list) return;
    list.forEach((m) => {
      if (m.mine) m.read = true;
    });
    if (isActiveDm(by)) renderThread();
  });
})();
