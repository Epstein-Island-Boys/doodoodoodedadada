// messages.js — the actual chat app: conversation list, opening a thread,
// sending messages, and receiving them live over the socket.

let me = null;
let activeUsername = null; // who the open thread is with
let conversations = []; // [{username, body, created_at}]
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
  thread: document.getElementById("thread"),
  composer: document.getElementById("composer"),
  composerInput: document.getElementById("composer-input"),
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
        <div class="conv-preview">${escapeHtml(c.body)}</div>
      </button>`
    )
    .join("");

  els.convList.querySelectorAll(".conversation-item").forEach((btn) => {
    btn.addEventListener("click", () => openThread(btn.dataset.username));
  });
}

function bumpConversationPreview(username, body) {
  const existing = conversations.find((c) => c.username === username);
  if (existing) {
    existing.body = body;
  } else {
    conversations.unshift({ username, body, created_at: new Date().toISOString() });
  }
  conversations.sort((a) => (a.username === username ? -1 : 0));
  renderConversationList();
}

async function openThread(username) {
  activeUsername = username;
  els.emptyState.hidden = true;
  els.threadView.hidden = false;
  els.threadTitle.textContent = "@" + username;
  els.sidebar.classList.add("hide-on-mobile");
  els.main.classList.remove("hide-on-mobile");
  renderConversationList();

  if (!threadCache.has(username)) {
    const data = await apiGet(`/api/messages/${encodeURIComponent(username)}`);
    threadCache.set(username, data.messages || []);
  }
  renderThread();
  els.composerInput.focus();
}

function renderThread() {
  const messages = threadCache.get(activeUsername) || [];
  els.thread.innerHTML = messages
    .map(
      (m) => `<div class="bubble ${m.mine ? "mine" : "theirs"}">${escapeHtml(m.body)}</div>`
    )
    .join("");
  els.thread.scrollTop = els.thread.scrollHeight;
}

function appendMessage(username, body, mine) {
  const list = threadCache.get(username) || [];
  list.push({ body, mine, created_at: new Date().toISOString() });
  threadCache.set(username, list);
  if (username === activeUsername) renderThread();
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

// ---- Sending a message in the open thread -----------------------------------
els.composer.addEventListener("submit", async (e) => {
  e.preventDefault();
  const body = els.composerInput.value.trim();
  if (!body || !activeUsername) return;
  els.composerInput.value = "";
  appendMessage(activeUsername, body, true);
  bumpConversationPreview(activeUsername, body);
  try {
    await apiPost("/api/messages", { to: activeUsername, body });
  } catch (err) {
    appendMessage(activeUsername, `Failed to send: ${err.message}`, false);
  }
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
  socket.on("message", ({ from, body }) => {
    appendMessage(from, body, false);
    bumpConversationPreview(from, body);
  });
})();
