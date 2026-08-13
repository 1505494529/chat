const profileButton = document.querySelector("#profileButton");
const nicknameModal = document.querySelector("#nicknameModal");
const closeModalButton = document.querySelector("#closeModalButton");
const saveNicknameButton = document.querySelector("#saveNicknameButton");
const nicknameInput = document.querySelector("#nicknameInput");
const messageInput = document.querySelector("#messageInput");
const sendButton = document.querySelector("#sendButton");
const attachButton = document.querySelector("#attachButton");
const fileInput = document.querySelector("#fileInput");
const attachmentPreview = document.querySelector("#attachmentPreview");
const composerWrap = document.querySelector(".composer-wrap");
const messages = document.querySelector("#messages");
const myNickname = document.querySelector("#myNickname");
const myAvatar = document.querySelector("#myAvatar");
const modalAvatar = document.querySelector("#modalAvatar");
const deviceLabel = document.querySelector("#deviceLabel");
const connectionDot = document.querySelector("#connectionDot");
const connectionLabel = document.querySelector("#connectionLabel");
const toast = document.querySelector("#toast");
const themeButton = document.querySelector("#themeButton");
const themeMenu = document.querySelector("#themeMenu");
const themeOptions = [...document.querySelectorAll("[data-theme-choice]")];

const deviceId = localStorage.getItem("chat-device-id") || localStorage.getItem("chat-session") || crypto.randomUUID();
localStorage.setItem("chat-device-id", deviceId);
localStorage.setItem("chat-session", deviceId);

let nickname = localStorage.getItem("chat-nickname") || "访客";
let color = localStorage.getItem("chat-color") || pickColor(deviceId);
let socket;
let maxFileBytes = 8 * 1024 * 1024;
let pendingFiles = [];
let toastTimer;
let heartbeatTimer;
let reconnectTimer;

function pickColor(value) {
  const colors = ["#7168ed", "#e27e9a", "#4da8b4", "#d6915b", "#8b70c6", "#4fa778"];
  let total = 0;
  for (const character of value) total += character.charCodeAt(0);
  return colors[total % colors.length];
}

function initials(value) {
  return [...String(value || "访客").trim()].slice(0, 2).join("").toUpperCase();
}

function deviceCode() {
  return deviceId.replace(/-/g, "").slice(0, 6).toUpperCase();
}

function showToast(message) {
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("show"), 2200);
}

function send(payload) {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    showToast("连接中，请稍候");
    return false;
  }
  socket.send(JSON.stringify(payload));
  return true;
}

function formatTime(timestamp) {
  return new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit" }).format(new Date(timestamp));
}

function formatSize(bytes) {
  if (!bytes) return "文件";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function fileExtension(name) {
  const suffix = String(name || "FILE").split(".").pop().toUpperCase();
  return suffix.length > 4 ? "FILE" : suffix;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[character]));
}

function renderEmptyState() {
  messages.innerHTML = `<div class="empty-state">还没有消息</div>`;
}

function renderMessages(messageList) {
  messages.innerHTML = "";
  if (!messageList.length) {
    renderEmptyState();
    return;
  }
  messageList.forEach(renderMessage);
  scrollToBottom(false);
}

function renderMessage(message) {
  messages.querySelector(".empty-state")?.remove();
  const mine = message.sessionId === deviceId;
  const row = document.createElement("article");
  row.className = `message-row${mine ? " mine" : ""}`;

  const avatar = document.createElement("div");
  avatar.className = "avatar message-avatar";
  avatar.style.background = message.color || pickColor(message.sessionId || message.nickname);
  avatar.textContent = initials(message.nickname);

  const stack = document.createElement("div");
  stack.className = "message-stack";
  const meta = document.createElement("div");
  meta.className = "message-meta";
  meta.innerHTML = `<strong>${escapeHtml(message.nickname)}</strong><time>${formatTime(message.createdAt)}</time>`;
  stack.append(meta, messageBody(message));
  row.append(avatar, stack);
  messages.append(row);
}

