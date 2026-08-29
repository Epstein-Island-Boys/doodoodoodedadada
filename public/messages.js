// messages.js — the chat app: conversation list, the global room, opening a
// thread, sending messages/images (including pasted images), the emoji
// picker, mute/block, read receipts, desktop notifications, replies/edits/
// unsend, hiding a chat from your inbox, typing indicators, presence dots,
// the settings panel (avatar, name color, per-theme background, username,
// password), and receiving all of the above live over the socket.

let me = null;
let activeConversation = null; // { type: "dm", username } | { type: "global" } | null
let conversations = []; // [{username, body, type, created_at, nameColor, avatarUrl, unread}]
const threadCache = new Map(); // username -> messages array
let globalMessages = null; // null until first loaded
let globalPreview = "Say hello to everyone.";
const mutedUsers = new Set();
const blockedUsers = new Set();
let replyingTo = null; // { id, sender, type, body } | null
let editingId = null; // id of the message currently being edited inline
const partnerProfiles = new Map(); // username(lower) -> { avatarUrl, nameColor } — DM messages
// don't carry sender info per-message (unlike global ones), since a DM
// thread only ever has two participants, so we look theirs up once here.
const activeUsernames = new Set(); // usernames currently looking at their tab (lowercased)
const typingUsers = new Map(); // scope key -> Map(username -> timeoutId)

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
  typingIndicator: document.getElementById("typing-indicator"),
  emojiBtn: document.getElementById("emoji-btn"),
  emojiPanel: document.getElementById("emoji-panel"),
  emojiSearch: document.getElementById("emoji-search"),
  emojiGrid: document.getElementById("emoji-grid"),
  imageBtn: document.getElementById("image-btn"),
  imageInput: document.getElementById("image-input"),
  sidebar: document.getElementById("sidebar"),
  main: document.getElementById("main"),
  backLink: document.getElementById("back-link"),
  globalBtn: document.getElementById("global-chat-btn"),
  globalPreview: document.getElementById("global-chat-preview"),
  notifBanner: document.getElementById("notif-banner"),
  notifEnableBtn: document.getElementById("notif-enable-btn"),
  notifDismissBtn: document.getElementById("notif-dismiss-btn"),
  contextMenu: document.getElementById("conv-menu"),
  menuMuteBtn: document.getElementById("conv-menu-mute"),
  menuBlockBtn: document.getElementById("conv-menu-block"),
  menuDeleteBtn: document.getElementById("conv-menu-delete"),
  replyBar: document.getElementById("reply-bar"),
  replyBarName: document.getElementById("reply-bar-name"),
  replyBarPreview: document.getElementById("reply-bar-preview"),
  replyBarCancel: document.getElementById("reply-bar-cancel"),
  lightbox: document.getElementById("lightbox"),
  lightboxImg: document.getElementById("lightbox-img"),
  lightboxClose: document.getElementById("lightbox-close"),
  settingsBtn: document.getElementById("settings-btn"),
  settingsBtnThread: document.getElementById("settings-btn-thread"),
  settingsOverlay: document.getElementById("settings-overlay"),
  settingsModal: document.getElementById("settings-modal"),
  settingsClose: document.getElementById("settings-close"),
  avatarPreview: document.getElementById("avatar-preview"),
  avatarPreviewInitial: document.getElementById("avatar-preview-initial"),
  avatarPreviewImg: document.getElementById("avatar-preview-img"),
  avatarUploadBtn: document.getElementById("avatar-upload-btn"),
  avatarRemoveBtn: document.getElementById("avatar-remove-btn"),
  avatarInput: document.getElementById("avatar-input"),
  avatarError: document.getElementById("avatar-error"),
  lightBgInput: document.getElementById("light-bg-input"),
  lightBgResetBtn: document.getElementById("light-bg-reset-btn"),
  darkBgInput: document.getElementById("dark-bg-input"),
  darkBgResetBtn: document.getElementById("dark-bg-reset-btn"),
  themeError: document.getElementById("theme-error"),
  colorInput: document.getElementById("color-input"),
  colorPreviewName: document.getElementById("color-preview-name"),
  colorResetBtn: document.getElementById("color-reset-btn"),
  colorError: document.getElementById("color-error"),
  usernameForm: document.getElementById("username-form"),
  usernameInput: document.getElementById("username-input"),
  usernameError: document.getElementById("username-error"),
  passwordForm: document.getElementById("password-form"),
  currentPasswordInput: document.getElementById("current-password-input"),
  newPasswordInput: document.getElementById("new-password-input"),
  confirmPasswordInput: document.getElementById("confirm-password-input"),
  passwordError: document.getElementById("password-error"),
  relationsList: document.getElementById("relations-list"),
  logoutBtn: document.getElementById("logout-btn"),
};

const DEFAULT_NAME_COLOR = "#2F3B26";
const DEFAULT_LIGHT_BG = "#F3EFE1";
const DEFAULT_DARK_BG = "#0F1226";

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

