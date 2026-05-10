
// ============= STATE =============
const state = {
  peer: null,
  myId: null,
  contacts: new Map(), // peerId -> { id, name, color, messages, conn, status }
  activePeerId: null,
  incomingCall: null,
  activeCall: null,    // { peerId, type: 'audio'|'video', call, localStream, remoteStream }
  callTimerInterval: null,
  callStartTime: null,
  ringAudioCtx: null,
  ringTimer: null,
  notificationPermissionAsked: false,
};

const COLORS = ["#FF6B9D", "#4ECDC4", "#5B8FF9", "#F39C12", "#8E44AD", "#E74C3C", "#16A085", "#3498DB", "#9B59B6", "#E67E22"];
const STORAGE_KEY = "chatwave_v3";
const OLD_STORAGE_KEYS = ["chatwave_v2", "chatwave_v1", "whatsclone_v4"];

function loadSavedData() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY) || OLD_STORAGE_KEYS.map(k => localStorage.getItem(k)).find(Boolean);
    if (!raw) return { myId: null, contacts: [] };
    const data = JSON.parse(raw);
    return {
      myId: typeof data.myId === "string" ? data.myId : null,
      contacts: Array.isArray(data.contacts) ? data.contacts : [],
    };
  } catch (e) {
    return { myId: null, contacts: [] };
  }
}

function normalizeStoredMessages(messages) {
  if (!Array.isArray(messages)) return [];
  return messages
    .filter((m) => m && typeof m.text === "string" && (m.from === "me" || m.from === "them" || m.from === "system"))
    .slice(-500)
    .map((m, index) => ({
      id: m.id || (Date.now() + index + Math.random()),
      text: m.text,
      from: m.from,
      time: m.time || nowTime(),
      status: m.status || (m.from === "me" ? "pending" : "read"),
    }));
}

function saveStorage() {
  const contacts = [...state.contacts.values()].map((c) => ({
    id: c.id,
    name: c.name,
    color: c.color,
    messages: normalizeStoredMessages(c.messages),
  }));
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ myId: state.myId, contacts, savedAt: Date.now() }));
}

function restoreContacts(savedContacts) {
  savedContacts.forEach((c) => {
    if (!c.id) return;
    state.contacts.set(c.id, {
      id: c.id,
      name: c.name || c.id,
      color: c.color || COLORS[Math.abs(hashCode(c.id)) % COLORS.length],
      messages: normalizeStoredMessages(c.messages),
      conn: null,
      status: "disconnected",
    });
  });
  if (state.contacts.size > 0) {
    state.activePeerId = null;
    renderContactsList();
    renderChatPanel();
    closeMobileChat();
    document.getElementById("onboard").style.display = "none";
    document.getElementById("app").classList.add("active");
  }
}

// ============= INIT =============
function init() {
  const saved = loadSavedData();
  const initialId = saved.myId || generateNumericId();
  state.peer = new Peer(initialId, {
    debug: 1,
    config: { iceServers: [
      { urls: "stun:stun.l.google.com:19302" },
      { urls: "stun:global.stun.twilio.com:3478" }
    ]}
  });

  state.peer.on("open", (id) => {
    state.myId = id;
    document.getElementById("myIdText").textContent = id;
    document.getElementById("myIdDisplay").classList.remove("loading");
    document.getElementById("copyMyIdBtn").style.display = "inline-block";
    document.getElementById("connectBtn").disabled = false;
    document.getElementById("sidebarIdText").textContent = id.slice(0, 14) + "…";
    saveStorage();
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(id).catch(() => {});
    }

    // Enter the app immediately. Users can add friends and start typing without waiting.
    document.getElementById("onboard").style.display = "none";
    document.getElementById("app").classList.add("active");
    renderContactsList();
    renderChatPanel();
    closeMobileChat();
    reconnectAllContacts();
  });

  state.peer.on("connection", handleIncomingDataConn);
  state.peer.on("call", handleIncomingMediaCall);

  state.peer.on("error", (err) => {
    console.error("Peer error:", err);
    if (err.type === "peer-unavailable") {
      toast("That ID isn't online or doesn't exist.");
    } else if (err.type === "network") {
      toast("Network error. Check your connection.");
    } else {
      toast("Connection error: " + err.type);
    }
  });

  state.peer.on("disconnected", () => {
    toast("Disconnected from server. Reconnecting…");
    state.peer.reconnect();
  });

  bindUI();
  const savedData = loadSavedData();
  if (savedData.contacts.length > 0) {
    restoreContacts(savedData.contacts);
  }
}