function messageBody(message) {
  if (message.kind === "image") {
    const body = document.createElement("div");
    body.className = "bubble image-message";
    const image = document.createElement("img");
    image.src = message.data;
    image.alt = message.name || "图片";
    image.loading = "lazy";
    image.addEventListener("click", () => window.open(message.data, "_blank", "noopener,noreferrer"));
    body.append(image);
    if (message.text) {
      const caption = document.createElement("div");
      caption.className = "image-caption";
      caption.textContent = message.text;
      body.append(caption);
    }
    return body;
  }

  if (message.kind === "file") {
    const body = document.createElement("div");
    body.className = "bubble";
    const card = document.createElement("div");
    card.className = "file-card";
    const icon = document.createElement("div");
    icon.className = "file-icon";
    icon.textContent = fileExtension(message.name);
    const info = document.createElement("div");
    info.className = "file-info";
    info.innerHTML = `<strong>${escapeHtml(message.name)}</strong><small>${formatSize(message.size)}</small>`;
    const download = document.createElement("a");
    download.className = "file-download";
    download.href = message.data;
    download.download = message.name;
    download.textContent = "↓";
    download.title = "下载文件";
    card.append(icon, info, download);
    body.append(card);
    return body;
  }

  const body = document.createElement("div");
  body.className = "bubble";
  body.textContent = message.text;
  return body;
}

function scrollToBottom(smooth = true) {
  messages.scrollTo({ top: messages.scrollHeight, behavior: smooth ? "smooth" : "auto" });
}

function updateProfile() {
  myNickname.textContent = nickname;
  myAvatar.textContent = initials(nickname);
  modalAvatar.textContent = initials(nickname);
  myAvatar.style.background = color;
  modalAvatar.style.background = color;
  deviceLabel.textContent = `设备 ID · ${deviceCode()}`;
}

function applyTheme(theme) {
  const themes = ["light", "dark", "cream", "mint", "ocean", "rose", "sunset", "mono", "lavender"];
  const selected = themes.includes(theme) ? theme : "light";
  document.documentElement.dataset.theme = selected;
  localStorage.setItem("chat-theme", selected);
  themeOptions.forEach((option) => option.classList.toggle("active", option.dataset.themeChoice === selected));
}

function toggleThemeMenu(force) {
  const open = typeof force === "boolean" ? force : themeMenu.classList.contains("hidden");
  themeMenu.classList.toggle("hidden", !open);
  themeButton.setAttribute("aria-expanded", String(open));
}

function connect() {
  renderEmptyState();
  const protocol = window.location.protocol === "https:" ? "wss" : "ws";
  socket = new WebSocket(`${protocol}://${window.location.host}`);
  socket.addEventListener("open", () => {
    clearTimeout(reconnectTimer);
    connectionDot.classList.add("online");
    connectionLabel.textContent = "在线";
    send({ type: "join", nickname, deviceId, color });
    clearInterval(heartbeatTimer);
    heartbeatTimer = setInterval(() => send({ type: "ping" }), 20000);
  });
  socket.addEventListener("message", ({ data }) => {
    const payload = JSON.parse(data);
    if (payload.type === "sync") {
      maxFileBytes = payload.maxFileBytes || maxFileBytes;
      renderMessages(payload.messages || []);
    }
    if (payload.type === "message") {
      renderMessage(payload.message);
      scrollToBottom();
    }
    if (payload.type === "error") showToast(payload.message);
  });
  socket.addEventListener("close", () => {
    clearInterval(heartbeatTimer);
    connectionDot.classList.remove("online");
    connectionLabel.textContent = "离线";
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connect, 1800);
  });
  socket.addEventListener("error", () => showToast("暂时无法连接"));
}

function openNicknameModal() {
  nicknameInput.value = nickname;
  nicknameModal.classList.remove("hidden");
  setTimeout(() => { nicknameInput.focus(); nicknameInput.select(); }, 0);
}