function previewFor(body, type) {
  return type === "image" ? "📷 Photo" : body;
}

function isActiveDm(username) {
  return (
    activeConversation &&
    activeConversation.type === "dm" &&
    activeConversation.username.toLowerCase() === username.toLowerCase()
  );
}

function sameUsername(a, b) {
  return String(a || "").toLowerCase() === String(b || "").toLowerCase();
}

// ---- Avatars & presence --------------------------------------------------------
function initialFor(username) {
  return (username || "?").charAt(0).toUpperCase();
}

// Wraps the avatar in a positioning box so a presence dot can sit on its
// corner. `showPresence` is only true for other people's avatars, never
// your own — you always know whether you're looking at your own screen.
function avatarHtml(username, avatarUrl, extraClass = "", showPresence = false) {
  const cls = `avatar ${extraClass}`.trim();
  const inner = avatarUrl
    ? `<span class="${cls}"><img src="${escapeHtml(avatarUrl)}" alt="${escapeHtml(username)}'s avatar" /></span>`
    : `<span class="${cls}">${escapeHtml(initialFor(username))}</span>`;
  if (!showPresence) return inner;
  const dot = activeUsernames.has(String(username).toLowerCase()) ? `<span class="presence-dot"></span>` : "";
  return `<span class="avatar-wrap">${inner}${dot}</span>`;
}

// ---- Conversation list (DMs) -------------------------------------------------
async function loadConversations() {
  const data = await apiGet("/api/conversations");
  conversations = data.conversations || [];
  conversations.forEach((c) => {
    partnerProfiles.set(c.username.toLowerCase(), { avatarUrl: c.avatarUrl, nameColor: c.nameColor });
  });
  renderConversationList();
}

// Fetches (and caches) a DM partner's avatar/color if we don't already have
// it, then re-renders the open thread so their avatar shows up.
async function ensurePartnerProfile(username) {
  const key = username.toLowerCase();
  if (partnerProfiles.has(key)) return;
  try {
    const profile = await apiGet(`/api/users/${encodeURIComponent(username)}`);
    if (profile.error) return;
    partnerProfiles.set(key, { avatarUrl: profile.avatarUrl, nameColor: profile.nameColor });
    if (isActiveDm(username)) renderThread();
  } catch {
    // Non-critical — the avatar just falls back to an initial.
  }
}