function bindUI() {
  ["connectBtn", "addContactBtn", "newPeerConnectBtn", "sendMsgBtn", "audioCallBtn", "videoCallBtn"].forEach((id) => {
    document.addEventListener("click", (e) => {
      if (e.target && (e.target.id === id || e.target.closest?.("#" + id))) requestNotificationPermission();
    }, { passive: true });
  });
  document.getElementById("copyMyIdBtn").onclick = () => copyId(state.myId, "copyMyIdBtn");
  document.getElementById("myIdPill").onclick = () => copyId(state.myId);
  document.getElementById("connectBtn").onclick = onboardConnect;
  const friendIdInput = document.getElementById("friendIdInput");
  friendIdInput.onkeydown = (e) => { if (e.key === "Enter") onboardConnect(); };
  friendIdInput.oninput = (e) => { e.target.value = e.target.value.replace(/\D/g, ""); };

  document.getElementById("addContactBtn").onclick = () => {
    const bar = document.getElementById("addBar");
    if (!bar) return;
    const isHidden = bar.classList.contains("hidden");
    if (isHidden) {
      bar.classList.remove("hidden");
      document.getElementById("newPeerIdInput").focus();
    } else {
      bar.classList.add("hidden");
    }
  };
  document.getElementById("newPeerConnectBtn").onclick = sidebarAddContact;
  const newPeerIdInput = document.getElementById("newPeerIdInput");
  newPeerIdInput.onkeydown = (e) => { if (e.key === "Enter") sidebarAddContact(); };
  newPeerIdInput.oninput = (e) => { e.target.value = e.target.value.replace(/\D/g, ""); };

  document.getElementById("acceptCallBtn").onclick = acceptCall;
  document.getElementById("declineCallBtn").onclick = declineCall;
  document.getElementById("hangupBtn").onclick = endCall;
  document.getElementById("muteBtn").onclick = toggleMute;
  document.getElementById("cameraBtn").onclick = toggleCamera;
}

function onboardConnect() {
  const id = document.getElementById("friendIdInput").value.trim();
  const name = document.getElementById("friendNameInput").value.trim();
  if (!id) return;
  if (!/^\d+$/.test(id)) { toast("ID must use digits only."); return; }
  if (id === state.myId) { toast("That's your own ID."); return; }

  // Show app
  document.getElementById("onboard").style.display = "none";
  document.getElementById("app").classList.add("active");

  initiateConnection(id, name);
  state.activePeerId = null;
  renderContactsList();
  renderChatPanel();
  closeMobileChat();
  toast("Friend added. Tap the name and start chatting.");
  document.getElementById("friendIdInput").value = "";
  document.getElementById("friendNameInput").value = "";
}

function sidebarAddContact() {
  const id = document.getElementById("newPeerIdInput").value.trim();
  if (!id) return;
  if (!/^\d+$/.test(id)) { toast("ID must use digits only."); return; }
  if (id === state.myId) { toast("That's your own ID."); return; }
  if (state.contacts.has(id)) {
    setActiveContact(id);
    document.getElementById("newPeerIdInput").value = "";
    document.getElementById("addBar").classList.add("hidden");
    return;
  }
  initiateConnection(id);
  state.activePeerId = null;
  renderContactsList();
  renderChatPanel();
  closeMobileChat();
  toast("Friend added. Tap the name and start chatting.");
  document.getElementById("newPeerIdInput").value = "";
  document.getElementById("addBar").classList.add("hidden");
}

function editContactName(peerId) {
  const c = state.contacts.get(peerId);
  if (!c) return;
  const newName = prompt("Edit friend name:", c.name);
  if (newName && newName.trim() && newName.trim() !== c.name) {
    c.name = newName.trim();
    saveStorage();
    renderContactsList();
    if (peerId === state.activePeerId) renderChatPanel();
    toast("Friend name updated.");
  }
}