function closeNicknameModal() {
  nicknameModal.classList.add("hidden");
}

function saveNickname() {
  nickname = nicknameInput.value.trim().replace(/\s+/g, " ").slice(0, 24) || "访客";
  localStorage.setItem("chat-nickname", nickname);
  updateProfile();
  closeNicknameModal();
  send({ type: "rename", nickname });
}

function chooseFiles(files) {
  const valid = [...files].filter((file) => {
    if (file.size > maxFileBytes) {
      showToast(`${file.name} 超过 8MB`);
      return false;
    }
    return true;
  });
  pendingFiles = [...pendingFiles, ...valid].slice(0, 3);
  renderPendingFiles();
}

function renderPendingFiles() {
  attachmentPreview.innerHTML = "";
  attachmentPreview.classList.toggle("hidden", !pendingFiles.length);
  pendingFiles.forEach((file, index) => {
    const item = document.createElement("div");
    item.className = "pending-file";
    item.innerHTML = `<span>${file.type.startsWith("image/") ? "▧" : "□"}</span><span>${escapeHtml(file.name)}</span><small>${formatSize(file.size)}</small>`;
    const remove = document.createElement("button");
    remove.textContent = "×";
    remove.title = "移除";
    remove.addEventListener("click", () => { pendingFiles.splice(index, 1); renderPendingFiles(); });
    item.append(remove);
    attachmentPreview.append(item);
  });
}

function readAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => resolve(reader.result));
    reader.addEventListener("error", reject);
    reader.readAsDataURL(file);
  });
}

async function sendPendingFiles() {
  for (const file of pendingFiles) {
    try {
      const data = await readAsDataUrl(file);
      const kind = file.type.startsWith("image/") ? "image" : "file";
      if (!send({ type: "message", kind, data, name: file.name, mime: file.type, size: file.size })) return;
    } catch {
      showToast(`读取 ${file.name} 失败`);
    }
  }
  pendingFiles = [];
  renderPendingFiles();
}

function sendText() {
  const text = messageInput.value.trim();
  if (!text) return;
  if (send({ type: "message", kind: "text", text })) {
    messageInput.value = "";
    resizeTextarea();
  }
}

function resizeTextarea() {
  messageInput.style.height = "auto";
  messageInput.style.height = `${Math.min(messageInput.scrollHeight, 124)}px`;
}

profileButton.addEventListener("click", openNicknameModal);
closeModalButton.addEventListener("click", closeNicknameModal);
saveNicknameButton.addEventListener("click", saveNickname);
nicknameInput.addEventListener("keydown", (event) => { if (event.key === "Enter") saveNickname(); });
nicknameModal.addEventListener("click", (event) => { if (event.target === nicknameModal) closeNicknameModal(); });
themeButton.addEventListener("click", () => toggleThemeMenu());
themeOptions.forEach((option) => option.addEventListener("click", () => { applyTheme(option.dataset.themeChoice); toggleThemeMenu(false); }));
document.addEventListener("click", (event) => { if (!event.target.closest(".theme-picker")) toggleThemeMenu(false); });
sendButton.addEventListener("click", async () => { sendText(); await sendPendingFiles(); });
messageInput.addEventListener("input", resizeTextarea);
messageInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); sendText(); }
});
attachButton.addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", () => { chooseFiles(fileInput.files); fileInput.value = ""; });
composerWrap.addEventListener("dragover", (event) => { event.preventDefault(); composerWrap.classList.add("dragging"); });
composerWrap.addEventListener("dragleave", (event) => { if (!composerWrap.contains(event.relatedTarget)) composerWrap.classList.remove("dragging"); });
composerWrap.addEventListener("drop", (event) => { event.preventDefault(); composerWrap.classList.remove("dragging"); chooseFiles(event.dataTransfer.files); });

applyTheme(localStorage.getItem("chat-theme") || "light");
updateProfile();
connect();
