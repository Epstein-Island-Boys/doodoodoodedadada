// messages.js — the chat app: conversation list, the global room, opening a
// thread, sending messages/images (including pasted images), the emoji
// picker, mute/block, read receipts, desktop notifications, replies/edits/
// unsend, hiding a chat from your inbox, typing indicators, presence dots,
// the settings panel (avatar, name color, per-theme background, username,
// password), and receiving all of the above live over the socket.

let me = null;
let activeConversation = null; // { type: "dm", username } | { type: "global" } | { type: "group", id } | null
let conversations = []; // [{username, body, type, created_at, nameColor, avatarUrl, unread}]
const threadCache = new Map(); // username -> messages array
let globalMessages = null; // null until first loaded
let globalPreview = "Say hello to everyone.";
let groups = []; // [{id, name, members, lastMessage, unread}]
const groupMessageCache = new Map(); // groupId -> messages array
const mutedUsers = new Set();
const blockedUsers = new Set();
let replyingTo = null; // { id, sender, type, body } | null
let editingId = null; // id of the message currently being edited inline
const partnerProfiles = new Map(); // username(lower) -> { avatarUrl, nameColor } — DM messages
// don't carry sender info per-message (unlike global ones), since a DM
// thread only ever has two participants, so we look theirs up once here.
const activeUsernames = new Set(); // usernames currently looking at their tab (lowercased)
const onlineUsers = new Map(); // lowercased username -> display-cased username, for anyone
// currently connected at all — a superset of activeUsernames, used for the
// Global Chat headcount/popover.
const typingUsers = new Map(); // scope key -> Map(username -> timeoutId)

// ---- Windowed history loading ---------------------------------------------------
// Every thread (a DM, the global room, or a group) keeps at most HISTORY_PAGE_SIZE
// messages loaded in memory/DOM at once. Scrolling to the top loads the next
// HISTORY_LOAD_MORE_SIZE older messages and unloads that many from the newest
// end; scrolling back to the bottom does the reverse. This keeps both memory
// use and the initial page load small no matter how long a thread's history is.
const HISTORY_PAGE_SIZE = 300;
const HISTORY_LOAD_MORE_SIZE = 200;
const HISTORY_TRIM_BUFFER = 100; // how far past HISTORY_PAGE_SIZE we let a live thread grow before trimming
const SCROLL_LOAD_THRESHOLD = 80; // px from an edge that triggers loading the next page
const threadMeta = new Map(); // username -> pagination state
const groupMeta = new Map(); // groupId -> pagination state
let globalMetaState = null; // pagination state for the global room

function freshMeta() {
  return { everFetched: false, hasMoreOlder: false, hasMoreNewer: false, loadingOlder: false, loadingNewer: false };
}
function metaFor(kind, key) {
  if (kind === "global") {
    if (!globalMetaState) globalMetaState = freshMeta();
    return globalMetaState;
  }
  if (kind === "group") {
    if (!groupMeta.has(key)) groupMeta.set(key, freshMeta());
    return groupMeta.get(key);
  }
  if (!threadMeta.has(key)) threadMeta.set(key, freshMeta());
  return threadMeta.get(key);
}
// Returns the live array backing a thread's messages, creating it if needed.
// Kept as a plain array (not a wrapper object) so all the existing
// find/push/splice/filter code elsewhere in this file keeps working untouched.
function arrayRefFor(kind, key) {
  if (kind === "global") {
    if (!globalMessages) globalMessages = [];
    return globalMessages;
  }
  if (kind === "group") {
    if (!groupMessageCache.has(key)) groupMessageCache.set(key, []);
    return groupMessageCache.get(key);
  }
  if (!threadCache.has(key)) threadCache.set(key, []);
  return threadCache.get(key);
}
function apiPathFor(kind, key) {
  if (kind === "global") return "/api/global/messages";
  if (kind === "group") return `/api/groups/${key}/messages`;
  return `/api/messages/${encodeURIComponent(key)}`;
}
function isActiveThread(kind, key) {
  if (!activeConversation) return false;
  if (kind === "global") return activeConversation.type === "global";
  if (kind === "group") return activeConversation.type === "group" && activeConversation.id === key;
  return activeConversation.type === "dm" && sameUsername(activeConversation.username, key);
}
// If we're mid-history (scrolled up, newest messages unloaded) and the local
// user sends a new message, jump the view back to "live" rather than
// splicing the new message in after a gap of hidden history.
function resetToLiveIfNeeded(kind, key) {
  const meta = metaFor(kind, key);
  if (!meta.hasMoreNewer) return;
  arrayRefFor(kind, key).length = 0;
  meta.hasMoreNewer = false;
  meta.hasMoreOlder = true;
}
// Keeps a live (caught-up) thread from growing forever while it's the
// active conversation and messages keep arriving.
function trimIfNeeded(kind, key) {
  const meta = metaFor(kind, key);
  if (meta.hasMoreNewer) return; // only trim from the live tail
  const items = arrayRefFor(kind, key);
  if (items.length > HISTORY_PAGE_SIZE + HISTORY_TRIM_BUFFER) {
    items.splice(0, items.length - HISTORY_PAGE_SIZE);
    meta.hasMoreOlder = true;
  }
}

async function loadOlderMessages(kind, key) {
  const meta = metaFor(kind, key);
  if (meta.loadingOlder || !meta.hasMoreOlder) return;
  const items = arrayRefFor(kind, key);
  const oldest = items[0];
  if (!oldest || oldest.id == null) return;
  meta.loadingOlder = true;
  try {
    const qs = new URLSearchParams({ limit: String(HISTORY_LOAD_MORE_SIZE), before: String(oldest.id) });
    const data = await apiGet(`${apiPathFor(kind, key)}?${qs}`);
    const older = data.messages || [];
    meta.hasMoreOlder = Boolean(data.hasMore);
    if (older.length) {
      if (items.length > HISTORY_LOAD_MORE_SIZE) items.splice(items.length - HISTORY_LOAD_MORE_SIZE, HISTORY_LOAD_MORE_SIZE);
      else items.length = 0;
      meta.hasMoreNewer = true;
      items.unshift(...older);
      if (isActiveThread(kind, key)) {
        const prevHeight = els.thread.scrollHeight;
        const prevTop = els.thread.scrollTop;
        renderThread({ preserveScrollFrom: { prevHeight, prevTop } });
      }
    }
  } catch (e) {
    console.error("Failed to load older messages:", e);
  } finally {
    meta.loadingOlder = false;
  }
}

async function loadNewerMessages(kind, key) {
  const meta = metaFor(kind, key);
  if (meta.loadingNewer || !meta.hasMoreNewer) return;
  const items = arrayRefFor(kind, key);
  const newest = items[items.length - 1];
  if (!newest || newest.id == null) return;
  meta.loadingNewer = true;
  try {
    const qs = new URLSearchParams({ limit: String(HISTORY_LOAD_MORE_SIZE), after: String(newest.id) });
    const data = await apiGet(`${apiPathFor(kind, key)}?${qs}`);
    const newer = data.messages || [];
    meta.hasMoreNewer = Boolean(data.hasMore);
    if (newer.length) {
      if (items.length > HISTORY_LOAD_MORE_SIZE) items.splice(0, HISTORY_LOAD_MORE_SIZE);
      else items.length = 0;
      meta.hasMoreOlder = true;
      items.push(...newer);
      if (isActiveThread(kind, key)) renderThread();
    }
  } catch (e) {
    console.error("Failed to load newer messages:", e);
  } finally {
    meta.loadingNewer = false;
  }
}