function deleteContact(peerId) {
  const c = state.contacts.get(peerId);
  if (!c) return;
  if (!confirm(`Delete contact "${c.name}"?`)) return;
  state.contacts.delete(peerId);
  saveStorage();
  if (state.activePeerId === peerId) {
    state.activePeerId = null;
    closeMobileChat();
  }
  renderContactsList();
  renderChatPanel();
}

// ============= CONNECTIONS =============
function initiateConnection(peerId, name) {
  ensureContact(peerId, name);
  const c = state.contacts.get(peerId);
  if (c && c.conn && c.conn.open === true) return c.conn;
  updateContactStatus(peerId, "connecting");

  const conn = state.peer.connect(peerId, { reliable: true });
  bindDataConn(conn);
  return conn;
}

function reconnectAllContacts() {
  if (!state.peer || !state.myId) return;
  for (const c of state.contacts.values()) {
    if (c.id && c.id !== state.myId && (!c.conn || c.conn.open !== true)) {
      try { initiateConnection(c.id, c.name); } catch (e) {}
    }
  }
}

function flushPendingMessages(peerId) {
  const c = state.contacts.get(peerId);
  if (!c || !c.conn || c.conn.open !== true) return;
  c.messages
    .filter(m => m.from === "me" && m.status === "pending")
    .forEach((m) => {
      try {
        c.conn.send({ type: "message", text: m.text });
        updateMsgStatus(peerId, m, "sent");
        setTimeout(() => updateMsgStatus(peerId, m, "delivered"), 300);
        setTimeout(() => updateMsgStatus(peerId, m, "read"), 900);
      } catch (e) {
        updateMsgStatus(peerId, m, "pending");
      }
    });
}

function handleIncomingDataConn(conn) {
  ensureContact(conn.peer);
  bindDataConn(conn);
  toast("New connection from " + conn.peer.slice(0, 8) + "…");

  // Auto-show app if still on onboarding
  if (document.getElementById("app").classList.contains("active") === false) {
    document.getElementById("onboard").style.display = "none";
    document.getElementById("app").classList.add("active");
  }
}

function bindDataConn(conn) {
  const peerId = conn.peer;
  const contact = state.contacts.get(peerId);
  if (contact) contact.conn = conn;

  conn.on("open", () => {
    updateContactStatus(peerId, "connected");
    addSystemMessage(peerId, "Connection established. Messages and calls are peer-to-peer.");
    // Send a hello so the other side updates status quickly
    try { conn.send({ type: "hello", from: state.myId }); } catch (e) {}
    flushPendingMessages(peerId);
  });

  conn.on("data", (data) => {
    if (data && data.type === "message") {
      addMessage(peerId, { text: data.text, from: "them", time: nowTime(), status: "read" });
      notifyIncomingMessage(peerId, data.text);
    } else if (data && data.type === "hello") {
      // Just a handshake
    }
  });

  conn.on("close", () => {
    updateContactStatus(peerId, "disconnected");
    addSystemMessage(peerId, "Disconnected.");
  });

  conn.on("error", (e) => {
    console.error(e);
    updateContactStatus(peerId, "disconnected");
  });
}

// ============= MESSAGES =============
function sendMessage(text) {
  const peerId = state.activePeerId;
  if (!peerId) return;
  const c = state.contacts.get(peerId);
  if (!c) return;

  // Add the message immediately so the user can chat without waiting.
  const msg = { text, from: "me", time: nowTime(), status: "pending" };
  addMessage(peerId, msg);

  // If the peer is already connected, send now. If not, connect in the background and send when ready.
  if (c.conn && c.conn.open === true) {
    try {
      c.conn.send({ type: "message", text });
      updateMsgStatus(peerId, msg, "sent");
      setTimeout(() => updateMsgStatus(peerId, msg, "delivered"), 300);
      setTimeout(() => updateMsgStatus(peerId, msg, "read"), 800);
    } catch (e) {
      toast("Message saved. It will send when connected.");
    }
  } else {
    initiateConnection(peerId, c.name);
    toast("Message ready. Sending when your friend is online.");
  }
}