function renderConversationList() {
  if (conversations.length === 0) {
    els.convList.innerHTML = `<p class="chat-sidebar-empty">No conversations yet — start one above.</p>`;
    return;
  }
  els.convList.innerHTML = conversations
    .map((c) => {
      const active = isActiveDm(c.username) ? "active" : "";
      const unread = c.unread || 0;
      const hasUnread = unread > 0 && !isActiveDm(c.username);
      const badge = blockedUsers.has(c.username)
        ? `<span class="relation-badge relation-badge-blocked">Blocked</span>`
        : mutedUsers.has(c.username)
        ? `<span class="relation-badge">Muted</span>`
        : "";
      const previewText = hasUnread ? `${unread} new message${unread === 1 ? "" : "s"}` : previewFor(c.body, c.type);
      return `
      <div class="conversation-item ${active} ${hasUnread ? "has-unread" : ""}">
        <button class="conv-open" data-username="${escapeHtml(c.username)}">
          ${avatarHtml(c.username, c.avatarUrl, "", true)}
          <div class="conv-open-text">
            <div class="conv-name">${escapeHtml(c.username)} ${badge}</div>
            <div class="conv-preview">${escapeHtml(previewText)}</div>
          </div>
          ${hasUnread ? `<span class="unread-badge">${unread > 99 ? "99+" : unread}</span>` : ""}
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

function bumpConversationPreview(username, body, type, extra = {}) {
  const existing = conversations.find((c) => sameUsername(c.username, username));
  if (existing) {
    existing.body = body;
    existing.type = type;
    if (extra.incrementUnread) existing.unread = (existing.unread || 0) + 1;
  } else {
    conversations.unshift({
      username,
      body,
      type,
      created_at: new Date().toISOString(),
      nameColor: extra.nameColor || null,
      avatarUrl: extra.avatarUrl || null,
      unread: extra.incrementUnread ? 1 : 0,
    });
  }
  conversations.sort((a) => (sameUsername(a.username, username) ? -1 : 0));
  renderConversationList();
}

function clearUnread(username) {
  const existing = conversations.find((c) => sameUsername(c.username, username));
  if (existing && existing.unread) {
    existing.unread = 0;
    renderConversationList();
  }
}

// ---- Mute / block / delete-chat context menu ---------------------------------
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
  renderRelationsList();
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

// Hides the chat from the inbox only — message history is untouched on the
// server, and the chat comes back automatically the moment either person
// sends a new message.
els.menuDeleteBtn?.addEventListener("click", async () => {
  const target = els.contextMenu.dataset.target;
  closeContextMenu();
  if (!target) return;
  if (!window.confirm(`Delete your chat with ${target}? This just hides it from your inbox — it comes back if either of you messages again.`)) return;
  try {
    await apiDelete(`/api/conversations/${encodeURIComponent(target)}`);
    conversations = conversations.filter((c) => !sameUsername(c.username, target));
    renderConversationList();
    if (isActiveDm(target)) {
      activeConversation = null;
      els.threadView.classList.add("is-hidden");
      els.emptyState.classList.remove("is-hidden");
    }
  } catch (err) {
    els.newError.textContent = err.message;
  }
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
  cancelReply();
  closeEmojiPanel();
  els.globalBtn.classList.remove("active");
  renderConversationList();
  renderTypingIndicator();

  if (!threadCache.has(username)) {
    const data = await apiGet(`/api/messages/${encodeURIComponent(username)}`);
    threadCache.set(username, data.messages || []);
  }
  ensurePartnerProfile(username);
  renderThread();
  els.composerInput.focus();
  markRead(username);
}

async function markRead(username) {
  clearUnread(username);
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
  cancelReply();
  closeEmojiPanel();
  els.globalBtn.classList.add("active");
  renderConversationList();
  renderTypingIndicator();

  if (globalMessages === null) {
    const data = await apiGet("/api/global/messages");
    globalMessages = data.messages || [];
  }
  renderThread();
  els.composerInput.focus();
}

els.globalBtn.addEventListener("click", openGlobal);

// ---- Rendering ------------------------------------------------------------------
function replySnippetText(reply) {
  if (!reply) return "";
  if (reply.removed) return "Original message removed";
  return reply.type === "image" ? "📷 Photo" : reply.body;
}

function renderReplyQuote(reply) {
  if (!reply) return "";
  if (reply.removed) {
    return `<div class="reply-quote reply-quote-removed">Original message removed</div>`;
  }
  const label = reply.sender === "me" ? "You" : reply.sender;
  return `<button type="button" class="reply-quote" data-jump-to="${reply.id}"><span class="reply-quote-name">${escapeHtml(label)}</span>${escapeHtml(replySnippetText(reply))}</button>`;
}

function renderBubble(m, isGlobal) {
  const side = m.mine ? "mine" : "theirs";
  let avatarUrl = null;
  if (!m.mine) {
    if (isGlobal) {
      avatarUrl = m.avatarUrl;
    } else {
      avatarUrl = (partnerProfiles.get(activeConversation.username.toLowerCase()) || {}).avatarUrl;
    }
  }
  const avatarOwner = isGlobal ? m.sender : activeConversation.username;
  const avatar = !m.mine ? avatarHtml(avatarOwner, avatarUrl, "avatar-sm", true) : "";
  const nameStyle = isGlobal && m.nameColor ? ` style="color:${escapeHtml(m.nameColor)}"` : "";
  const senderLabel =
    isGlobal && !m.mine ? `<div class="bubble-sender-row">${avatar}<div class="bubble-sender"${nameStyle}>${escapeHtml(m.sender)}</div></div>` : "";
  const seen = !isGlobal && m.mine ? `<div class="seen-indicator">${m.read ? "Seen" : "Sent"}</div>` : "";
  const editedTag = m.edited ? `<span class="edited-tag">(edited)</span>` : "";
  const replyQuote = renderReplyQuote(m.reply);

  const canManage = m.mine;
  const actions = `<div class="bubble-actions">
      <button type="button" class="bubble-action-btn" data-action="reply" title="Reply">↩</button>
      ${canManage && m.type === "text" ? `<button type="button" class="bubble-action-btn" data-action="edit" title="Edit">✎</button>` : ""}
      ${canManage ? `<button type="button" class="bubble-action-btn" data-action="delete" title="Unsend">🗑</button>` : ""}
    </div>`;

  let bubbleInner;
  if (m.type === "image") {
    bubbleInner = `<div class="bubble bubble-image ${side}">${replyQuote}<img src="${escapeHtml(m.body)}" alt="Image message" loading="lazy" /></div>`;
  } else {
    bubbleInner = `<div class="bubble ${side}">${replyQuote}${escapeHtml(m.body)}</div>`;
  }

  return `<div class="bubble-group ${side}" data-id="${m.id ?? ""}">
    ${senderLabel}
    <div class="bubble-row">${bubbleInner}${actions}</div>
    <div class="bubble-meta-row">${editedTag}${seen}</div>
  </div>`;
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

function appendMessage(username, body, mine, type = "text", extra = {}) {
  const list = threadCache.get(username) || [];
  list.push({
    id: extra.id ?? null,
    body,
    mine,
    type,
    created_at: new Date().toISOString(),
    read: false,
    edited: false,
    reply: extra.reply || null,
  });
  threadCache.set(username, list);
  if (isActiveDm(username)) renderThread();
}

function appendGlobalMessage(sender, body, mine, type = "text", extra = {}) {
  if (globalMessages === null) globalMessages = [];
  globalMessages.push({
    id: extra.id ?? null,
    sender,
    nameColor: extra.nameColor || null,
    avatarUrl: extra.avatarUrl || null,
    body,
    mine,
    type,
    created_at: new Date().toISOString(),
    edited: false,
    reply: extra.reply || null,
  });
  globalPreview = previewFor(body, type);
  els.globalPreview.textContent = mine ? `You: ${globalPreview}` : `${sender}: ${globalPreview}`;
  if (activeConversation && activeConversation.type === "global") renderThread();
}

// Swaps a locally-previewed image (a blob: URL shown while uploading) for the
// real hosted URL once the server has it, without re-rendering everything.
function replaceMessageBody(username, oldBody, newBody, id) {
  const list = threadCache.get(username) || [];
  const msg = [...list].reverse().find((m) => m.body === oldBody && m.mine);
  if (msg) {
    msg.body = newBody;
    if (id != null) msg.id = id;
    if (isActiveDm(username)) renderThread();
  }
}

function replaceGlobalMessageBody(oldBody, newBody, id) {
  if (!globalMessages) return;
  const msg = [...globalMessages].reverse().find((m) => m.body === oldBody && m.mine);
  if (msg) {
    msg.body = newBody;
    if (id != null) msg.id = id;
    if (activeConversation && activeConversation.type === "global") renderThread();
  }
}

// ---- Reply / edit / unsend ---------------------------------------------------
function setReplyBar(reply) {
  replyingTo = reply;
  if (!reply) {
    els.replyBar.classList.add("is-hidden");
    return;
  }
  const label = reply.sender === "me" ? "yourself" : reply.sender;
  els.replyBarName.textContent = label;
  els.replyBarPreview.textContent = replySnippetText(reply);
  els.replyBar.classList.remove("is-hidden");
}

function cancelReply() {
  setReplyBar(null);
}

els.replyBarCancel.addEventListener("click", cancelReply);

function findMessageById(id) {
  const isGlobal = activeConversation && activeConversation.type === "global";
  const list = isGlobal
    ? globalMessages || []
    : activeConversation
    ? threadCache.get(activeConversation.username) || []
    : [];
  return list.find((m) => String(m.id) === String(id));
}

// Removes a message from whichever local list holds it, by id. Used both
// for our own unsends and for the "message-deleted" events that arrive when
// the *other* person unsends something in a thread we have cached.
function removeMessageEverywhere(id) {
  for (const [, list] of threadCache) {
    const idx = list.findIndex((m) => String(m.id) === String(id));
    if (idx !== -1) {
      list.splice(idx, 1);
      return true;
    }
  }
  return false;
}

function removeGlobalMessage(id) {
  if (!globalMessages) return false;
  const idx = globalMessages.findIndex((m) => String(m.id) === String(id));
  if (idx !== -1) {
    globalMessages.splice(idx, 1);
    return true;
  }
  return false;
}

async function deleteMessage(id) {
  const isGlobal = activeConversation && activeConversation.type === "global";
  if (!window.confirm("Unsend this message? It will be removed for everyone.")) return;
  try {
    if (isGlobal) {
      await apiDelete(`/api/global/messages/${id}`);
      removeGlobalMessage(id);
    } else {
      await apiDelete(`/api/messages/${id}`);
      removeMessageEverywhere(id);
    }
    renderThread();
  } catch (err) {
    els.composerError.textContent = err.message;
  }
}

function startEdit(id) {
  const msg = findMessageById(id);
  if (!msg || msg.type !== "text") return;
  editingId = id;
  renderThread();
  const group = els.thread.querySelector(`.bubble-group[data-id="${id}"]`);
  const bubble = group?.querySelector(".bubble");
  if (!bubble) return;
  bubble.innerHTML = `
    <form class="bubble-edit-form" data-edit-id="${id}">
      <input type="text" value="${escapeHtml(msg.body)}" maxlength="2000" />
      <button type="submit">Save</button>
      <button type="button" data-cancel-edit="1">✕</button>
    </form>`;
  const input = bubble.querySelector("input");
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);
}

async function saveEdit(id, newBody) {
  const isGlobal = activeConversation && activeConversation.type === "global";
  const trimmed = newBody.trim();
  if (!trimmed) return;
  try {
    if (isGlobal) {
      await apiPatch(`/api/global/messages/${id}`, { body: trimmed });
    } else {
      await apiPatch(`/api/messages/${id}`, { body: trimmed });
    }
    const msg = findMessageById(id);
    if (msg) {
      msg.body = trimmed;
      msg.edited = true;
    }
    editingId = null;
    renderThread();
  } catch (err) {
    els.composerError.textContent = err.message;
  }
}

els.thread.addEventListener("click", (e) => {
  const jumpBtn = e.target.closest("[data-jump-to]");
  if (jumpBtn) {
    const target = els.thread.querySelector(`.bubble-group[data-id="${jumpBtn.dataset.jumpTo}"]`);
    if (target) target.scrollIntoView({ behavior: "smooth", block: "center" });
    return;
  }

  const cancelBtn = e.target.closest("[data-cancel-edit]");
  if (cancelBtn) {
    editingId = null;
    renderThread();
    return;
  }

  const actionBtn = e.target.closest(".bubble-action-btn");
  if (actionBtn) {
    const group = actionBtn.closest(".bubble-group");
    const id = group?.dataset.id;
    if (!id) return;
    const msg = findMessageById(id);
    if (!msg) return;
    const action = actionBtn.dataset.action;
    if (action === "reply") {
      const isGlobal = activeConversation && activeConversation.type === "global";
      setReplyBar({
        id: msg.id,
        sender: msg.mine ? "me" : isGlobal ? msg.sender : activeConversation.username,
        type: msg.type,
        body: msg.body,
      });
      els.composerInput.focus();
    } else if (action === "edit") {
      startEdit(id);
    } else if (action === "delete") {
      deleteMessage(id);
    }
    return;
  }

  const img = e.target.closest(".bubble-image img");
  if (img) {
    openLightbox(img.src);
  }
});

els.thread.addEventListener("submit", (e) => {
  const form = e.target.closest(".bubble-edit-form");
  if (!form) return;
  e.preventDefault();
  const id = form.dataset.editId;
  const value = form.querySelector("input").value;
  saveEdit(id, value);
});

// ---- Image lightbox -----------------------------------------------------------
function openLightbox(src) {
  els.lightboxImg.src = src;
  els.lightbox.classList.remove("is-hidden");
}

function closeLightbox() {
  els.lightbox.classList.add("is-hidden");
  els.lightboxImg.src = "";
}

els.lightboxClose.addEventListener("click", closeLightbox);
els.lightbox.addEventListener("click", (e) => {
  if (e.target === els.lightbox) closeLightbox();
});

// ---- New message ("type a username, it opens/sends to them") --------------
els.newForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  els.newError.textContent = "";
  const username = els.newInput.value.trim();
  if (!username) return;
  if (sameUsername(username, me.username)) {
    els.newError.textContent = "You can't message yourself.";
    return;
  }
  let canonicalUsername = username;
  try {
    const check = await apiGet(`/api/users/${encodeURIComponent(username)}`);
    if (check.error) throw new Error(check.error);
    canonicalUsername = check.username;
  } catch {
    els.newError.textContent = "No user with that username.";
    return;
  }
  els.newInput.value = "";
  if (!threadCache.has(canonicalUsername)) threadCache.set(canonicalUsername, []);
  openThread(canonicalUsername);
});

// ---- Sending a text message in the open thread ------------------------------
els.composer.addEventListener("submit", async (e) => {
  e.preventDefault();
  const body = els.composerInput.value.trim();
  if (!body || !activeConversation) return;
  els.composerInput.value = "";
  closeEmojiPanel();
  sendTypingPing(false);
  const reply = replyingTo;
  const replyPayload = reply ? { id: reply.id, body: reply.body, type: reply.type, sender: reply.sender } : null;
  cancelReply();

  if (activeConversation.type === "global") {
    appendGlobalMessage(me.username, body, true, "text", {
      nameColor: me.nameColor,
      avatarUrl: me.avatarUrl,
      reply: replyPayload,
    });
    try {
      const res = await apiPost("/api/global/messages", { body, replyTo: reply ? reply.id : undefined });
      replaceGlobalMessageBody(body, res.message.body, res.message.id);
    } catch (err) {
      appendGlobalMessage(me.username, `Failed to send: ${err.message}`, false, "text");
    }
    return;
  }

  const to = activeConversation.username;
  appendMessage(to, body, true, "text", { reply: replyPayload });
  bumpConversationPreview(to, body, "text");
  try {
    const res = await apiPost("/api/messages", { to, body, replyTo: reply ? reply.id : undefined });
    replaceMessageBody(to, body, res.message.body, res.message.id);
  } catch (err) {
    appendMessage(to, `Failed to send: ${err.message}`, false, "text");
  }
});

// ---- Typing indicator ---------------------------------------------------------
// Sends a throttled "I'm typing" ping to whoever's on the other end, and
// automatically expires it after a few seconds of silence so a dropped
// connection or closed tab doesn't leave a stale "is typing…" behind.
let socketRef = null;
let lastTypingPingAt = 0;
const TYPING_THROTTLE_MS = 2000;
const TYPING_EXPIRE_MS = 4000;

function sendTypingPing(active) {
  if (!socketRef || !activeConversation) return;
  const now = Date.now();
  if (active && now - lastTypingPingAt < TYPING_THROTTLE_MS) return;
  lastTypingPingAt = active ? now : 0;
  if (activeConversation.type === "global") {
    socketRef.emit("typing", { scope: "global", active });
  } else {
    socketRef.emit("typing", { scope: "dm", to: activeConversation.username, active });
  }
}

els.composerInput.addEventListener("input", () => {
  sendTypingPing(els.composerInput.value.trim().length > 0);
});

function typingKeyFor(scope, from) {
  return scope === "global" ? "global" : `dm:${from.toLowerCase()}`;
}

function noteTyping(scope, from, active) {
  // Only worth showing if we're actually looking at that conversation.
  const isGlobal = scope === "global";
  const relevant = isGlobal
    ? activeConversation && activeConversation.type === "global"
    : isActiveDm(from);

  const key = typingKeyFor(scope, from);
  if (!typingUsers.has(key)) typingUsers.set(key, new Map());
  const bucket = typingUsers.get(key);

  if (bucket.has(from)) {
    clearTimeout(bucket.get(from));
    bucket.delete(from);
  }

  if (active) {
    const timeoutId = setTimeout(() => {
      bucket.delete(from);
      if (relevant) renderTypingIndicator();
    }, TYPING_EXPIRE_MS);
    bucket.set(from, timeoutId);
  }

  if (relevant) renderTypingIndicator();
}

function renderTypingIndicator() {
  if (!els.typingIndicator) return;
  const isGlobal = activeConversation && activeConversation.type === "global";
  const key = isGlobal ? "global" : activeConversation ? typingKeyFor("dm", activeConversation.username) : null;
  const bucket = key ? typingUsers.get(key) : null;
  const names = bucket ? [...bucket.keys()] : [];

  if (names.length === 0) {
    els.typingIndicator.textContent = "";
    els.typingIndicator.classList.add("is-hidden");
    return;
  }
  let text;
  if (names.length === 1) text = `${names[0]} is typing…`;
  else if (names.length === 2) text = `${names[0]} and ${names[1]} are typing…`;
  else text = `${names.length} people are typing…`;
  els.typingIndicator.textContent = text;
  els.typingIndicator.classList.remove("is-hidden");
}

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
  if (e.key !== "Escape") return;
  if (!els.emojiPanel.classList.contains("is-hidden")) closeEmojiPanel();
  if (!els.lightbox.classList.contains("is-hidden")) closeLightbox();
  if (!els.settingsOverlay.classList.contains("is-hidden")) closeSettings();
  if (replyingTo) cancelReply();
});

// ---- Sending an image (button picker, drag-and-drop, or paste) --------------
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

  if (isGlobal) appendGlobalMessage(me.username, previewUrl, true, "image", { nameColor: me.nameColor, avatarUrl: me.avatarUrl });
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
      replaceGlobalMessageBody(previewUrl, data.message.body, data.message.id);
    } else {
      replaceMessageBody(to, previewUrl, data.message.body, data.message.id);
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

// Pasting an image (e.g. "Copy image" from a browser, or a screenshot) into
// the composer sends it the same way a picked or dropped file would.
els.composerInput.addEventListener("paste", (e) => {
  const items = e.clipboardData && e.clipboardData.items;
  if (!items) return;
  for (const item of items) {
    if (item.kind === "file" && item.type && item.type.startsWith("image/")) {
      const file = item.getAsFile();
      if (file) {
        e.preventDefault();
        sendImage(file);
      }
      break;
    }
  }
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

// ---- Settings panel -----------------------------------------------------------
function applyMeToSettingsUI() {
  els.usernameInput.value = "";
  els.usernameInput.placeholder = me.username;

  if (me.avatarUrl) {
    els.avatarPreviewImg.src = me.avatarUrl;
    els.avatarPreviewImg.classList.remove("is-hidden");
    els.avatarPreviewInitial.classList.add("is-hidden");
  } else {
    els.avatarPreviewImg.classList.add("is-hidden");
    els.avatarPreviewInitial.classList.remove("is-hidden");
    els.avatarPreviewInitial.textContent = initialFor(me.username);
  }

  els.colorInput.value = me.nameColor || DEFAULT_NAME_COLOR;
  els.colorPreviewName.style.color = me.nameColor || "var(--forest)";
  els.colorPreviewName.textContent = me.username;

  if (els.lightBgInput) els.lightBgInput.value = me.themeLightBg || DEFAULT_LIGHT_BG;
  if (els.darkBgInput) els.darkBgInput.value = me.themeDarkBg || DEFAULT_DARK_BG;
}

// Applies the person's custom background for whichever theme is active
// right now. Called on boot and whenever the theme is toggled or a custom
// color is saved.
function applyCustomBackground() {
  const isDark = document.documentElement.getAttribute("data-theme") === "dark";
  const color = isDark ? me?.themeDarkBg : me?.themeLightBg;
  if (color) {
    document.documentElement.style.setProperty("--paper", color);
  } else {
    document.documentElement.style.removeProperty("--paper");
  }
}

// theme.js defines a global setTheme() that the dark-mode toggle button
// calls. Wrapping it lets us reapply the person's custom background right
// after the theme actually switches, without duplicating theme.js's logic.
if (typeof window.setTheme === "function") {
  const originalSetTheme = window.setTheme;
  window.setTheme = function (theme) {
    originalSetTheme(theme);
    applyCustomBackground();
  };
}

function renderRelationsList() {
  const rows = [];
  blockedUsers.forEach((u) => rows.push({ username: u, relation: "blocked" }));
  mutedUsers.forEach((u) => {
    if (!blockedUsers.has(u)) rows.push({ username: u, relation: "muted" });
  });

  if (rows.length === 0) {
    els.relationsList.innerHTML = `<p class="settings-hint">Nobody muted or blocked yet.</p>`;
    return;
  }

  els.relationsList.innerHTML = rows
    .map(
      (r) => `
    <div class="relations-list-item">
      <span>${escapeHtml(r.username)} <span class="relation-badge ${r.relation === "blocked" ? "relation-badge-blocked" : ""}">${r.relation}</span></span>
      <button type="button" data-unset="${escapeHtml(r.username)}">Undo</button>
    </div>`
    )
    .join("");

  els.relationsList.querySelectorAll("[data-unset]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      await setRelation(btn.dataset.unset, null);
    });
  });
}

function openSettings() {
  applyMeToSettingsUI();
  renderRelationsList();
  els.avatarError.textContent = "";
  els.colorError.textContent = "";
  if (els.themeError) els.themeError.textContent = "";
  els.usernameError.textContent = "";
  els.passwordError.textContent = "";
  els.settingsOverlay.classList.remove("is-hidden");
}

function closeSettings() {
  els.settingsOverlay.classList.add("is-hidden");
}

els.settingsBtn?.addEventListener("click", openSettings);
els.settingsBtnThread?.addEventListener("click", openSettings);
els.settingsClose.addEventListener("click", closeSettings);
els.settingsOverlay.addEventListener("click", (e) => {
  if (e.target === els.settingsOverlay) closeSettings();
});

els.avatarUploadBtn.addEventListener("click", () => els.avatarInput.click());

els.avatarInput.addEventListener("change", async () => {
  const file = els.avatarInput.files[0];
  els.avatarInput.value = "";
  if (!file) return;
  els.avatarError.textContent = "";
  if (!ALLOWED_IMAGE_TYPES.has(file.type)) {
    els.avatarError.textContent = "Only PNG, JPEG, GIF, and WEBP images are supported.";
    return;
  }
  if (file.size > MAX_IMAGE_BYTES) {
    els.avatarError.textContent = "Images are limited to 5MB.";
    return;
  }
  const formData = new FormData();
  formData.append("avatar", file);
  try {
    const res = await fetch("/api/account/avatar", { method: "POST", credentials: "same-origin", body: formData });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "Upload failed.");
    me.avatarUrl = data.avatarUrl;
    applyMeToSettingsUI();
  } catch (err) {
    els.avatarError.textContent = err.message;
  }
});

els.avatarRemoveBtn.addEventListener("click", async () => {
  els.avatarError.textContent = "";
  try {
    await apiDelete("/api/account/avatar");
    me.avatarUrl = null;
    applyMeToSettingsUI();
  } catch (err) {
    els.avatarError.textContent = err.message;
  }
});

async function saveColor(color) {
  els.colorError.textContent = "";
  try {
    const res = await apiPost("/api/account/color", { color });
    me.nameColor = res.color;
    applyMeToSettingsUI();
  } catch (err) {
    els.colorError.textContent = err.message;
  }
}

els.colorInput.addEventListener("change", () => saveColor(els.colorInput.value));
els.colorResetBtn.addEventListener("click", () => saveColor(null));

async function saveThemeBg(field, color) {
  if (!els.themeError) return;
  els.themeError.textContent = "";
  try {
    const res = await apiPost("/api/account/theme", { field, color });
    if (field === "light") me.themeLightBg = res.color;
    else me.themeDarkBg = res.color;
    applyMeToSettingsUI();
    applyCustomBackground();
  } catch (err) {
    els.themeError.textContent = err.message;
  }
}

els.lightBgInput?.addEventListener("change", () => saveThemeBg("light", els.lightBgInput.value));
els.lightBgResetBtn?.addEventListener("click", () => saveThemeBg("light", null));
els.darkBgInput?.addEventListener("change", () => saveThemeBg("dark", els.darkBgInput.value));
els.darkBgResetBtn?.addEventListener("click", () => saveThemeBg("dark", null));

els.usernameForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  els.usernameError.textContent = "";
  const value = els.usernameInput.value.trim();
  if (!value) return;
  try {
    const res = await apiPost("/api/account/username", { username: value });
    me.username = res.username;
    els.whoAmI.textContent = "@" + me.username;
    applyMeToSettingsUI();
  } catch (err) {
    els.usernameError.textContent = err.message;
  }
});

els.passwordForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  els.passwordError.textContent = "";
  const currentPassword = els.currentPasswordInput.value;
  const newPassword = els.newPasswordInput.value;
  const confirmPassword = els.confirmPasswordInput.value;
  if (newPassword !== confirmPassword) {
    els.passwordError.textContent = "New passwords don't match.";
    return;
  }
  try {
    await apiPost("/api/account/password", { currentPassword, newPassword });
    els.currentPasswordInput.value = "";
    els.newPasswordInput.value = "";
    els.confirmPasswordInput.value = "";
    els.passwordError.textContent = "Password updated.";
    els.passwordError.style.color = "var(--sage)";
  } catch (err) {
    els.passwordError.style.color = "";
    els.passwordError.textContent = err.message;
  }
});

els.logoutBtn.addEventListener("click", async () => {
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

// ---- Presence: tell the server whether this tab is actually being looked at --
function isTabActive() {
  return document.hasFocus() && document.visibilityState === "visible";
}

function reportFocusState() {
  if (!socketRef) return;
  socketRef.emit("focus-state", { focused: isTabActive() });
}

window.addEventListener("focus", reportFocusState);
window.addEventListener("blur", reportFocusState);
document.addEventListener("visibilitychange", reportFocusState);

// ---- Boot --------------------------------------------------------------------
(async () => {
  me = await apiGet("/api/me");
  if (!me.loggedIn) {
    window.location.href = "/login.html";
    return;
  }
  els.whoAmI.textContent = "@" + me.username;
  applyCustomBackground();

  updateNotifBanner();

  const relations = await apiGet("/api/relations");
  (relations.muted || []).forEach((u) => mutedUsers.add(u));
  (relations.blocked || []).forEach((u) => blockedUsers.add(u));

  await loadConversations();

  try {
    const presence = await apiGet("/api/presence");
    (presence.active || []).forEach((u) => activeUsernames.add(u.toLowerCase()));
    renderConversationList();
  } catch {
    // Non-critical — presence dots just won't show until the first live update.
  }

  const socket = io({ withCredentials: true });
  socketRef = socket;
  socket.on("connect", reportFocusState);

  socket.on("message", ({ id, from, body, type, reply }) => {
    const active = isActiveDm(from) && document.hasFocus();
    appendMessage(from, body, false, type || "text", { id, reply });
    bumpConversationPreview(from, body, type || "text", { incrementUnread: !active });
    notifyNewMessage(from, body, type || "text");
    ensurePartnerProfile(from);
    noteTyping("dm", from, false);
    if (active) markRead(from);
  });

  socket.on("message-edited", ({ id, body }) => {
    for (const [, list] of threadCache) {
      const msg = list.find((m) => String(m.id) === String(id));
      if (msg) {
        msg.body = body;
        msg.edited = true;
        break;
      }
    }
    if (activeConversation && activeConversation.type === "dm") renderThread();
  });

  socket.on("message-deleted", ({ id }) => {
    if (removeMessageEverywhere(id) && activeConversation && activeConversation.type === "dm") {
      renderThread();
    }
  });

  socket.on("global-message", ({ id, sender, nameColor, avatarUrl, body, type, reply }) => {
    appendGlobalMessage(sender, body, false, type || "text", { id, nameColor, avatarUrl, reply });
    noteTyping("global", sender, false);
  });

  socket.on("global-message-edited", ({ id, body }) => {
    const msg = globalMessages && globalMessages.find((m) => String(m.id) === String(id));
    if (msg) {
      msg.body = body;
      msg.edited = true;
      if (activeConversation && activeConversation.type === "global") renderThread();
    }
  });

  socket.on("global-message-deleted", ({ id }) => {
    if (removeGlobalMessage(id) && activeConversation && activeConversation.type === "global") {
      renderThread();
    }
  });

  socket.on("message-read", ({ by }) => {
    const list = threadCache.get(by);
    if (!list) return;
    list.forEach((m) => {
      if (m.mine) m.read = true;
    });
    if (isActiveDm(by)) renderThread();
  });

  socket.on("typing", ({ from, active }) => noteTyping("dm", from, active));
  socket.on("global-typing", ({ username, active }) => noteTyping("global", username, active));

  socket.on("presence", ({ username, active }) => {
    const key = username.toLowerCase();
    const changed = active ? !activeUsernames.has(key) : activeUsernames.has(key);
    if (active) activeUsernames.add(key);
    else activeUsernames.delete(key);
    if (!changed) return;
    // Only worth a re-render if that person is actually visible somewhere.
    const inSidebar = conversations.some((c) => sameUsername(c.username, username));
    const inThread =
      isActiveDm(username) || (activeConversation && activeConversation.type === "global");
    if (inSidebar) renderConversationList();
    if (inThread) renderThread();
  });

  // If a DM thread is open when the tab regains focus, treat its messages
  // as read now rather than waiting for the next interaction.
  window.addEventListener("focus", () => {
    if (activeConversation && activeConversation.type === "dm") {
      markRead(activeConversation.username);
    }
  });
})();