let scrollLoadTicking = false;
function handleThreadScroll() {
  if (scrollLoadTicking || !activeConversation) return;
  scrollLoadTicking = true;
  requestAnimationFrame(() => {
    scrollLoadTicking = false;
    if (!activeConversation) return;
    const kind = activeConversation.type;
    const key = kind === "group" ? activeConversation.id : kind === "dm" ? activeConversation.username : null;
    const meta = metaFor(kind, key);
    if (els.thread.scrollTop <= SCROLL_LOAD_THRESHOLD && meta.hasMoreOlder && !meta.loadingOlder) {
      loadOlderMessages(kind, key);
    } else if (
      els.thread.scrollHeight - els.thread.scrollTop - els.thread.clientHeight <= SCROLL_LOAD_THRESHOLD &&
      meta.hasMoreNewer &&
      !meta.loadingNewer
    ) {
      loadNewerMessages(kind, key);
    }
  });
}

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
  imageInput: document.getElementById("image-input"), gifBtn: document.getElementById("gif-btn"), gifPanel: document.getElementById("gif-panel"), gifSearch: document.getElementById("gif-search"), gifResults: document.getElementById("gif-results"),
  sidebar: document.getElementById("sidebar"),
  main: document.getElementById("main"),
  backLink: document.getElementById("back-link"),
  globalBtn: document.getElementById("global-chat-btn"),
  globalPreview: document.getElementById("global-chat-preview"),
  globalOnlineCount: document.getElementById("global-online-count"),
  globalOnlineBadgeHeader: document.getElementById("global-online-badge-header"),
  globalOnlineCountHeader: document.getElementById("global-online-count-header"),
  onlinePopover: document.getElementById("online-popover"),
  onlinePopoverList: document.getElementById("online-popover-list"),
  notifBanner: document.getElementById("notif-banner"),
  notifEnableBtn: document.getElementById("notif-enable-btn"),
  notifDismissBtn: document.getElementById("notif-dismiss-btn"),
  contextMenu: document.getElementById("conv-menu"),
  menuMuteBtn: document.getElementById("conv-menu-mute"),
  menuBlockBtn: document.getElementById("conv-menu-block"),
  menuDeleteBtn: document.getElementById("conv-menu-delete"),
  groupMenu: document.getElementById("group-menu"),
  groupMenuRename: document.getElementById("group-menu-rename"),
  groupMenuAdd: document.getElementById("group-menu-add"),
  groupMenuLeave: document.getElementById("group-menu-leave"),
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
  adminModeForm: document.getElementById("admin-mode-form"),
  adminModePassword: document.getElementById("admin-mode-password"),
  adminModeError: document.getElementById("admin-mode-error"),
  adminModeStatus: document.getElementById("admin-mode-status"),
  relationsList: document.getElementById("relations-list"),
  logoutBtn: document.getElementById("logout-btn"),

  plusBtn: document.getElementById("plus-btn"),
  plusMenu: document.getElementById("plus-menu"),
  plusVoice: document.getElementById("plus-voice"),
  plusPhoto: document.getElementById("plus-photo"),
  plusVideo: document.getElementById("plus-video"),

  cameraOverlay: document.getElementById("camera-overlay"),
  cameraModalTitle: document.getElementById("camera-modal-title"),
  cameraClose: document.getElementById("camera-close"),
  cameraStage: document.getElementById("camera-stage"),
  cameraVideo: document.getElementById("camera-video"),
  cameraPhotoPreview: document.getElementById("camera-photo-preview"),
  cameraVideoPreview: document.getElementById("camera-video-preview"),
  cameraCanvas: document.getElementById("camera-canvas"),
  cameraRecIndicator: document.getElementById("camera-rec-indicator"),
  cameraRecTimer: document.getElementById("camera-rec-timer"),
  cameraError: document.getElementById("camera-error"),
  cameraControls: document.getElementById("camera-controls"),
  cameraShutter: document.getElementById("camera-shutter"),
  cameraReviewControls: document.getElementById("camera-review-controls"),
  cameraRetake: document.getElementById("camera-retake"),
  cameraSend: document.getElementById("camera-send"),

  voiceOverlay: document.getElementById("voice-overlay"),
  voiceClose: document.getElementById("voice-close"),
  voiceMicIcon: document.getElementById("voice-mic-icon"),
  voiceRecIndicator: document.getElementById("voice-rec-indicator"),
  voiceRecTimer: document.getElementById("voice-rec-timer"),
  voicePreview: document.getElementById("voice-preview"),
  voiceError: document.getElementById("voice-error"),
  voiceControls: document.getElementById("voice-controls"),
  voiceRecordBtn: document.getElementById("voice-record-btn"),
  voiceReviewControls: document.getElementById("voice-review-controls"),
  voiceRetake: document.getElementById("voice-retake"),
  voiceSend: document.getElementById("voice-send"),
};

els.thread.addEventListener("scroll", handleThreadScroll);

const DEFAULT_NAME_COLOR = "#2F3B26";
const DEFAULT_LIGHT_BG = "#F3EFE1";
const DEFAULT_DARK_BG = "#0F1226";

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

function previewFor(body, type) {
  if (type === "image") return "📷 Photo";
  if (type === "audio") return "🎤 Voice message";
  if (type === "video") return "🎥 Video";
  return body;
}

function isActiveDm(username) {
  return (
    activeConversation &&
    activeConversation.type === "dm" &&
    activeConversation.username.toLowerCase() === username.toLowerCase()
  );
}

function isActiveGroup(groupId) {
  return activeConversation && activeConversation.type === "group" && String(activeConversation.id) === String(groupId);
}

function sameUsername(a, b) {
  return String(a || "").toLowerCase() === String(b || "").toLowerCase();
}