function addMessage(peerId, msg) {
  const c = state.contacts.get(peerId);
  if (!c) return;
  msg.id = Date.now() + Math.random();
  c.messages.push(msg);
  // Keep each chat light so localStorage does not grow too large.
  if (c.messages.length > 500) c.messages = c.messages.slice(-500);
  saveStorage();
  if (peerId === state.activePeerId) renderMessages();
  renderContactsList();
}

function addSystemMessage(peerId, text) {
  addMessage(peerId, { text, from: "system", time: nowTime() });
}

function updateMsgStatus(peerId, msg, status) {
  msg.status = status;
  saveStorage();
  if (peerId === state.activePeerId) renderMessages();
}

// ============= CONTACTS =============
function ensureContact(peerId, name) {
  if (!state.contacts.has(peerId)) {
    state.contacts.set(peerId, {
      id: peerId,
      name: name || peerId.slice(0, 8),
      color: COLORS[Math.abs(hashCode(peerId)) % COLORS.length],
      messages: [],
      conn: null,
      status: "connecting",
    });
    renderContactsList();
    saveStorage();
  } else if (name) {
    const contact = state.contacts.get(peerId);
    if (contact.name !== name) {
      contact.name = name;
      saveStorage();
    }
  }
}

function updateContactStatus(peerId, status) {
  const c = state.contacts.get(peerId);
  if (!c) return;
  c.status = status;
  renderContactsList();
  if (peerId === state.activePeerId) renderChatHeader();
}

function setActiveContact(peerId) {
  state.activePeerId = peerId;
  renderContactsList();
  renderChatPanel();
  openMobileChat();
}

function isPhoneLayout() {
  return window.matchMedia && window.matchMedia("(max-width: 768px)").matches;
}

function openMobileChat() {
  if (!isPhoneLayout()) return;
  const panel = document.getElementById("chatPanel");
  const sidebar = document.getElementById("sidebar");
  if (panel) panel.classList.add("mobile-open");
  if (sidebar) sidebar.classList.add("mobile-chat-open");
}

function closeMobileChat() {
  const panel = document.getElementById("chatPanel");
  const sidebar = document.getElementById("sidebar");
  if (panel) panel.classList.remove("mobile-open");
  if (sidebar) sidebar.classList.remove("mobile-chat-open");
}

// ============= RENDERING =============
function renderContactsList() {
  const list = document.getElementById("contactsList");
  if (state.contacts.size === 0) {
    list.classList.remove("friends-name-only");
    list.innerHTML = `
      <div class="empty-contacts">
        <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
        <div>No friend names yet.<br/>Click <strong>+</strong> to add someone.</div>
      </div>`;
    return;
  }

  list.classList.add("friends-name-only");

  const sorted = [...state.contacts.values()].sort((a, b) =>
    String(a.name || a.id).localeCompare(String(b.name || b.id))
  );

  list.innerHTML = `
    <div class="friend-list-title">Friends</div>
    <div class="friend-list-subtitle">Tap a name to chat. Tap the pencil to edit the name.</div>
    ${sorted.map((c) => {
      return `
        <div class="contact-row ${c.id === state.activePeerId ? "active" : ""}" data-id="${c.id}">
          <div class="avatar" style="background:${c.color}">${initials(c.name)}</div>
          <div class="contact-info">
            <div class="contact-name">${escapeHtml(c.name)}</div>
            <div class="friend-actions">
              <button class="edit-friend-btn" data-id="${c.id}" title="Edit friend name" aria-label="Edit friend name">
                <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>
              </button>
              <span class="open-chat-arrow">›</span>
            </div>
          </div>
        </div>`;
    }).join("")}`;

  list.querySelectorAll(".contact-row").forEach((el) => {
    el.onclick = () => setActiveContact(el.dataset.id);
  });
  
  list.querySelectorAll(".edit-friend-btn").forEach((btn) => {
    btn.onclick = (e) => {
      e.stopPropagation();
      editContactName(btn.dataset.id);
    };
  });
  
  list.querySelectorAll(".contact-row").forEach((el) => {
    el.oncontextmenu = (e) => {
      e.preventDefault();
      const peerId = el.dataset.id;
      if (confirm(`Delete this contact?`)) deleteContact(peerId);
    };
  });
}

function renderChatPanel() {
  const panel = document.getElementById("chatPanel");
  const c = state.contacts.get(state.activePeerId);
  if (!c) {
    panel.innerHTML = `
      <div class="empty-chat"><div>
        <div class="logo"><img src="chatwave-logo.svg" alt="ChatWave logo" /></div>
        <p>Add or pick a friend to start chatting. Messages can be typed immediately and will send once the friend is online.</p>
      </div></div>`;
    return;
  }

  panel.innerHTML = `
    <header class="chat-header">
      <button class="mobile-back-btn" id="mobileBackBtn" title="Back to chats" aria-label="Back to chats">
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>
      </button>
      <div class="chat-header-left">
        <div class="avatar" style="background:${c.color}">${initials(c.name)}</div>
        <div>
          <div class="chat-header-name">${escapeHtml(c.name)}</div>
          <div class="chat-header-status" id="chatHeaderStatus"></div>
        </div>
      </div>
      <div class="header-icons">
        <button class="icon-btn" id="editContactBtn" title="Edit friend name">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>
        </button>
        <button class="icon-btn" id="deleteContactBtn" title="Delete contact">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>
        </button>
        <button class="icon-btn" id="videoCallBtn" title="Video call">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M23 7l-7 5 7 5V7z"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/></svg>
        </button>
        <button class="icon-btn" id="audioCallBtn" title="Voice call">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/></svg>
        </button>
      </div>
    </header>
    <div class="messages-area" id="messagesArea">
      <div class="messages-inner" id="messagesInner"></div>
    </div>
    <footer class="composer">
      <input type="text" id="msgInput" placeholder="Type a message" autocomplete="off" />
      <button class="icon-btn" id="sendMsgBtn">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="#00a884"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>
      </button>
    </footer>`;

  document.getElementById("audioCallBtn").onclick = () => startCall("audio");
  document.getElementById("videoCallBtn").onclick = () => startCall("video");
  const mobileBackBtn = document.getElementById("mobileBackBtn");
  if (mobileBackBtn) mobileBackBtn.onclick = closeMobileChat;
  document.getElementById("deleteContactBtn").onclick = () => deleteContact(state.activePeerId);
  const input = document.getElementById("msgInput");
  document.getElementById("sendMsgBtn").onclick = () => {
    if (input.value.trim()) { sendMessage(input.value.trim()); input.value = ""; }
  };
  input.onkeydown = (e) => {
    if (e.key === "Enter" && input.value.trim()) {
      sendMessage(input.value.trim());
      input.value = "";
    }
  };
  input.focus();

  renderChatHeader();
  renderMessages();
}

function renderChatHeader() {
  const el = document.getElementById("chatHeaderStatus");
  if (!el) return;
  const c = state.contacts.get(state.activePeerId);
  if (!c) return;
  el.textContent = c.status === "connected" ? "online" : c.status === "connecting" ? "connecting…" : "ready when online";
  el.style.color = c.status === "connected" ? "#00a884" : "#8696a0";
}

function renderMessages() {
  const inner = document.getElementById("messagesInner");
  if (!inner) return;
  const c = state.contacts.get(state.activePeerId);
  if (!c) return;

  let html = '<div class="date-chip">TODAY</div>';
  for (const m of c.messages) {
    if (m.from === "system") {
      html += `<div class="system-msg">${escapeHtml(m.text)}</div>`;
      continue;
    }
    const isMe = m.from === "me";
    const checks = isMe ? renderChecks(m.status) : "";
    html += `
      <div class="bubble-row ${isMe ? "me" : ""}">
        <div class="bubble ${isMe ? "me" : "them"}">
          <div class="bubble-text">${escapeHtml(m.text)}</div>
          <div class="bubble-meta">
            <span>${m.time}</span>
            ${checks}
          </div>
        </div>
      </div>`;
  }
  inner.innerHTML = html;
  const area = document.getElementById("messagesArea");
  if (area) area.scrollTop = area.scrollHeight;
}