// A group's display name is whatever it was renamed to, or (by default) a
// comma-separated list of everyone else in it.
function groupDisplayName(group) {
  if (group.name) return group.name;
  const others = (group.members || []).filter((m) => !sameUsername(m.username, me.username));
  return others.length ? others.map((m) => m.username).join(", ") : "Just you";
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

// ---- Online-users indicator (Global Chat) --------------------------------------
function renderOnlineBadges() {
  const count = onlineUsers.size;
  if (els.globalOnlineCount) els.globalOnlineCount.textContent = String(count);
  if (els.globalOnlineCountHeader) els.globalOnlineCountHeader.textContent = String(count);
  const isGlobalOpen = activeConversation && activeConversation.type === "global";
  els.globalOnlineBadgeHeader?.classList.toggle("is-hidden", !isGlobalOpen);
  if (!els.onlinePopover.classList.contains("is-hidden")) renderOnlinePopoverList();
}

function renderOnlinePopoverList() {
  if (!els.onlinePopoverList) return;
  const names = [...onlineUsers.values()].sort((a, b) => a.localeCompare(b));
  if (names.length === 0) {
    els.onlinePopoverList.innerHTML = `<p class="online-popover-item">Nobody else is online right now.</p>`;
    return;
  }
  els.onlinePopoverList.innerHTML = names
    .map((n) => `<div class="online-popover-item"><span class="online-badge-dot"></span>${escapeHtml(n)}</div>`)
    .join("");
}

function toggleOnlinePopover() {
  const hidden = els.onlinePopover.classList.contains("is-hidden");
  if (hidden) {
    renderOnlinePopoverList();
    els.onlinePopover.classList.remove("is-hidden");
  } else {
    els.onlinePopover.classList.add("is-hidden");
  }
}

els.globalOnlineBadgeHeader?.addEventListener("click", (e) => {
  e.stopPropagation();
  toggleOnlinePopover();
});

document.addEventListener("click", (e) => {
  if (els.onlinePopover.classList.contains("is-hidden")) return;
  if (els.onlinePopover.contains(e.target) || els.globalOnlineBadgeHeader?.contains(e.target)) return;
  els.onlinePopover.classList.add("is-hidden");
});


async function loadConversations() {
  const data = await apiGet("/api/conversations");
  conversations = data.conversations || [];
  conversations.forEach((c) => {
    partnerProfiles.set(c.username.toLowerCase(), { avatarUrl: c.avatarUrl, nameColor: c.nameColor });
  });
  renderConversationList();
}

async function loadGroups() {
  const data = await apiGet("/api/groups");
  groups = data.groups || [];
  renderConversationList();
}

// Merges a group summary (id/name/members) the server sent back into the
// local list — creating the entry if this is the first we've heard of it,
// or just updating name/members if we already have it (preserving its
// cached last message / unread count).
function upsertGroup(partial) {
  let g = groups.find((x) => x.id === partial.id);
  if (!g) {
    g = { id: partial.id, name: partial.name || null, members: partial.members || [], lastMessage: null, unread: 0 };
    groups.push(g);
  } else {
    g.name = partial.name || null;
    if (partial.members) g.members = partial.members;
  }
  return g;
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

function renderDmItem(c) {
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
        <div class="conv-name">${escapeHtml(c.username)} ${hasUnread ? `<span class="unread-dot" title="Unread"></span>` : ""} ${badge}</div>
        <div class="conv-preview">${escapeHtml(previewText)}</div>
      </div>
      ${hasUnread ? `<span class="unread-badge">${unread > 99 ? "99+" : unread}</span>` : ""}
    </button>
    <button type="button" class="conv-menu-btn" data-username="${escapeHtml(c.username)}" aria-label="Options for ${escapeHtml(c.username)}" aria-haspopup="true">⋮</button>
  </div>`;
}

function renderGroupItem(g) {
  const active = isActiveGroup(g.id) ? "active" : "";
  const unread = g.unread || 0;
  const hasUnread = unread > 0 && !isActiveGroup(g.id);
  const name = groupDisplayName(g);
  const previewText = hasUnread
    ? `${unread} new message${unread === 1 ? "" : "s"}`
    : g.lastMessage
    ? g.lastMessage.type === "system"
      ? g.lastMessage.body
      : previewFor(g.lastMessage.body, g.lastMessage.type)
    : "No messages yet.";
  return `
  <div class="conversation-item ${active} ${hasUnread ? "has-unread" : ""}">
    <button class="conv-open" data-group-id="${g.id}">
      <span class="group-chat-icon" aria-hidden="true">👥</span>
      <div class="conv-open-text">
        <div class="conv-name">${escapeHtml(name)} ${hasUnread ? `<span class="unread-dot" title="Unread"></span>` : ""}</div>
        <div class="conv-preview">${escapeHtml(previewText)}</div>
      </div>
      ${hasUnread ? `<span class="unread-badge">${unread > 99 ? "99+" : unread}</span>` : ""}
    </button>
    <button type="button" class="group-menu-btn conv-menu-btn" data-group-id="${g.id}" aria-label="Options for ${escapeHtml(name)}" aria-haspopup="true">⋮</button>
  </div>`;
}

// DMs and groups are shown as one list, most recently active first — same
// aesthetic as the normal chat system, just two kinds of rows in it.
function renderConversationList() {
  const items = [
    ...conversations.map((c) => ({ kind: "dm", data: c, ts: c.created_at || "" })),
    ...groups.map((g) => ({ kind: "group", data: g, ts: (g.lastMessage && g.lastMessage.created_at) || "" })),
  ];

  if (items.length === 0) {
    els.convList.innerHTML = `<p class="chat-sidebar-empty">No conversations yet — start one above.</p>`;
    return;
  }

  items.sort((a, b) => (b.ts || "").localeCompare(a.ts || ""));

  els.convList.innerHTML = items.map((item) => (item.kind === "dm" ? renderDmItem(item.data) : renderGroupItem(item.data))).join("");

  els.convList.querySelectorAll(".conv-open[data-username]").forEach((btn) => {
    btn.addEventListener("click", () => openThread(btn.dataset.username));
  });
  els.convList.querySelectorAll(".conv-menu-btn[data-username]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      openContextMenu(btn.dataset.username, btn);
    });
  });
  els.convList.querySelectorAll(".conv-open[data-group-id]").forEach((btn) => {
    btn.addEventListener("click", () => openGroupThread(Number(btn.dataset.groupId)));
  });
  els.convList.querySelectorAll(".group-menu-btn[data-group-id]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      openGroupMenu(Number(btn.dataset.groupId), btn);
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

// ---- Group chat 3-dot menu: rename / add people / leave ----------------------
// Same slot in the UI as the DM's mute/block/delete menu — just a different
// menu, since group chats don't get muted/blocked/hidden the same way.
function openGroupMenu(groupId, anchorEl) {
  els.groupMenu.dataset.target = groupId;
  const rect = anchorEl.getBoundingClientRect();
  els.groupMenu.style.top = rect.bottom + 4 + "px";
  els.groupMenu.style.left = Math.max(8, rect.right - 160) + "px";
  els.groupMenu.classList.remove("is-hidden");
}

function closeGroupMenu() {
  els.groupMenu.classList.add("is-hidden");
  delete els.groupMenu.dataset.target;
}

els.groupMenuRename?.addEventListener("click", async () => {
  const groupId = Number(els.groupMenu.dataset.target);
  closeGroupMenu();
  if (!groupId) return;
  const group = groups.find((g) => g.id === groupId);
  const name = window.prompt("Group name:", group?.name || "");
  if (name === null) return;
  try {
    const res = await apiPatch(`/api/groups/${groupId}`, { name: name.trim() });
    if (group) group.name = res.name;
    renderConversationList();
    if (isActiveGroup(groupId)) updateGroupThreadTitle(groupId);
  } catch (err) {
    window.alert(err.message);
  }
});

els.groupMenuAdd?.addEventListener("click", async () => {
  const groupId = Number(els.groupMenu.dataset.target);
  closeGroupMenu();
  if (!groupId) return;
  const raw = window.prompt("Add people (comma-separated usernames):", "");
  if (!raw) return;
  const usernames = raw
    .split(",")
    .map((u) => u.trim())
    .filter(Boolean);
  if (!usernames.length) return;
  try {
    const res = await apiPost(`/api/groups/${groupId}/members`, { usernames });
    upsertGroup(res.group);
    renderConversationList();
    if (isActiveGroup(groupId)) updateGroupThreadTitle(groupId);
  } catch (err) {
    window.alert(err.message);
  }
});

els.groupMenuLeave?.addEventListener("click", async () => {
  const groupId = Number(els.groupMenu.dataset.target);
  closeGroupMenu();
  if (!groupId) return;
  const group = groups.find((g) => g.id === groupId);
  const label = group ? groupDisplayName(group) : "this group";
  if (!window.confirm(`Leave ${label}? You'll need to be added back in to rejoin.`)) return;
  try {
    await apiPost(`/api/groups/${groupId}/leave`, {});
    groups = groups.filter((g) => g.id !== groupId);
    groupMessageCache.delete(groupId);
    groupMeta.delete(groupId);
    renderConversationList();
    if (isActiveGroup(groupId)) {
      activeConversation = null;
      els.threadView.classList.add("is-hidden");
      els.emptyState.classList.remove("is-hidden");
    }
  } catch (err) {
    window.alert(err.message);
  }
});

document.addEventListener("click", (e) => {
  if (els.groupMenu.classList.contains("is-hidden")) return;
  if (els.groupMenu.contains(e.target)) return;
  closeGroupMenu();
});

// ---- Opening a DM thread ------------------------------------------------------
function youtubeIdFromClient(v){try{const u=new URL(v);if(u.hostname==="youtu.be")return u.pathname.slice(1).split("/")[0];if(["youtube.com","www.youtube.com","m.youtube.com","music.youtube.com"].includes(u.hostname)){if(u.pathname==="/watch")return u.searchParams.get("v");const m=u.pathname.match(/^\/(shorts|embed)\/([^/?]+)/);return m?.[2]||null}}catch{}return null}
function extractYouTubeUrl(t){const m=t.match(/https?:\/\/[^\s]+/i);if(!m)return null;const u=m[0].replace(/[),.!?]+$/g,"");return youtubeIdFromClient(u)?u:null}
function extractGifUrl(t){for(const raw of t.match(/https?:\/\/[^\s]+/ig)||[]){const u=raw.replace(/[),.!?]+$/g,"");try{const x=new URL(u);if(/\.gif(?:$|[?#])/i.test(x.pathname)||/(^|\.)media\.tenor\.com$/i.test(x.hostname)||/(^|\.)tenor\.com$/i.test(x.hostname))return u}catch{}}return null}
function gifDisplayUrl(url){try{const u=new URL(url);if(/(^|\.)tenor\.com$/i.test(u.hostname)||/(^|\.)media\.tenor\.com$/i.test(u.hostname))return `/api/gifs/tenor-proxy?url=${encodeURIComponent(url)}`;}catch{}return url}

function renderLinkedText(raw){
  const text=String(raw||"");
  const re=/https?:\/\/[^\s<>]+/ig;
  let out="", last=0, match;
  while((match=re.exec(text))){
    const url=match[0].replace(/[),.!?]+$/g,"");
    const trailing=match[0].slice(url.length);
    out+=escapeHtml(text.slice(last,match.index));
    out+=`<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(url)}</a>`;
    out+=escapeHtml(trailing);
    last=match.index+match[0].length;
  }
  return out+escapeHtml(text.slice(last));
}



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
  renderOnlineBadges();
  els.onlinePopover.classList.add("is-hidden");

  const dmMeta = metaFor("dm", username);
  if (!dmMeta.everFetched) {
    const data = await apiGet(`/api/messages/${encodeURIComponent(username)}?limit=${HISTORY_PAGE_SIZE}`);
    threadCache.set(username, data.messages || []);
    dmMeta.everFetched = true;
    dmMeta.hasMoreOlder = Boolean(data.hasMore);
    dmMeta.hasMoreNewer = false;
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
  renderOnlineBadges();

  const gMeta = metaFor("global", null);
  if (!gMeta.everFetched) {
    const data = await apiGet(`/api/global/messages?limit=${HISTORY_PAGE_SIZE}`);
    globalMessages = data.messages || [];
    gMeta.everFetched = true;
    gMeta.hasMoreOlder = Boolean(data.hasMore);
    gMeta.hasMoreNewer = false;
  }
  renderThread();
  els.composerInput.focus();
}

els.globalBtn.addEventListener("click", openGlobal);

// ---- Opening a group thread ----------------------------------------------------
async function openGroupThread(groupId) {
  activeConversation = { type: "group", id: groupId };
  els.emptyState.classList.add("is-hidden");
  els.threadView.classList.remove("is-hidden");
  els.sidebar.classList.add("hide-on-mobile");
  els.main.classList.remove("hide-on-mobile");
  els.composerError.textContent = "";
  cancelReply();
  closeEmojiPanel();
  els.globalBtn.classList.remove("active");
  updateGroupThreadTitle(groupId);
  renderConversationList();
  renderTypingIndicator();
  renderOnlineBadges();
  els.onlinePopover.classList.add("is-hidden");

  const grMeta = metaFor("group", groupId);
  if (!grMeta.everFetched) {
    const data = await apiGet(`/api/groups/${groupId}/messages?limit=${HISTORY_PAGE_SIZE}`);
    groupMessageCache.set(groupId, data.messages || []);
    grMeta.everFetched = true;
    grMeta.hasMoreOlder = Boolean(data.hasMore);
    grMeta.hasMoreNewer = false;
  }
  renderThread();
  els.composerInput.focus();
  markGroupRead(groupId);
}

function updateGroupThreadTitle(groupId) {
  const group = groups.find((g) => g.id === groupId);
  els.threadTitle.textContent = "👥 " + (group ? groupDisplayName(group) : "Group chat");
}

async function markGroupRead(groupId) {
  const g = groups.find((x) => x.id === groupId);
  if (g && g.unread) {
    g.unread = 0;
    renderConversationList();
  }
  try {
    await apiPost(`/api/groups/${groupId}/read`, {});
  } catch {
    // Non-critical — worst case the unread count just doesn't clear this round.
  }
}

// ---- Rendering ------------------------------------------------------------------
function replySnippetText(reply) {
  if (!reply) return "";
  if (reply.removed) return "Original message removed";
  return previewFor(reply.body, reply.type);
}

function renderReplyQuote(reply) {
  if (!reply) return "";
  if (reply.removed) {
    return `<div class="reply-quote reply-quote-removed">Original message removed</div>`;
  }
  const label = reply.sender === "me" ? "You" : reply.sender;
  return `<button type="button" class="reply-quote" data-jump-to="${reply.id}"><span class="reply-quote-name">${escapeHtml(label)}</span>${escapeHtml(replySnippetText(reply))}</button>`;
}

// ---- Message timestamps -----------------------------------------------------
// Every message carries a `created_at` — either straight from the server
// (SQLite's `datetime('now')`, which is UTC but written as "YYYY-MM-DD
// HH:MM:SS" with no timezone marker) or, for a message we just sent
// ourselves, `new Date().toISOString()` (already has one). `new Date()`
// can't be trusted to guess right on a string with no marker — some
// browsers read it as UTC, some as local — so we normalize it ourselves
// before parsing. Once parsed, everything below renders in whatever
// timezone the device is set to, since that's all `toLocaleString` etc.
// know how to use.
function parseServerDate(value) {
  if (!value) return null;
  let normalized = value;
  if (typeof normalized === "string" && !/[zZ]|[+-]\d\d:?\d\d$/.test(normalized)) {
    normalized = normalized.replace(" ", "T") + "Z";
  }
  const d = new Date(normalized);
  return Number.isNaN(d.getTime()) ? null : d;
}

function formatMessageTimestamp(value) {
  const d = parseServerDate(value);
  if (!d) return { short: "", full: "" };
  const now = new Date();
  const time = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  const full = d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

  const startOfDay = (date) => new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const dayDiff = Math.round((startOfDay(now) - startOfDay(d)) / 86400000);

  if (dayDiff === 0) return { short: time, full };
  if (dayDiff === 1) return { short: `Yesterday ${time}`, full };
  const dateStr = d.toLocaleDateString(undefined, d.getFullYear() === now.getFullYear() ? { month: "short", day: "numeric" } : { month: "short", day: "numeric", year: "numeric" });
  return { short: `${dateStr} ${time}`, full };
}

// ---- Custom audio player ------------------------------------------------------
// A plain `<audio controls>` element looks and behaves differently across
// browsers (and some mobile browsers render it *very* small). This builds a
// simple, consistent play/pause + scrub-bar + time display — the same basic
// shape as a Discord voice-message or Google Play track row — wrapping a
// hidden native <audio> element that does the actual playback work.
function formatAudioTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

function renderAudioPlayer(src) {
  const safeSrc = escapeHtml(src);
  return `<div class="audio-player">
    <button type="button" class="audio-player-btn" data-audio-toggle aria-label="Play">
      <span class="audio-player-icon audio-player-icon-play">▶</span>
      <span class="audio-player-icon audio-player-icon-pause is-hidden">❚❚</span>
    </button>
    <div class="audio-player-body">
      <div class="audio-player-bar" data-audio-seek>
        <div class="audio-player-bar-fill"></div>
      </div>
      <div class="audio-player-time"><span class="audio-player-elapsed">0:00</span><span class="audio-player-time-sep">/</span><span class="audio-player-duration">0:00</span></div>
    </div>
    <audio preload="metadata" src="${safeSrc}"></audio>
  </div>`;
}

function renderBubble(m, kind) {
  // System messages ("X added Y", "X renamed the group") are plain centered
  // text — no bubble, no avatar, no actions.
  if (m.type === "system") {
    return `<div class="bubble-system">${escapeHtml(m.body)}</div>`;
  }

  const isMulti = kind === "global" || kind === "group"; // show sender name + avatar on every bubble, like Global Chat
  const side = m.mine ? "mine" : "theirs";
  let avatarUrl = null;
  if (!m.mine) {
    if (isMulti) {
      avatarUrl = m.avatarUrl;
    } else {
      avatarUrl = (partnerProfiles.get(activeConversation.username.toLowerCase()) || {}).avatarUrl;
    }
  }
  const avatarOwner = isMulti ? m.sender : activeConversation.username;
  const avatar = !m.mine ? avatarHtml(avatarOwner, avatarUrl, "avatar-sm", true) : "";
  const nameStyle = isMulti && m.nameColor ? ` style="color:${escapeHtml(m.nameColor)}"` : "";
  const senderLabel =
    isMulti && !m.mine ? `<div class="bubble-sender-row">${avatar}<div class="bubble-sender"${nameStyle}>${escapeHtml(m.sender)}</div></div>` : "";
  const seen = kind === "dm" && m.mine ? `<div class="seen-indicator">${m.read ? "Seen" : "Sent"}</div>` : "";
  const editedTag = m.edited ? `<span class="edited-tag">(edited)</span>` : "";
  const { short: timeShort, full: timeFull } = formatMessageTimestamp(m.created_at);
  const timestamp = timeShort ? `<span class="msg-timestamp" title="${escapeHtml(timeFull)}">${escapeHtml(timeShort)}</span>` : "";
  const replyQuote = renderReplyQuote(m.reply);

  const canManage = m.mine;
  const canAdminManageGlobal = kind === "global" && Boolean(me?.isAdmin);
  const actions = `<div class="bubble-actions">
      <button type="button" class="bubble-action-btn" data-action="reply" title="Reply">↩</button>
      ${(canManage || canAdminManageGlobal) && m.type === "text" ? `<button type="button" class="bubble-action-btn" data-action="edit" title="Edit">✎</button>` : ""}
      ${(canManage || canAdminManageGlobal) ? `<button type="button" class="bubble-action-btn" data-action="delete" title="Delete">🗑</button>` : ""}
    </div>`;

  let bubbleInner;
  const detectedYouTube = m.type === "text" ? extractYouTubeUrl(m.body) : null;
  const detectedGif = m.type === "text" ? extractGifUrl(m.body) : null;
  if (m.type === "image" || m.type === "gif") bubbleInner = `<div class="bubble bubble-image ${side}">${replyQuote}<img src="${escapeHtml(m.type === "gif" ? gifDisplayUrl(m.body) : m.body)}" alt="${m.type === "gif" ? "GIF" : "Image message"}" loading="lazy" />${m.type === "gif" ? `<a class="embed-source-link" href="${escapeHtml(m.body)}" target="_blank" rel="noopener noreferrer">Open GIF</a>` : ""}</div>`;
  else if (m.type === "audio") bubbleInner = `<div class="bubble bubble-audio ${side}">${replyQuote}${renderAudioPlayer(m.body)}</div>`;
  else if (m.type === "video") bubbleInner = `<div class="bubble bubble-video ${side}">${replyQuote}<video controls playsinline preload="metadata" src="${escapeHtml(m.body)}"></video></div>`;
  else if (m.type === "youtube" || detectedYouTube) { const sourceUrl=m.type === "youtube"?m.body:detectedYouTube; const vid=youtubeIdFromClient(sourceUrl); bubbleInner=`<div class="bubble bubble-embed ${side}">${replyQuote}${vid?`<iframe src="https://www.youtube-nocookie.com/embed/${encodeURIComponent(vid)}" title="YouTube video" loading="lazy" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" allowfullscreen></iframe><a class="embed-source-link" href="${escapeHtml(sourceUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(sourceUrl)}</a>`:renderLinkedText(m.body)}</div>`; }
  else if (detectedGif) bubbleInner=`<div class="bubble bubble-image ${side}">${replyQuote}<img src="${escapeHtml(gifDisplayUrl(detectedGif))}" alt="GIF" loading="lazy" /><a class="embed-source-link" href="${escapeHtml(detectedGif)}" target="_blank" rel="noopener noreferrer">Open GIF</a></div>`;
  else bubbleInner=`<div class="bubble ${side}">${replyQuote}${renderLinkedText(m.body)}</div>`;

  return `<div class="bubble-group ${side}" data-id="${m.id ?? ""}">
    ${senderLabel}
    <div class="bubble-row">${bubbleInner}${actions}</div>
    <div class="bubble-meta-row">${timestamp}${editedTag}${seen}</div>
  </div>`;
}

function renderThread(opts = {}) {
  const kind = activeConversation ? activeConversation.type : null; // "dm" | "global" | "group" | null
  const messages =
    kind === "global"
      ? globalMessages || []
      : kind === "group"
      ? groupMessageCache.get(activeConversation.id) || []
      : activeConversation
      ? threadCache.get(activeConversation.username) || []
      : [];
  els.thread.innerHTML = messages.map((m) => renderBubble(m, kind)).join("");
  if (opts.preserveScrollFrom) {
    // Used after loading an older page: keep whatever the user was looking
    // at in the same spot instead of jumping to the top or bottom.
    const { prevHeight, prevTop } = opts.preserveScrollFrom;
    els.thread.scrollTop = els.thread.scrollHeight - prevHeight + prevTop;
  } else {
    els.thread.scrollTop = els.thread.scrollHeight;
  }
}

function appendMessage(username, body, mine, type = "text", extra = {}) {
  if (mine) resetToLiveIfNeeded("dm", username);
  else if (metaFor("dm", username).hasMoreNewer) return; // scrolled up in history — will show up once they scroll back down
  const list = arrayRefFor("dm", username);
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
  trimIfNeeded("dm", username);
  if (isActiveDm(username)) renderThread();
}

function appendGlobalMessage(sender, body, mine, type = "text", extra = {}) {
  globalPreview = previewFor(body, type);
  els.globalPreview.textContent = mine ? `You: ${globalPreview}` : `${sender}: ${globalPreview}`;
  if (mine) resetToLiveIfNeeded("global", null);
  else if (metaFor("global", null).hasMoreNewer) return; // scrolled up in history — will show up once they scroll back down
  const list = arrayRefFor("global", null);
  list.push({
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
  trimIfNeeded("global", null);
  if (activeConversation && activeConversation.type === "global") renderThread();
}

function bumpGroupPreview(groupId, body, type, extra = {}) {
  const g = groups.find((x) => x.id === groupId);
  if (!g) return;
  g.lastMessage = { body, type, created_at: new Date().toISOString() };
  if (extra.incrementUnread) g.unread = (g.unread || 0) + 1;
  renderConversationList();
}

function appendGroupMessage(groupId, sender, body, mine, type = "text", extra = {}) {
  const activeNow = isActiveGroup(groupId) && document.hasFocus();
  bumpGroupPreview(groupId, body, type, { incrementUnread: type !== "system" && !mine && !activeNow });
  if (mine) resetToLiveIfNeeded("group", groupId);
  else if (metaFor("group", groupId).hasMoreNewer) return; // scrolled up in history — will show up once they scroll back down
  const list = arrayRefFor("group", groupId);
  list.push({
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
  trimIfNeeded("group", groupId);
  if (isActiveGroup(groupId)) renderThread();
}

function replaceGroupMessageBody(groupId, oldBody, newBody, id) {
  const list = groupMessageCache.get(groupId) || [];
  const msg = [...list].reverse().find((m) => m.body === oldBody && m.mine);
  if (msg) {
    msg.body = newBody;
    if (id != null) msg.id = id;
    if (isActiveGroup(groupId)) renderThread();
  }
}

function findGroupMessageById(groupId, id) {
  const list = groupMessageCache.get(groupId) || [];
  return list.find((m) => String(m.id) === String(id));
}

// Removes a message from whichever group's cache holds it, by id — used
// both for our own unsends and for "group-message-deleted" events.
function removeGroupMessageEverywhere(id) {
  for (const [, list] of groupMessageCache) {
    const idx = list.findIndex((m) => String(m.id) === String(id));
    if (idx !== -1) {
      list.splice(idx, 1);
      return true;
    }
  }
  return false;
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

// Drops an optimistically-added bubble (matched by its blob-preview URL)
// when the actual upload behind it failed — used so a failed voice/video
// send doesn't leave a permanently-broken bubble sitting in the thread.
function removeMessageByPreview(username, previewUrl) {
  const list = threadCache.get(username) || [];
  const idx = [...list].reverse().findIndex((m) => m.body === previewUrl && m.mine);
  if (idx === -1) return;
  const realIdx = list.length - 1 - idx;
  list.splice(realIdx, 1);
  if (isActiveDm(username)) renderThread();
}

function removeGroupMessageByPreview(groupId, previewUrl) {
  const list = groupMessageCache.get(groupId) || [];
  const idx = [...list].reverse().findIndex((m) => m.body === previewUrl && m.mine);
  if (idx === -1) return;
  const realIdx = list.length - 1 - idx;
  list.splice(realIdx, 1);
  if (isActiveGroup(groupId)) renderThread();
}

function removeGlobalMessageByPreview(previewUrl) {
  if (!globalMessages) return;
  const idx = [...globalMessages].reverse().findIndex((m) => m.body === previewUrl && m.mine);
  if (idx === -1) return;
  const realIdx = globalMessages.length - 1 - idx;
  globalMessages.splice(realIdx, 1);
  if (activeConversation && activeConversation.type === "global") renderThread();
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
  if (!activeConversation) return null;
  if (activeConversation.type === "global") return (globalMessages || []).find((m) => String(m.id) === String(id));
  if (activeConversation.type === "group") return findGroupMessageById(activeConversation.id, id);
  return (threadCache.get(activeConversation.username) || []).find((m) => String(m.id) === String(id));
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
  const kind = activeConversation && activeConversation.type;
  if (!window.confirm("Unsend this message? It will be removed for everyone.")) return;
  try {
    if (kind === "global") {
      await apiDelete(`/api/global/messages/${id}`);
      removeGlobalMessage(id);
    } else if (kind === "group") {
      await apiDelete(`/api/groups/${activeConversation.id}/messages/${id}`);
      removeGroupMessageEverywhere(id);
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
  const kind = activeConversation && activeConversation.type;
  const trimmed = newBody.trim();
  if (!trimmed) return;
  try {
    if (kind === "global") {
      await apiPatch(`/api/global/messages/${id}`, { body: trimmed });
    } else if (kind === "group") {
      await apiPatch(`/api/groups/${activeConversation.id}/messages/${id}`, { body: trimmed });
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
      const isMulti = activeConversation && (activeConversation.type === "global" || activeConversation.type === "group");
      setReplyBar({
        id: msg.id,
        sender: msg.mine ? "me" : isMulti ? msg.sender : activeConversation.username,
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
    return;
  }

  // ---- Custom audio player: play/pause + click-to-seek ----------------------
  const toggleBtn = e.target.closest("[data-audio-toggle]");
  if (toggleBtn) {
    const audio = toggleBtn.closest(".audio-player").querySelector("audio");
    // Pause any other clip already playing so two voice messages don't
    // overlap.
    if (audio.paused) {
      els.thread.querySelectorAll(".audio-player audio").forEach((other) => {
        if (other !== audio && !other.paused) other.pause();
      });
      audio.play().catch(() => {});
    } else {
      audio.pause();
    }
    return;
  }

  const seekBar = e.target.closest("[data-audio-seek]");
  if (seekBar) {
    const audio = seekBar.closest(".audio-player").querySelector("audio");
    if (Number.isFinite(audio.duration) && audio.duration > 0) {
      const rect = seekBar.getBoundingClientRect();
      const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
      audio.currentTime = ratio * audio.duration;
    }
    return;
  }
});

// Media events (timeupdate, loadedmetadata, play, pause, ended) don't bubble
// like normal DOM events, but a capture-phase listener on an ancestor still
// sees them on the way down to the actual <audio> element, so this still
// works as delegation without binding a fresh listener per bubble.
function syncAudioPlayerUI(audio) {
  const player = audio.closest(".audio-player");
  if (!player) return;
  const fill = player.querySelector(".audio-player-bar-fill");
  const elapsed = player.querySelector(".audio-player-elapsed");
  const duration = player.querySelector(".audio-player-duration");
  const playIcon = player.querySelector(".audio-player-icon-play");
  const pauseIcon = player.querySelector(".audio-player-icon-pause");
  const btn = player.querySelector("[data-audio-toggle]");

  const dur = Number.isFinite(audio.duration) ? audio.duration : 0;
  const cur = Number.isFinite(audio.currentTime) ? audio.currentTime : 0;
  if (fill) fill.style.width = dur > 0 ? `${Math.min(100, (cur / dur) * 100)}%` : "0%";
  if (elapsed) elapsed.textContent = formatAudioTime(cur);
  if (duration) duration.textContent = formatAudioTime(dur);
  const playing = !audio.paused && !audio.ended;
  if (playIcon) playIcon.classList.toggle("is-hidden", playing);
  if (pauseIcon) pauseIcon.classList.toggle("is-hidden", !playing);
  if (btn) btn.setAttribute("aria-label", playing ? "Pause" : "Play");
}

["loadedmetadata", "timeupdate", "play", "pause", "ended"].forEach((evt) => {
  els.thread.addEventListener(
    evt,
    (e) => {
      if (e.target instanceof HTMLAudioElement && e.target.closest(".audio-player")) {
        syncAudioPlayerUI(e.target);
      }
    },
    true
  );
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
// Separating usernames with commas starts a group chat with all of them
// instead of a single DM.
els.newForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  els.newError.textContent = "";
  const raw = els.newInput.value.trim();
  if (!raw) return;

  const parts = raw
    .split(",")
    .map((u) => u.trim())
    .filter(Boolean);

  if (parts.length <= 1) {
    const username = parts[0] || raw;
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
    return;
  }

  const usernames = [...new Set(parts)].filter((u) => !sameUsername(u, me.username));
  if (usernames.length < 2) {
    els.newError.textContent = "Add at least two other people to start a group.";
    return;
  }
  try {
    const res = await apiPost("/api/groups", { usernames });
    els.newInput.value = "";
    upsertGroup(res.group);
    renderConversationList();
    openGroupThread(res.group.id);
  } catch (err) {
    els.newError.textContent = err.message;
  }
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

  const yt=extractYouTubeUrl(body), gif=extractGifUrl(body), detectedType=yt?"youtube":gif?"gif":"text";
  if (activeConversation.type === "global") {
    appendGlobalMessage(me.username, detectedType === "gif" ? gif : detectedType === "youtube" ? yt : body, true, detectedType, {
      nameColor: me.nameColor, avatarUrl: me.avatarUrl, reply: replyPayload,
    });
    try {
      const res = await apiPost("/api/global/messages", { body: detectedType === "gif" ? gif : detectedType === "youtube" ? yt : body, type: detectedType, replyTo: reply ? reply.id : undefined });
      replaceGlobalMessageBody(detectedType === "gif" ? gif : detectedType === "youtube" ? yt : body, res.message.body, res.message.id);
      const local=globalMessages?.find(m=>String(m.id)===String(res.message.id)); if(local) local.type=res.message.type;
    } catch (err) { appendGlobalMessage(me.username, `Failed to send: ${err.message}`, false, "text"); }
    return;
  }

  if (activeConversation.type === "group") {
    const groupId = activeConversation.id;
    const sendBody = detectedType === "gif" ? gif : detectedType === "youtube" ? yt : body;
    appendGroupMessage(groupId, me.username, sendBody, true, detectedType, {
      nameColor: me.nameColor, avatarUrl: me.avatarUrl, reply: replyPayload,
    });
    try {
      const res = await apiPost(`/api/groups/${groupId}/messages`, { body: sendBody, type: detectedType, replyTo: reply ? reply.id : undefined });
      replaceGroupMessageBody(groupId, sendBody, res.message.body, res.message.id);
      const local = groupMessageCache.get(groupId)?.find((m) => String(m.id) === String(res.message.id)); if (local) local.type = res.message.type;
    } catch (err) { appendGroupMessage(groupId, me.username, `Failed to send: ${err.message}`, false, "text"); }
    return;
  }

  const to = activeConversation.username;
  appendMessage(to, detectedType === "gif" ? gif : detectedType === "youtube" ? yt : body, true, detectedType, { reply: replyPayload });
  bumpConversationPreview(to, detectedType === "gif" ? "GIF" : detectedType === "youtube" ? yt : body, detectedType);
  try {
    const sentBody=detectedType === "gif" ? gif : detectedType === "youtube" ? yt : body;
    const res = await apiPost("/api/messages", { to, body: sentBody, type: detectedType, replyTo: reply ? reply.id : undefined });
    replaceMessageBody(to, sentBody, res.message.body, res.message.id);
    const list=threadCache.get(to)||[], local=[...list].reverse().find(m=>String(m.id)===String(res.message.id)); if(local) local.type=res.message.type;
  } catch (err) { appendMessage(to, `Failed to send: ${err.message}`, false, "text"); }
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
  } else if (activeConversation.type === "group") {
    socketRef.emit("typing", { scope: "group", to: activeConversation.id, active });
  } else {
    socketRef.emit("typing", { scope: "dm", to: activeConversation.username, active });
  }
}

els.composerInput.addEventListener("input", () => {
  sendTypingPing(els.composerInput.value.trim().length > 0);
});

function typingKeyFor(scope, from, channel) {
  if (scope === "global") return "global";
  if (scope === "group") return `group:${channel}`;
  return `dm:${from.toLowerCase()}`;
}

function noteTyping(scope, from, active, channel) {
  // Only worth showing if we're actually looking at that conversation.
  const isGlobal = scope === "global";
  const isGroup = scope === "group";
  const relevant = isGlobal
    ? activeConversation && activeConversation.type === "global"
    : isGroup
    ? isActiveGroup(channel)
    : isActiveDm(from);

  const key = typingKeyFor(scope, from, channel);
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
  const kind = activeConversation ? activeConversation.type : null;
  const key =
    kind === "global"
      ? "global"
      : kind === "group"
      ? typingKeyFor("group", null, activeConversation.id)
      : activeConversation
      ? typingKeyFor("dm", activeConversation.username)
      : null;
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

function closeGifPanel(){els.gifPanel?.classList.add("is-hidden")}
async function sendSelectedGif(url){
  if(!activeConversation) return;
  if(activeConversation.type==="global"){
    appendGlobalMessage(me.username,url,true,"gif",{nameColor:me.nameColor,avatarUrl:me.avatarUrl});
    const r=await apiPost("/api/global/messages",{body:url,type:"gif"});
    const local=globalMessages?.find(m=>String(m.id)===String(r.message.id)); if(local){local.body=r.message.body;local.type="gif";renderGlobalMessages?.();}
    return;
  }
  if(activeConversation.type==="group"){
    const groupId=activeConversation.id;
    appendGroupMessage(groupId,me.username,url,true,"gif",{nameColor:me.nameColor,avatarUrl:me.avatarUrl});
    const r=await apiPost(`/api/groups/${groupId}/messages`,{body:url,type:"gif"});
    replaceGroupMessageBody(groupId,url,r.message.body,r.message.id);
    return;
  }
  const to=activeConversation.username;
  appendMessage(to,url,true,"gif");bumpConversationPreview(to,"GIF","gif");
  const r=await apiPost("/api/messages",{to,body:url,type:"gif"});
  replaceMessageBody(to,url,r.message.body,r.message.id);
}
els.gifBtn?.addEventListener("click",()=>{els.gifPanel.classList.toggle("is-hidden");if(!els.gifPanel.classList.contains("is-hidden"))els.gifSearch.focus()});let gifTimer=null;els.gifSearch?.addEventListener("input",()=>{clearTimeout(gifTimer);gifTimer=setTimeout(async()=>{const q=els.gifSearch.value.trim();if(!q){els.gifResults.innerHTML="";return}try{const d=await apiGet(`/api/gifs/search?q=${encodeURIComponent(q)}`);els.gifResults.innerHTML=(d.results||[]).map(x=>`<button type="button" class="gif-result" data-gif-url="${escapeHtml(x.gifUrl)}"><img src="${escapeHtml(gifDisplayUrl(x.previewUrl||x.gifUrl))}" alt="GIF" /></button>`).join("")||"No GIFs found."}catch(e){els.gifResults.textContent=e.message}},350)});els.gifResults?.addEventListener("click",async e=>{const b=e.target.closest("[data-gif-url]");if(!b||!activeConversation)return;try{const url=b.dataset.gifUrl;await sendSelectedGif(url);closeGifPanel();}catch(err){els.composerError.textContent=err.message}});

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
  if (!els.plusMenu.classList.contains("is-hidden")) closePlusMenu();
  if (!els.cameraOverlay.classList.contains("is-hidden")) closeCamera();
  if (!els.voiceOverlay.classList.contains("is-hidden")) closeVoice();
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
  const isGroup = activeConversation.type === "group";
  const to = isGlobal || isGroup ? null : activeConversation.username;

  if (isGlobal) appendGlobalMessage(me.username, previewUrl, true, "image", { nameColor: me.nameColor, avatarUrl: me.avatarUrl });
  else if (isGroup) appendGroupMessage(activeConversation.id, me.username, previewUrl, true, "image", { nameColor: me.nameColor, avatarUrl: me.avatarUrl });
  else {
    appendMessage(to, previewUrl, true, "image");
    bumpConversationPreview(to, previewUrl, "image");
  }

  const formData = new FormData();
  if (to) formData.append("to", to);
  formData.append("image", file);

  try {
    const uploadUrl = isGlobal
      ? "/api/global/messages/image"
      : isGroup
      ? `/api/groups/${activeConversation.id}/messages/image`
      : "/api/messages/image";
    const res = await fetch(uploadUrl, {
      method: "POST",
      credentials: "same-origin",
      body: formData,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "Upload failed.");
    if (isGlobal) {
      replaceGlobalMessageBody(previewUrl, data.message.body, data.message.id);
    } else if (isGroup) {
      replaceGroupMessageBody(activeConversation.id, previewUrl, data.message.body, data.message.id);
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

// ---- Sending a recorded voice or video clip ----------------------------------
// Mirrors sendImage above, but for a Blob captured via MediaRecorder rather
// than a picked File. `kind` is "audio" or "video" and drives the upload
// endpoint, the field name, and the message type.
// Mirrors the server's baseMimeType() — MediaRecorder's Blob.type usually
// carries a codec suffix (e.g. "audio/webm;codecs=opus"), so compare on the
// base type only rather than the exact string.
function baseMimeType(mimeType) {
  return String(mimeType || "").split(";")[0].trim().toLowerCase();
}

const MAX_AUDIO_BYTES = 10 * 1024 * 1024;
const MAX_VIDEO_BYTES = 25 * 1024 * 1024;

// A blob's `type` alone isn't enough — when the file gets downloaded again
// later (or re-uploaded elsewhere) it needs a real extension, or nothing on
// the other end knows what it is. This is also what fixes files coming back
// out "in a weird format": they were never missing data, just a filename.
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

function filenameForBlob(blob, kind) {
  const base = baseMimeType(blob.type);
  const ext = EXTENSION_BY_MIME[base] || base.split("/")[1] || "webm";
  const stem = kind === "audio" ? "voice-message" : "video-message";
  return `${stem}.${ext}`;
}

async function sendRecordedMedia(blob, kind) {
  els.composerError.textContent = "";
  if (!activeConversation) {
    els.composerError.textContent = "Open a conversation first.";
    return false;
  }

  // Match the server's fileFilter: accept any real audio/* or video/* type
  // rather than a hardcoded codec allowlist, since MediaRecorder's exact
  // output string varies by browser.
  const maxBytes = kind === "audio" ? MAX_AUDIO_BYTES : MAX_VIDEO_BYTES;
  if (!baseMimeType(blob.type).startsWith(`${kind}/`)) {
    console.error(`Recorded ${kind} blob has unexpected type:`, blob.type);
    els.composerError.textContent = "That recording format isn't supported.";
    return false;
  }
  if (blob.size > maxBytes) {
    els.composerError.textContent = kind === "audio" ? "Voice messages are limited to 10MB." : "Videos are limited to 25MB.";
    return false;
  }

  const previewUrl = URL.createObjectURL(blob);
  const isGlobal = activeConversation.type === "global";
  const isGroup = activeConversation.type === "group";
  const to = isGlobal || isGroup ? null : activeConversation.username;

  if (isGlobal) appendGlobalMessage(me.username, previewUrl, true, kind, { nameColor: me.nameColor, avatarUrl: me.avatarUrl });
  else if (isGroup) appendGroupMessage(activeConversation.id, me.username, previewUrl, true, kind, { nameColor: me.nameColor, avatarUrl: me.avatarUrl });
  else {
    appendMessage(to, previewUrl, true, kind);
    bumpConversationPreview(to, previewUrl, kind);
  }

  const formData = new FormData();
  if (to) formData.append("to", to);
  formData.append(kind, blob, filenameForBlob(blob, kind));

  try {
    const uploadUrl = isGlobal
      ? `/api/global/messages/${kind}`
      : isGroup
      ? `/api/groups/${activeConversation.id}/messages/${kind}`
      : `/api/messages/${kind}`;
    const res = await fetch(uploadUrl, {
      method: "POST",
      credentials: "same-origin",
      body: formData,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "Upload failed.");
    if (isGlobal) {
      replaceGlobalMessageBody(previewUrl, data.message.body, data.message.id);
    } else if (isGroup) {
      replaceGroupMessageBody(activeConversation.id, previewUrl, data.message.body, data.message.id);
    } else {
      replaceMessageBody(to, previewUrl, data.message.body, data.message.id);
      bumpConversationPreview(to, data.message.body, kind);
    }
    return true;
  } catch (err) {
    console.error(`${kind} upload failed:`, err);
    els.composerError.textContent = err.message;
    if (isGlobal) removeGlobalMessageByPreview(previewUrl);
    else if (isGroup) removeGroupMessageByPreview(activeConversation.id, previewUrl);
    else removeMessageByPreview(to, previewUrl);
    return false;
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

// ---- "+" menu: voice message / camera photo / camera video ------------------
function openPlusMenu() {
  els.plusMenu.classList.remove("is-hidden");
  els.plusBtn.classList.add("active");
}

function closePlusMenu() {
  els.plusMenu.classList.add("is-hidden");
  els.plusBtn.classList.remove("active");
}

els.plusBtn.addEventListener("click", () => {
  if (!activeConversation) {
    els.composerError.textContent = "Open a conversation first.";
    return;
  }
  if (els.plusMenu.classList.contains("is-hidden")) openPlusMenu();
  else closePlusMenu();
});

document.addEventListener("click", (e) => {
  if (els.plusMenu.classList.contains("is-hidden")) return;
  if (els.plusMenu.contains(e.target) || els.plusBtn.contains(e.target)) return;
  closePlusMenu();
});

function hasMediaDeviceSupport() {
  return Boolean(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
}

function pickSupportedMimeType(candidates) {
  if (typeof MediaRecorder === "undefined" || !MediaRecorder.isTypeSupported) return null;
  return candidates.find((t) => MediaRecorder.isTypeSupported(t)) || null;
}

function formatRecTime(ms) {
  const totalSeconds = Math.floor(ms / 1000);
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

// Small stopwatch used by both the camera and voice modals to show a
// pulsing "● 0:0X" indicator while recording.
function makeRecTimer(indicatorEl, timerEl) {
  let startedAt = 0;
  let interval = null;
  return {
    start() {
      startedAt = Date.now();
      timerEl.textContent = "0:00";
      indicatorEl.classList.remove("is-hidden");
      interval = setInterval(() => {
        timerEl.textContent = formatRecTime(Date.now() - startedAt);
      }, 250);
    },
    stop() {
      if (interval) clearInterval(interval);
      interval = null;
      indicatorEl.classList.add("is-hidden");
    },
  };
}

const cameraTimer = makeRecTimer(els.cameraRecIndicator, els.cameraRecTimer);
const voiceTimer = makeRecTimer(els.voiceRecIndicator, els.voiceRecTimer);

// ---- Camera modal: take a selfie photo, or record a selfie video ------------
let cameraStream = null;
let cameraMode = null; // "photo" | "video"
let cameraRecorder = null;
let cameraChunks = [];
let cameraCapturedBlob = null;
let cameraRecording = false;

function stopCameraStream() {
  if (cameraStream) {
    cameraStream.getTracks().forEach((t) => t.stop());
    cameraStream = null;
  }
  els.cameraVideo.srcObject = null;
}

function resetCameraStage() {
  els.cameraVideo.classList.remove("is-hidden");
  els.cameraPhotoPreview.classList.add("is-hidden");
  els.cameraPhotoPreview.removeAttribute("src");
  els.cameraVideoPreview.classList.add("is-hidden");
  els.cameraVideoPreview.pause();
  els.cameraVideoPreview.removeAttribute("src");
  els.cameraVideoPreview.load();
  els.cameraControls.classList.remove("is-hidden");
  els.cameraReviewControls.classList.add("is-hidden");
  els.cameraShutter.disabled = false;
  els.cameraShutter.textContent = cameraMode === "video" ? "Start recording" : "Take photo";
  cameraTimer.stop();
  els.cameraError.textContent = "";
  cameraCapturedBlob = null;
  cameraRecording = false;
}

async function startCameraStream() {
  if (!hasMediaDeviceSupport()) {
    els.cameraError.textContent = "Your browser doesn't support camera access.";
    return;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: cameraMode === "video" });
    cameraStream = stream;
    els.cameraVideo.srcObject = stream;
  } catch (err) {
    els.cameraError.textContent = "Couldn't access your camera — check your browser's camera permissions.";
  }
}

function openCamera(mode) {
  closePlusMenu();
  if (!activeConversation) {
    els.composerError.textContent = "Open a conversation first.";
    return;
  }
  cameraMode = mode;
  els.cameraModalTitle.textContent = mode === "photo" ? "Take a photo" : "Record a video";
  resetCameraStage();
  els.cameraOverlay.classList.remove("is-hidden");
  startCameraStream();
}

function closeCamera() {
  if (cameraRecorder && cameraRecorder.state !== "inactive") cameraRecorder.stop();
  stopCameraStream();
  cameraTimer.stop();
  els.cameraOverlay.classList.add("is-hidden");
  resetCameraStage();
}

function capturePhoto() {
  const video = els.cameraVideo;
  if (!video.videoWidth) {
    els.cameraError.textContent = "Camera isn't ready yet — try again in a moment.";
    return;
  }
  const canvas = els.cameraCanvas;
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  canvas.getContext("2d").drawImage(video, 0, 0, canvas.width, canvas.height);
  canvas.toBlob(
    (blob) => {
      if (!blob) {
        els.cameraError.textContent = "Couldn't capture the photo.";
        return;
      }
      cameraCapturedBlob = blob;
      els.cameraPhotoPreview.src = URL.createObjectURL(blob);
      els.cameraVideo.classList.add("is-hidden");
      els.cameraPhotoPreview.classList.remove("is-hidden");
      els.cameraControls.classList.add("is-hidden");
      els.cameraReviewControls.classList.remove("is-hidden");
      stopCameraStream();
    },
    "image/jpeg",
    0.92
  );
}

function startVideoRecording() {
  if (!cameraStream) return;
  cameraChunks = [];
  const mimeType = pickSupportedMimeType(["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm", "video/mp4"]);
  try {
    cameraRecorder = new MediaRecorder(cameraStream, mimeType ? { mimeType } : undefined);
  } catch (err) {
    console.error("Video MediaRecorder setup failed:", err);
    els.cameraError.textContent = "Video recording isn't supported in this browser.";
    return;
  }
  cameraRecorder.ondataavailable = (e) => {
    if (e.data && e.data.size) cameraChunks.push(e.data);
  };
  cameraRecorder.onerror = (e) => {
    console.error("Video MediaRecorder error:", e.error || e);
    els.cameraError.textContent = "Recording failed — please try again.";
  };
  cameraRecorder.onstop = () => {
    if (!cameraChunks.length) {
      console.error("Video recording produced no data.");
      els.cameraError.textContent = "That recording came out empty — please try again.";
      stopCameraStream();
      resetCameraStage();
      return;
    }
    const blob = new Blob(cameraChunks, { type: cameraRecorder.mimeType || "video/webm" });
    cameraCapturedBlob = blob;
    els.cameraVideoPreview.src = URL.createObjectURL(blob);
    els.cameraVideo.classList.add("is-hidden");
    els.cameraVideoPreview.classList.remove("is-hidden");
    els.cameraControls.classList.add("is-hidden");
    els.cameraReviewControls.classList.remove("is-hidden");
    stopCameraStream();
  };
  // Passing a timeslice makes the recorder flush chunks periodically instead
  // of only buffering everything until stop() — without it, some browsers
  // (particularly on Android) can hand back an empty blob if stop() is
  // called very soon after start().
  cameraRecorder.start(250);
  cameraRecording = true;
  els.cameraShutter.textContent = "Stop recording";
  cameraTimer.start();
}

function stopVideoRecording() {
  if (cameraRecorder && cameraRecorder.state !== "inactive") cameraRecorder.stop();
  cameraRecording = false;
  cameraTimer.stop();
}

els.cameraShutter.addEventListener("click", () => {
  if (cameraMode === "photo") capturePhoto();
  else if (!cameraRecording) startVideoRecording();
  else stopVideoRecording();
});

els.cameraRetake.addEventListener("click", () => {
  resetCameraStage();
  startCameraStream();
});

els.cameraSend.addEventListener("click", () => {
  if (!cameraCapturedBlob) return;
  if (cameraMode === "photo") {
    sendImage(new File([cameraCapturedBlob], "selfie.jpg", { type: cameraCapturedBlob.type }));
  } else {
    sendRecordedMedia(cameraCapturedBlob, "video");
  }
  closeCamera();
});

els.cameraClose.addEventListener("click", closeCamera);
els.cameraOverlay.addEventListener("click", (e) => {
  if (e.target === els.cameraOverlay) closeCamera();
});

// ---- Voice modal: record and send a voice message ----------------------------
let voiceStream = null;
let voiceRecorder = null;
let voiceChunks = [];
let voiceCapturedBlob = null;
let voiceRecording = false;

function stopVoiceStream() {
  if (voiceStream) {
    voiceStream.getTracks().forEach((t) => t.stop());
    voiceStream = null;
  }
}

function resetVoiceStage() {
  els.voicePreview.classList.add("is-hidden");
  els.voicePreview.pause();
  els.voicePreview.removeAttribute("src");
  els.voicePreview.load();
  els.voiceMicIcon.classList.remove("is-hidden");
  els.voiceControls.classList.remove("is-hidden");
  els.voiceReviewControls.classList.add("is-hidden");
  els.voiceRecordBtn.textContent = "Start recording";
  els.voiceRecordBtn.disabled = false;
  voiceTimer.stop();
  els.voiceError.textContent = "";
  voiceCapturedBlob = null;
  voiceRecording = false;
}

function openVoice() {
  closePlusMenu();
  if (!activeConversation) {
    els.composerError.textContent = "Open a conversation first.";
    return;
  }
  resetVoiceStage();
  els.voiceOverlay.classList.remove("is-hidden");
}

function closeVoice() {
  if (voiceRecorder && voiceRecorder.state !== "inactive") voiceRecorder.stop();
  stopVoiceStream();
  voiceTimer.stop();
  els.voiceOverlay.classList.add("is-hidden");
  resetVoiceStage();
}

async function toggleVoiceRecording() {
  if (voiceRecording) {
    if (voiceRecorder && voiceRecorder.state !== "inactive") voiceRecorder.stop();
    voiceRecording = false;
    voiceTimer.stop();
    return;
  }

  if (!hasMediaDeviceSupport()) {
    els.voiceError.textContent = "Your browser doesn't support microphone access.";
    return;
  }
  els.voiceError.textContent = "";

  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (err) {
    console.error("getUserMedia(audio) failed:", err);
    els.voiceError.textContent = "Couldn't access your microphone — check your browser's microphone permissions.";
    return;
  }
  voiceStream = stream;
  voiceChunks = [];
  const mimeType = pickSupportedMimeType(["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/mp4"]);
  try {
    voiceRecorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
  } catch (err) {
    console.error("Audio MediaRecorder setup failed:", err);
    els.voiceError.textContent = "Voice recording isn't supported in this browser.";
    stopVoiceStream();
    return;
  }
  voiceRecorder.ondataavailable = (e) => {
    if (e.data && e.data.size) voiceChunks.push(e.data);
  };
  voiceRecorder.onerror = (e) => {
    console.error("Audio MediaRecorder error:", e.error || e);
    els.voiceError.textContent = "Recording failed — please try again.";
  };
  voiceRecorder.onstop = () => {
    if (!voiceChunks.length) {
      console.error("Voice recording produced no data.");
      els.voiceError.textContent = "That recording came out empty — please try again.";
      stopVoiceStream();
      resetVoiceStage();
      return;
    }
    const blob = new Blob(voiceChunks, { type: voiceRecorder.mimeType || "audio/webm" });
    voiceCapturedBlob = blob;
    els.voicePreview.src = URL.createObjectURL(blob);
    els.voicePreview.classList.remove("is-hidden");
    els.voiceMicIcon.classList.add("is-hidden");
    els.voiceControls.classList.add("is-hidden");
    els.voiceReviewControls.classList.remove("is-hidden");
    stopVoiceStream();
  };
  // See the matching comment in startVideoRecording — a timeslice avoids an
  // empty blob if the recording is stopped very soon after it starts.
  voiceRecorder.start(250);
  voiceRecording = true;
  els.voiceRecordBtn.textContent = "Stop recording";
  voiceTimer.start();
}

els.voiceRecordBtn.addEventListener("click", toggleVoiceRecording);
els.voiceRetake.addEventListener("click", resetVoiceStage);
els.voiceSend.addEventListener("click", () => {
  if (!voiceCapturedBlob) return;
  sendRecordedMedia(voiceCapturedBlob, "audio");
  closeVoice();
});
els.voiceClose.addEventListener("click", closeVoice);
els.voiceOverlay.addEventListener("click", (e) => {
  if (e.target === els.voiceOverlay) closeVoice();
});

els.plusVoice.addEventListener("click", openVoice);
els.plusPhoto.addEventListener("click", () => openCamera("photo"));
els.plusVideo.addEventListener("click", () => openCamera("video"));

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
  if (els.adminModeError) els.adminModeError.textContent = "";
  if (els.adminModePassword) els.adminModePassword.value = "";
  if (els.adminModeStatus) els.adminModeStatus.textContent = me?.isAdmin
    ? "Admin mode is enabled permanently on this account."
    : "Admin mode lets you edit and delete anyone's messages in Global Chat.";
  if (els.adminModeForm) els.adminModeForm.classList.toggle("is-hidden", Boolean(me?.isAdmin));
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

els.adminModeForm?.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (me?.isAdmin) return;
  const password = els.adminModePassword.value;
  els.adminModeError.textContent = "";
  try {
    await apiPost("/api/admin-mode", { password });
    me.isAdmin = true;
    els.adminModePassword.value = "";
    els.adminModeForm.classList.add("is-hidden");
    els.adminModeStatus.textContent = "Admin mode is enabled permanently on this account.";
    renderThread();
  } catch (err) {
    els.adminModeError.textContent = err.message;
  }
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

function notifyNewGroupMessage(groupId, from, body, type) {
  if (!("Notification" in window)) return;
  if (Notification.permission !== "granted") return;
  if (isActiveGroup(groupId) && document.hasFocus()) return;

  const group = groups.find((g) => g.id === groupId);
  const groupName = group ? groupDisplayName(group) : "a group";
  const n = new Notification(`${from} in ${groupName}`, {
    body: type === "image" ? "📷 Sent a photo" : body,
    tag: `group-${groupId}`,
  });
  n.onclick = () => {
    window.focus();
    openGroupThread(groupId);
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
  await loadGroups();

  try {
    const presence = await apiGet("/api/presence");
    (presence.active || []).forEach((u) => activeUsernames.add(u.toLowerCase()));
    renderConversationList();
  } catch {
    // Non-critical — presence dots just won't show until the first live update.
  }

  try {
    const online = await apiGet("/api/online");
    (online.online || []).forEach((u) => onlineUsers.set(u.toLowerCase(), u));
    renderOnlineBadges();
  } catch {
    // Non-critical — the headcount just won't show until the first live update.
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

  socket.on("group-message", ({ groupId, id, sender, nameColor, avatarUrl, body, type, reply }) => {
    const active = isActiveGroup(groupId) && document.hasFocus();
    appendGroupMessage(groupId, sender, body, false, type || "text", { id, nameColor, avatarUrl, reply });
    if (type !== "system") {
      notifyNewGroupMessage(groupId, sender, body, type || "text");
      noteTyping("group", sender, false, groupId);
    }
    if (active) markGroupRead(groupId);
  });

  socket.on("group-message-edited", ({ groupId, id, body }) => {
    const list = groupMessageCache.get(groupId);
    const msg = list && list.find((m) => String(m.id) === String(id));
    if (msg) {
      msg.body = body;
      msg.edited = true;
      if (isActiveGroup(groupId)) renderThread();
    }
  });

  socket.on("group-message-deleted", ({ groupId, id }) => {
    if (removeGroupMessageEverywhere(id) && isActiveGroup(groupId)) renderThread();
  });

  // Fired on group creation, rename, and adding members — same shape each
  // time, so one handler upserts the group whether we already had it or not.
  socket.on("group-updated", (payload) => {
    upsertGroup(payload);
    renderConversationList();
    if (isActiveGroup(payload.id)) updateGroupThreadTitle(payload.id);
  });

  socket.on("group-member-left", ({ id, members }) => {
    const g = groups.find((x) => x.id === id);
    if (g) {
      g.members = members;
      renderConversationList();
      if (isActiveGroup(id)) updateGroupThreadTitle(id);
    }
  });

  socket.on("typing", ({ from, active }) => noteTyping("dm", from, active));
  socket.on("global-typing", ({ username, active }) => noteTyping("global", username, active));
  socket.on("group-typing", ({ groupId, username, active }) => noteTyping("group", username, active, groupId));

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

  socket.on("online-changed", ({ username, online }) => {
    const key = username.toLowerCase();
    if (online) onlineUsers.set(key, username);
    else onlineUsers.delete(key);
    renderOnlineBadges();
  });

  // If a DM thread is open when the tab regains focus, treat its messages
  // as read now rather than waiting for the next interaction.
  window.addEventListener("focus", () => {
    if (activeConversation && activeConversation.type === "dm") {
      markRead(activeConversation.username);
    } else if (activeConversation && activeConversation.type === "group") {
      markGroupRead(activeConversation.id);
    }
  });
})();