function renderChecks(status) {
  if (status === "pending") return `<span class="check-icon" title="Sending when connected">•</span>`;
  if (status === "sent") return `<svg class="check-icon" width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M11.5 4.5L6.5 9.5 4 7l-1 1 3.5 3.5 6-6z"/></svg>`;
  const cls = status === "read" ? "check-icon read" : "check-icon";
  return `<svg class="${cls}" width="16" height="14" viewBox="0 0 18 14" fill="currentColor"><path d="M11.5 1.5L6.5 6.5 4 4 3 5l3.5 3.5 6-6zM15.5 1.5l-5 5L9 5 8 6l2.5 2.5 6-6z"/></svg>`;
}

// ============= CALLS =============
async function startCall(type) {
  const peerId = state.activePeerId;
  const c = state.contacts.get(peerId);
  if (!c || !c.conn || c.conn.open !== true) {
    toast("Not connected.");
    return;
  }

  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: type === "video" ? { width: 1280, height: 720 } : false,
    });
  } catch (e) {
    toast("Couldn't access " + (type === "video" ? "camera/mic" : "microphone") + ". Check permissions.");
    return;
  }

  // Send a metadata message about the call type
  try { c.conn.send({ type: "call-meta", callType: type }); } catch (e) {}

  const call = state.peer.call(peerId, stream, { metadata: { callType: type } });
  setupCall(call, stream, peerId, type, "outgoing");
}

function handleIncomingMediaCall(call) {
  const peerId = call.peer;
  ensureContact(peerId);
  const callType = call.metadata?.callType || "audio";
  state.incomingCall = { call, peerId, callType };
  showIncomingModal(peerId, callType);
}

function showIncomingModal(peerId, callType) {
  const c = state.contacts.get(peerId);
  document.getElementById("incomingAvatar").textContent = initials(c?.name || "?");
  document.getElementById("incomingAvatar").style.background = c?.color || "#5B8FF9";
  document.getElementById("incomingName").textContent = c?.name || peerId.slice(0, 8);
  document.getElementById("incomingLabel").textContent = "Incoming " + (callType === "video" ? "video" : "voice") + " call…";
  document.getElementById("incomingModal").classList.add("active");
  startRingtone();
  notifyIncomingCall(peerId, callType);
}

function hideIncomingModal() {
  document.getElementById("incomingModal").classList.remove("active");
  stopRingtone();
}

async function acceptCall() {
  if (!state.incomingCall) return;
  const { call, peerId, callType } = state.incomingCall;
  hideIncomingModal();

  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: callType === "video" ? { width: 1280, height: 720 } : false,
    });
  } catch (e) {
    toast("Couldn't access devices.");
    call.close();
    state.incomingCall = null;
    return;
  }

  call.answer(stream);
  setupCall(call, stream, peerId, callType, "incoming");
  state.incomingCall = null;
}

function declineCall() {
  if (state.incomingCall) {
    state.incomingCall.call.close();
    state.incomingCall = null;
  }
  hideIncomingModal();
}

function setupCall(call, localStream, peerId, type, direction) {
  state.activeCall = { call, peerId, type, localStream, remoteStream: null };

  const overlay = document.getElementById("callOverlay");
  overlay.classList.add("active");
  if (type === "audio") overlay.classList.add("audio-only");
  else overlay.classList.remove("audio-only");

  const c = state.contacts.get(peerId);
  document.getElementById("callName").textContent = c?.name || peerId.slice(0, 8);
  document.getElementById("callStatus").textContent = direction === "outgoing" ? "Calling…" : "Connected";

  const videoStage = document.getElementById("videoStage");
  const audioAvatar = document.getElementById("audioCallAvatar");
  const cameraBtn = document.getElementById("cameraBtn");

  if (type === "video") {
    videoStage.style.display = "block";
    audioAvatar.style.display = "none";
    cameraBtn.style.display = "flex";
    document.getElementById("localVideo").srcObject = localStream;
  } else {
    videoStage.style.display = "none";
    audioAvatar.style.display = "flex";
    cameraBtn.style.display = "none";
    document.getElementById("bigAvatar").textContent = initials(c?.name || "?");
    document.getElementById("bigAvatar").style.background = c?.color || "#5B8FF9";
  }

  call.on("stream", (remoteStream) => {
    state.activeCall.remoteStream = remoteStream;
    if (type === "video") {
      document.getElementById("remoteVideo").srcObject = remoteStream;
    } else {
      // Hidden audio element for audio playback
      let audio = document.getElementById("remoteAudio");
      if (!audio) {
        audio = document.createElement("audio");
        audio.id = "remoteAudio";
        audio.autoplay = true;
        document.body.appendChild(audio);
      }
      audio.srcObject = remoteStream;
    }
    document.getElementById("callStatus").textContent = "Connected";
    document.getElementById("callStatus").style.display = "none";
    document.getElementById("callTimer").style.display = "block";
    startCallTimer();
  });

  call.on("close", endCall);
  call.on("error", (e) => { console.error(e); endCall(); });
}

function startCallTimer() {
  state.callStartTime = Date.now();
  if (state.callTimerInterval) clearInterval(state.callTimerInterval);
  state.callTimerInterval = setInterval(() => {
    const sec = Math.floor((Date.now() - state.callStartTime) / 1000);
    const mm = String(Math.floor(sec / 60)).padStart(2, "0");
    const ss = String(sec % 60).padStart(2, "0");
    document.getElementById("callTimer").textContent = mm + ":" + ss;
  }, 1000);
}

function endCall() {
  stopRingtone();
  if (state.activeCall) {
    try { state.activeCall.call.close(); } catch (e) {}
    if (state.activeCall.localStream) {
      state.activeCall.localStream.getTracks().forEach(t => t.stop());
    }
  }
  state.activeCall = null;
  if (state.callTimerInterval) {
    clearInterval(state.callTimerInterval);
    state.callTimerInterval = null;
  }
  document.getElementById("callOverlay").classList.remove("active");
  document.getElementById("callStatus").style.display = "block";
  document.getElementById("callTimer").style.display = "none";
  document.getElementById("callTimer").textContent = "00:00";
  document.getElementById("muteBtn").classList.remove("active");
  document.getElementById("cameraBtn").classList.remove("active");
  const audio = document.getElementById("remoteAudio");
  if (audio) { audio.srcObject = null; }
}

function toggleMute() {
  if (!state.activeCall?.localStream) return;
  const tracks = state.activeCall.localStream.getAudioTracks();
  if (!tracks.length) return;
  tracks[0].enabled = !tracks[0].enabled;
  document.getElementById("muteBtn").classList.toggle("active", !tracks[0].enabled);
}

function toggleCamera() {
  if (!state.activeCall?.localStream) return;
  const tracks = state.activeCall.localStream.getVideoTracks();
  if (!tracks.length) return;
  tracks[0].enabled = !tracks[0].enabled;
  document.getElementById("cameraBtn").classList.toggle("active", !tracks[0].enabled);
}


// ============= NOTIFICATIONS & RINGTONE =============
function canUseNotifications() {
  return "Notification" in window && window.isSecureContext;
}

async function requestNotificationPermission() {
  if (!canUseNotifications()) return false;
  if (Notification.permission === "granted") return true;
  if (Notification.permission === "denied") return false;
  if (state.notificationPermissionAsked) return false;
  state.notificationPermissionAsked = true;
  try {
    const permission = await Notification.requestPermission();
    return permission === "granted";
  } catch (e) {
    return false;
  }
}

async function showAppNotification(title, body, tag) {
  if (!canUseNotifications() || Notification.permission !== "granted") return;
  const options = {
    body,
    tag,
    icon: "./icon-192.png",
    badge: "./icon-192.png",
    vibrate: [180, 90, 180],
  };
  try {
    const reg = await navigator.serviceWorker?.ready;
    if (reg?.showNotification) {
      await reg.showNotification(title, options);
      return;
    }
  } catch (e) {}
  try { new Notification(title, options); } catch (e) {}
}

function notifyIncomingMessage(peerId, text) {
  const c = state.contacts.get(peerId);
  const isCurrentOpen = document.visibilityState === "visible" && state.activePeerId === peerId;
  if (isCurrentOpen) return;
  showAppNotification(c?.name || "New message", text || "You have a new message", "chat-" + peerId);
}

function notifyIncomingCall(peerId, callType) {
  const c = state.contacts.get(peerId);
  const label = callType === "video" ? "Incoming video call" : "Incoming voice call";
  showAppNotification(c?.name || "Incoming call", label, "call-" + peerId);
}

function startRingtone() {
  stopRingtone();
  try {
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (!AudioContext) return;
    const ctx = new AudioContext();
    state.ringAudioCtx = ctx;
    const playTone = () => {
      if (!state.ringAudioCtx) return;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.setValueAtTime(880, ctx.currentTime);
      gain.gain.setValueAtTime(0.0001, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.18, ctx.currentTime + 0.04);
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.55);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.6);
    };
    playTone();
    state.ringTimer = setInterval(playTone, 1200);
  } catch (e) {}
}

function stopRingtone() {
  if (state.ringTimer) {
    clearInterval(state.ringTimer);
    state.ringTimer = null;
  }
  if (state.ringAudioCtx) {
    try { state.ringAudioCtx.close(); } catch (e) {}
    state.ringAudioCtx = null;
  }
}

// ============= UTILS =============
function generateNumericId() {
  const timestamp = String(Date.now()).slice(-8);
  const randomDigits = String(Math.floor(1000 + Math.random() * 9000));
  return timestamp + randomDigits;
}

function nowTime() {
  return new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
}
function initials(name) {
  const clean = name.replace(/[^\w\s]/g, "").trim();
  const parts = clean.split(/\s+/);
  return ((parts[0]?.[0] || "") + (parts[1]?.[0] || "")).toUpperCase() || "?";
}
function hashCode(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h) + s.charCodeAt(i) | 0;
  return h;
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));
}
function copyId(text, btnId) {
  if (!text) return;
  navigator.clipboard.writeText(text).then(() => {
    if (btnId) {
      const btn = document.getElementById(btnId);
      const orig = btn.textContent;
      btn.textContent = "Copied!";
      btn.classList.add("copied");
      setTimeout(() => { btn.textContent = orig; btn.classList.remove("copied"); }, 1500);
    } else {
      toast("ID copied to clipboard");
    }
  }).catch(() => toast("Couldn't copy"));
}
function toast(msg) {
  const t = document.createElement("div");
  t.className = "toast";
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 2600);
}





// ============= INSTALL BUTTON SUPPORT =============
let deferredInstallPrompt = null;
const installBtn = document.getElementById("installAppBtn");

function isStandaloneMode() {
  return window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true;
}

function updateInstallButton() {
  if (!installBtn) return;
  if (isStandaloneMode()) {
    installBtn.classList.add("hidden");
  } else {
    installBtn.classList.remove("hidden");
  }
}

window.addEventListener("beforeinstallprompt", (event) => {
  event.preventDefault();
  deferredInstallPrompt = event;
  updateInstallButton();
});

if (installBtn) {
  installBtn.addEventListener("click", async () => {
    if (isStandaloneMode()) {
      installBtn.classList.add("hidden");
      toast("App is already installed.");
      return;
    }

    if (deferredInstallPrompt) {
      deferredInstallPrompt.prompt();
      await deferredInstallPrompt.userChoice.catch(() => null);
      deferredInstallPrompt = null;
      updateInstallButton();
      return;
    }

    const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
    if (isIOS) {
      toast("On iPhone: tap Share, then Add to Home Screen.");
    } else {
      toast("If no popup appears, open browser menu and choose Install app or Add to Home screen.");
    }
  });
}

window.addEventListener("appinstalled", () => {
  if (installBtn) installBtn.classList.add("hidden");
  toast("ChatWave installed successfully.");
});

updateInstallButton();

// ============= PWA INSTALL SUPPORT =============
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./service-worker.js').catch(() => {});
  });
}

// Boot
init();
