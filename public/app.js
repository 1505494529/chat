import { createClient } from "https://esm.sh/@supabase/supabase-js@2.112.3";

const config = globalThis.CHAT_CONFIG || {};
const supabaseUrl = String(config.supabaseUrl || "").trim();
const supabaseAnonKey = String(config.supabaseAnonKey || "").trim();
const storageBucket = String(config.storageBucket || "chat-files");
const maxStandardFileBytes = Number(config.standardFileMaxBytes || 50 * 1024 * 1024);
const iceServers = config.iceServers || [
  { urls: ["stun:stun.l.google.com:19302", "stun:stun.cloudflare.com:3478"] },
];
const supabase = supabaseUrl && supabaseAnonKey ? createClient(supabaseUrl, supabaseAnonKey, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
}) : null;

const profileButton = document.querySelector("#profileButton");
const nicknameModal = document.querySelector("#nicknameModal");
const closeModalButton = document.querySelector("#closeModalButton");
const saveNicknameButton = document.querySelector("#saveNicknameButton");
const nicknameInput = document.querySelector("#nicknameInput");
const messageInput = document.querySelector("#messageInput");
const sendButton = document.querySelector("#sendButton");
const attachButton = document.querySelector("#attachButton");
const p2pButton = document.querySelector("#p2pButton");
const fileInput = document.querySelector("#fileInput");
const p2pFileInput = document.querySelector("#p2pFileInput");
const attachmentPreview = document.querySelector("#attachmentPreview");
const composerWrap = document.querySelector(".composer-wrap");
const dropOverlay = document.querySelector("#dropOverlay");
const messages = document.querySelector("#messages");
const p2pTransfersPanel = document.querySelector("#p2pTransfers");
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

const MESSAGE_CACHE_KEY = "chat-message-cache-v2";
const MAX_CACHED_MESSAGES = 80;
const MAX_CACHED_DATA = 1_800_000;
const MAX_SYNC_MESSAGES = 120;
const P2P_CHUNK_SIZE = 64 * 1024;
const P2P_BUFFER_LIMIT = 4 * 1024 * 1024;

let user = null;
let deviceId = localStorage.getItem("chat-device-id") || "";
// 聊天身份按设备保持；P2P 身份按标签页区分，避免同一浏览器开两个标签页时互相忽略。
let peerId = sessionStorage.getItem("chat-peer-id") || crypto.randomUUID();
sessionStorage.setItem("chat-peer-id", peerId);
let nickname = localStorage.getItem("chat-nickname") || "访客";
let color = localStorage.getItem("chat-color") || pickColor(deviceId || nickname);
let channel = null;
let messagesState = readMessageCache();
let pendingFiles = [];
let p2pTransfers = new Map();
let toastTimer;
let dragDepth = 0;

function pickColor(value) {
  const colors = ["#7168ed", "#e27e9a", "#4da8b4", "#d6915b", "#8b70c6", "#4fa778"];
  let total = 0;
  for (const character of String(value || "访客")) total += character.charCodeAt(0);
  return colors[total % colors.length];
}

function initials(value) {
  return [...String(value || "访客").trim()].slice(0, 2).join("").toUpperCase();
}

function deviceCode() {
  return String(deviceId || "loading").replace(/-/g, "").slice(0, 6).toUpperCase();
}

function showToast(message) {
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("show"), 2800);
}

function setConnection(label, online = false) {
  connectionLabel.textContent = label;
  connectionDot.classList.toggle("online", online);
}

function formatTime(timestamp) {
  return new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit" }).format(new Date(timestamp));
}

function formatSize(bytes) {
  if (!bytes) return "文件";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function fileExtension(name) {
  const suffix = String(name || "FILE").split(".").pop().toUpperCase();
  return suffix.length > 4 ? "FILE" : suffix;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;",
  }[character]));
}

function readMessageCache() {
  try {
    const cached = JSON.parse(localStorage.getItem(MESSAGE_CACHE_KEY) || "[]");
    return Array.isArray(cached) ? cached : [];
  } catch {
    return [];
  }
}

function saveMessageCache(messageList) {
  const compacted = messageList.slice(-MAX_CACHED_MESSAGES).map((message) => ({ ...message }));
  let remainingData = MAX_CACHED_DATA;
  for (let index = compacted.length - 1; index >= 0; index -= 1) {
    const data = typeof compacted[index].data === "string" ? compacted[index].data : "";
    if (!data) continue;
    if (data.length > remainingData) {
      compacted[index].data = "";
      compacted[index].cachedOnly = true;
      continue;
    }
    remainingData -= data.length;
  }

  try {
    localStorage.setItem(MESSAGE_CACHE_KEY, JSON.stringify(compacted));
  } catch {
    try {
      localStorage.setItem(MESSAGE_CACHE_KEY, JSON.stringify(compacted.map((message) => ({
        ...message,
        data: "",
        cachedOnly: message.kind !== "text",
      }))));
    } catch {
      localStorage.removeItem(MESSAGE_CACHE_KEY);
    }
  }
}

function hydrateFromCache() {
  if (messagesState.length) renderMessages(messagesState);
  else renderEmptyState();
}

function renderEmptyState(text = "还没有消息") {
  messages.innerHTML = `<div class="empty-state">${escapeHtml(text)}</div>`;
}

function renderMessages(messageList) {
  messages.innerHTML = "";
  const sorted = [...messageList].sort((a, b) => a.createdAt - b.createdAt);
  if (!sorted.length) {
    renderEmptyState();
    return;
  }
  sorted.forEach(renderMessage);
  scrollToBottom(false);
}

function upsertMessage(message, shouldScroll = false) {
  const index = messagesState.findIndex((item) => item.id === message.id);
  if (index >= 0) messagesState[index] = { ...messagesState[index], ...message };
  else messagesState = [...messagesState, message].slice(-MAX_SYNC_MESSAGES);
  messagesState.sort((a, b) => a.createdAt - b.createdAt);
  saveMessageCache(messagesState);
  renderMessages(messagesState);
  if (shouldScroll) scrollToBottom();
}

function removeMessage(messageId) {
  messagesState = messagesState.filter((message) => message.id !== messageId);
  saveMessageCache(messagesState);
  renderMessages(messagesState);
}

function renderMessage(message) {
  messages.querySelector(".empty-state")?.remove();
  const mine = message.sessionId === deviceId;
  const row = document.createElement("article");
  row.className = `message-row${mine ? " mine" : ""}`;
  row.dataset.messageId = message.id;

  const avatar = document.createElement("div");
  avatar.className = "avatar message-avatar";
  avatar.style.background = message.color || pickColor(message.sessionId || message.nickname);
  avatar.textContent = initials(message.nickname);

  const stack = document.createElement("div");
  stack.className = "message-stack";
  const meta = document.createElement("div");
  meta.className = "message-meta";
  meta.innerHTML = `<strong>${escapeHtml(message.nickname)}</strong><time>${formatTime(message.createdAt)}</time>`;
  const bubbleWrap = document.createElement("div");
  bubbleWrap.className = "bubble-wrap";
  bubbleWrap.append(messageBody(message));
  if (mine) {
    const deleteButton = document.createElement("button");
    deleteButton.className = "delete-message";
    deleteButton.type = "button";
    deleteButton.textContent = "删除";
    deleteButton.title = "删除这条消息";
    deleteButton.addEventListener("click", () => deleteMessage(message.id));
    bubbleWrap.append(deleteButton);
  }
  stack.append(meta, bubbleWrap);
  row.append(avatar, stack);
  messages.append(row);
}

function messageBody(message) {
  if (message.kind === "image") {
    const body = document.createElement("div");
    body.className = "bubble image-message";
    if (!message.data) {
      const placeholder = document.createElement("div");
      placeholder.className = "attachment-placeholder";
      placeholder.textContent = "图片正在同步…";
      body.append(placeholder);
      return body;
    }
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
    download.href = message.data || "#";
    download.download = message.name;
    download.textContent = "↓";
    download.title = "下载文件";
    if (!message.data) {
      download.removeAttribute("href");
      download.removeAttribute("download");
      download.textContent = "…";
      download.title = "文件地址暂不可用";
      download.classList.add("is-pending");
    }
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
  deviceLabel.textContent = `匿名设备 · ${deviceCode()}`;
}

function applyTheme(theme) {
  const themes = ["light", "dark", "cream", "mint", "ocean", "rose", "sunset", "mono", "lavender", "cyberpunk", "pixel", "glass", "cinematic", "arcade", "terminal", "brutalist", "aurora", "vaporwave", "blueprint"];
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

function rowToMessage(row) {
  return {
    id: row.id,
    kind: row.kind,
    text: row.text || "",
    data: row.file_url || "",
    name: row.name || "未命名文件",
    mime: row.mime || "application/octet-stream",
    size: Number(row.size || 0),
    nickname: row.nickname || "访客",
    sessionId: row.session_id,
    color: row.color || "#6c63ff",
    createdAt: new Date(row.created_at).getTime() || Date.now(),
    storagePath: row.storage_path || "",
  };
}

function messageToRow(message) {
  return {
    id: message.id,
    kind: message.kind,
    text: message.text || "",
    file_url: message.data || "",
    storage_path: message.storagePath || null,
    name: message.name || "未命名文件",
    mime: message.mime || "application/octet-stream",
    size: message.size || 0,
    nickname: message.nickname,
    session_id: message.sessionId,
    color: message.color,
    created_at: new Date(message.createdAt).toISOString(),
  };
}

async function ensureAnonymousUser() {
  const { data: sessionData, error: sessionError } = await supabase.auth.getSession();
  if (sessionError) throw sessionError;
  if (sessionData.session?.user) return sessionData.session.user;

  const { data, error } = await supabase.auth.signInAnonymously();
  if (error) throw error;
  if (!data.user) throw new Error("没有获得匿名用户身份");
  return data.user;
}

async function loadMessages() {
  const { data, error } = await supabase
    .from("messages")
    .select("id, kind, text, file_url, storage_path, name, mime, size, nickname, session_id, color, created_at")
    .order("created_at", { ascending: false })
    .limit(MAX_SYNC_MESSAGES);
  if (error) throw error;
  messagesState = (data || []).reverse().map(rowToMessage);
  saveMessageCache(messagesState);
  renderMessages(messagesState);
}

async function subscribeRealtime() {
  channel = supabase.channel("chat:main", {
    config: {
      broadcast: { self: false },
      presence: { key: deviceId },
    },
  });

  channel
    .on("postgres_changes", { event: "INSERT", schema: "public", table: "messages" }, ({ new: row }) => {
      upsertMessage(rowToMessage(row), true);
    })
    .on("postgres_changes", { event: "DELETE", schema: "public", table: "messages" }, ({ old: row }) => {
      if (row?.id) removeMessage(row.id);
    })
    .on("broadcast", { event: "p2p-offer" }, ({ payload }) => handleP2PEvent("p2p-offer", payload))
    .on("broadcast", { event: "p2p-claim" }, ({ payload }) => handleP2PEvent("p2p-claim", payload))
    .on("broadcast", { event: "p2p-answer" }, ({ payload }) => handleP2PEvent("p2p-answer", payload))
    .on("broadcast", { event: "p2p-complete" }, ({ payload }) => handleP2PEvent("p2p-complete", payload))
    .on("broadcast", { event: "p2p-cancel" }, ({ payload }) => handleP2PEvent("p2p-cancel", payload));

  const status = await new Promise((resolve) => {
    channel.subscribe((nextStatus) => {
      if (["SUBSCRIBED", "CHANNEL_ERROR", "TIMED_OUT", "CLOSED"].includes(nextStatus)) resolve(nextStatus);
    });
  });

  if (status !== "SUBSCRIBED") throw new Error(`Realtime 连接失败：${status}`);
  await channel.track({ nickname, color });
}

async function sendText() {
  const text = messageInput.value.trim();
  if (!text || !user) return;
  const message = {
    id: crypto.randomUUID(),
    kind: "text",
    text: text.slice(0, 4000),
    data: "",
    name: "",
    mime: "text/plain",
    size: 0,
    nickname,
    sessionId: deviceId,
    color,
    createdAt: Date.now(),
  };

  const { error } = await supabase.from("messages").insert(messageToRow(message));
  if (error) {
    showToast(`发送失败：${error.message}`);
    return;
  }
  messageInput.value = "";
  resizeTextarea();
}

function safeFileName(value) {
  const originalName = String(value || "file").split(/[\\/]/).pop();
  return originalName.replace(/[^\p{L}\p{N}._-]+/gu, "-").slice(0, 100) || "file";
}

async function uploadAndSendFile(file) {
  if (!user) return;
  if (file.size > maxStandardFileBytes) {
    showToast(`${file.name} 超过 ${formatSize(maxStandardFileBytes)}，请使用 P2P 按钮`);
    return;
  }

  const id = crypto.randomUUID();
  const kind = file.type.startsWith("image/") ? "image" : "file";
  const storagePath = `${deviceId}/${id}-${safeFileName(file.name)}`;
  showToast(`正在上传 ${file.name}…`);

  const { error: uploadError } = await supabase.storage.from(storageBucket).upload(storagePath, file, {
    contentType: file.type || "application/octet-stream",
    upsert: false,
  });
  if (uploadError) {
    showToast(`上传失败：${uploadError.message}`);
    return;
  }

  const { data: publicData } = supabase.storage.from(storageBucket).getPublicUrl(storagePath);
  const message = {
    id,
    kind,
    text: "",
    data: publicData.publicUrl,
    name: file.name,
    mime: file.type || "application/octet-stream",
    size: file.size,
    nickname,
    sessionId: deviceId,
    color,
    createdAt: Date.now(),
    storagePath,
  };

  const { error: insertError } = await supabase.from("messages").insert(messageToRow(message));
  if (insertError) {
    await supabase.storage.from(storageBucket).remove([storagePath]);
    showToast(`保存失败：${insertError.message}`);
    return;
  }
  showToast(`${file.name} 已发送`);
}

async function deleteMessage(messageId) {
  const message = messagesState.find((item) => item.id === messageId);
  if (!message || !window.confirm("删除这条消息？删除后所有设备都将看不到它。")) return;

  const { error } = await supabase.from("messages").delete().eq("id", messageId);
  if (error) {
    showToast(`删除失败：${error.message}`);
    return;
  }
  if (message.storagePath) await supabase.storage.from(storageBucket).remove([message.storagePath]);
  removeMessage(messageId);
}

function chooseFiles(files) {
  const valid = [...files].filter((file) => {
    if (file.size > maxStandardFileBytes) {
      showToast(`${file.name} 太大，请使用 P2P 按钮`);
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
    item.innerHTML = `<span>${file.type.startsWith("image/") ? "▣" : "▤"}</span><span>${escapeHtml(file.name)}</span><small>${formatSize(file.size)}</small>`;
    const remove = document.createElement("button");
    remove.textContent = "×";
    remove.title = "移除";
    remove.addEventListener("click", () => { pendingFiles.splice(index, 1); renderPendingFiles(); });
    item.append(remove);
    attachmentPreview.append(item);
  });
}

async function sendPendingFiles() {
  const files = [...pendingFiles];
  pendingFiles = [];
  renderPendingFiles();
  for (const file of files) await uploadAndSendFile(file);
}

function resizeTextarea() {
  messageInput.style.height = "auto";
  messageInput.style.height = `${Math.min(messageInput.scrollHeight, 124)}px`;
}

function openNicknameModal() {
  nicknameInput.value = nickname;
  nicknameModal.classList.remove("hidden");
  setTimeout(() => { nicknameInput.focus(); nicknameInput.select(); }, 0);
}

function closeNicknameModal() {
  nicknameModal.classList.add("hidden");
}

async function saveNickname() {
  nickname = nicknameInput.value.trim().replace(/\s+/g, " ").slice(0, 24) || "访客";
  localStorage.setItem("chat-nickname", nickname);
  updateProfile();
  closeNicknameModal();
  if (channel) await channel.track({ nickname, color });
}

function showDropOverlay() {
  dropOverlay?.classList.add("visible");
  composerWrap?.classList.add("dragging");
  document.body.classList.add("dragging-files");
}

function hideDropOverlay() {
  dragDepth = 0;
  dropOverlay?.classList.remove("visible");
  composerWrap?.classList.remove("dragging");
  document.body.classList.remove("dragging-files");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitForIceGatheringComplete(peerConnection) {
  if (peerConnection.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((resolve) => {
    const timeout = setTimeout(resolve, 7000);
    const onStateChange = () => {
      if (peerConnection.iceGatheringState !== "complete") return;
      clearTimeout(timeout);
      peerConnection.removeEventListener("icegatheringstatechange", onStateChange);
      resolve();
    };
    peerConnection.addEventListener("icegatheringstatechange", onStateChange);
  });
}

function renderP2PTransfers() {
  const transfers = [...p2pTransfers.values()].slice(-8);
  p2pTransfersPanel.classList.toggle("hidden", !transfers.length);
  p2pTransfersPanel.innerHTML = transfers.map((transfer) => {
    const percentage = transfer.size ? Math.min(100, Math.round((transfer.transferred / transfer.size) * 100)) : 0;
    const statusText = {
      waiting: "等待另一台设备接收",
      claiming: "正在建立直连",
      transferring: `传输中 ${percentage}%`,
      complete: "传输完成",
      failed: transfer.error || "传输失败",
      cancelled: "已取消",
    }[transfer.status] || "准备中";
    let action = "";
    if (transfer.direction === "incoming" && transfer.status === "waiting") {
      action = `<button class="p2p-action" data-p2p-action="accept" data-p2p-id="${transfer.id}">接收</button><button class="p2p-action secondary" data-p2p-action="cancel" data-p2p-id="${transfer.id}">忽略</button>`;
    }
    if (transfer.downloadUrl) {
      action = `<a class="p2p-action download" href="${transfer.downloadUrl}" download="${escapeHtml(transfer.fileName)}">保存文件</a>`;
    }
    return `<article class="p2p-transfer-card ${transfer.direction}">
      <div class="p2p-transfer-icon">P2P</div>
      <div class="p2p-transfer-info"><strong>${escapeHtml(transfer.fileName)}</strong><small>${formatSize(transfer.size)} · ${escapeHtml(statusText)}</small>${transfer.status === "transferring" ? `<span class="p2p-progress"><i style="width:${percentage}%"></i></span>` : ""}</div>
      <div class="p2p-transfer-actions">${action}</div>
    </article>`;
  }).join("");

  p2pTransfersPanel.querySelectorAll("[data-p2p-action]").forEach((button) => {
    button.addEventListener("click", () => {
      const transfer = p2pTransfers.get(button.dataset.p2pId);
      if (!transfer) return;
      if (button.dataset.p2pAction === "accept") acceptP2PTransfer(transfer);
      else cancelP2PTransfer(transfer);
    });
  });
}

async function sendP2PSignal(event, payload) {
  if (!channel) throw new Error("Realtime 尚未连接");
  const status = await channel.send({ type: "broadcast", event, payload });
  if (status !== "ok") throw new Error(`信令发送失败：${status}`);
}

function setP2PFailed(transfer, message) {
  transfer.status = "failed";
  transfer.error = message;
  renderP2PTransfers();
}

function watchPeerConnection(transfer) {
  transfer.pc.addEventListener("connectionstatechange", () => {
    if (["failed", "closed"].includes(transfer.pc.connectionState) && !["complete", "cancelled"].includes(transfer.status)) {
      setP2PFailed(transfer, "网络无法建立直连");
    }
  });
}

async function startP2PTransfer(file) {
  if (!window.RTCPeerConnection) {
    showToast("当前浏览器不支持 P2P");
    return;
  }
  if (!channel || !peerId) {
    showToast("连接尚未建立，请稍候再试");
    return;
  }

  const transfer = {
    id: crypto.randomUUID(),
    direction: "outgoing",
    senderId: peerId,
    file,
    fileName: file.name,
    mime: file.type || "application/octet-stream",
    size: file.size,
    transferred: 0,
    status: "waiting",
    receiverId: "",
    pc: null,
    channel: null,
  };
  p2pTransfers.set(transfer.id, transfer);
  renderP2PTransfers();

  try {
    transfer.pc = new RTCPeerConnection({ iceServers });
    watchPeerConnection(transfer);
    transfer.channel = transfer.pc.createDataChannel("chat-file", { ordered: true });
    transfer.channel.binaryType = "arraybuffer";
    transfer.channel.addEventListener("open", () => sendP2PFile(transfer));
    const offer = await transfer.pc.createOffer();
    await transfer.pc.setLocalDescription(offer);
    await waitForIceGatheringComplete(transfer.pc);
    await sendP2PSignal("p2p-offer", {
      transferId: transfer.id,
      senderId: peerId,
      senderNickname: nickname,
      fileName: transfer.fileName,
      mime: transfer.mime,
      size: transfer.size,
      offer: { type: transfer.pc.localDescription.type, sdp: transfer.pc.localDescription.sdp },
    });
    showToast("P2P 文件已发布，等待其他设备接收");
  } catch (error) {
    setP2PFailed(transfer, error.message || "无法创建 P2P 连接");
  }
}

async function waitForDataChannelBuffer(dataChannel) {
  while (dataChannel.bufferedAmount > P2P_BUFFER_LIMIT) await sleep(60);
}

async function sendP2PFile(transfer) {
  if (transfer.status === "failed" || transfer.status === "cancelled") return;
  transfer.status = "transferring";
  renderP2PTransfers();
  try {
    transfer.channel.send(JSON.stringify({
      type: "metadata",
      name: transfer.fileName,
      mime: transfer.mime,
      size: transfer.size,
    }));
    for (let offset = 0; offset < transfer.file.size; offset += P2P_CHUNK_SIZE) {
      await waitForDataChannelBuffer(transfer.channel);
      const chunk = await transfer.file.slice(offset, offset + P2P_CHUNK_SIZE).arrayBuffer();
      transfer.channel.send(chunk);
      transfer.transferred = Math.min(offset + chunk.byteLength, transfer.size);
      renderP2PTransfers();
    }
    transfer.channel.send(JSON.stringify({ type: "complete" }));
    transfer.status = "complete";
    renderP2PTransfers();
  } catch (error) {
    setP2PFailed(transfer, error.message || "发送中断");
  }
}

function attachIncomingDataChannel(transfer, dataChannel) {
  transfer.channel = dataChannel;
  dataChannel.binaryType = "arraybuffer";
  dataChannel.addEventListener("message", async ({ data }) => {
    if (typeof data === "string") {
      const packet = JSON.parse(data);
      if (packet.type === "metadata") {
        transfer.fileName = packet.name;
        transfer.mime = packet.mime;
        transfer.size = packet.size;
        transfer.chunks = [];
        transfer.transferred = 0;
        transfer.status = "transferring";
        renderP2PTransfers();
      }
      if (packet.type === "complete") {
        const blob = new Blob(transfer.chunks, { type: transfer.mime });
        transfer.downloadUrl = URL.createObjectURL(blob);
        transfer.chunks = [];
        transfer.transferred = transfer.size;
        transfer.status = "complete";
        renderP2PTransfers();
        await sendP2PSignal("p2p-complete", { transferId: transfer.id, receiverId: peerId });
        showToast(`${transfer.fileName} 已接收，可保存`);
      }
      return;
    }

    const buffer = data instanceof ArrayBuffer ? data : await data.arrayBuffer();
    transfer.chunks.push(buffer);
    transfer.transferred += buffer.byteLength;
    renderP2PTransfers();
  });
}

async function acceptP2PTransfer(transfer) {
  if (transfer.status !== "waiting") return;
  transfer.status = "claiming";
  transfer.receiverId = peerId;
  renderP2PTransfers();
  try {
    await sendP2PSignal("p2p-claim", { transferId: transfer.id, receiverId: peerId });
    transfer.pc = new RTCPeerConnection({ iceServers });
    watchPeerConnection(transfer);
    transfer.pc.addEventListener("datachannel", ({ channel: dataChannel }) => attachIncomingDataChannel(transfer, dataChannel));
    await transfer.pc.setRemoteDescription(transfer.offer);
    const answer = await transfer.pc.createAnswer();
    await transfer.pc.setLocalDescription(answer);
    await waitForIceGatheringComplete(transfer.pc);
    await sendP2PSignal("p2p-answer", {
      transferId: transfer.id,
      senderId: transfer.senderId,
      receiverId: peerId,
      answer: { type: transfer.pc.localDescription.type, sdp: transfer.pc.localDescription.sdp },
    });
  } catch (error) {
    setP2PFailed(transfer, error.message || "无法接受文件");
  }
}

async function cancelP2PTransfer(transfer) {
  transfer.status = "cancelled";
  transfer.pc?.close();
  renderP2PTransfers();
  try {
    await sendP2PSignal("p2p-cancel", { transferId: transfer.id, senderId: transfer.senderId, receiverId: transfer.receiverId });
  } catch {
    // The local cancellation is enough when the signaling channel is already gone.
  }
}

async function handleP2PEvent(event, payload) {
  if (!payload || payload.transferId === undefined) return;
  const transfer = p2pTransfers.get(payload.transferId);

  if (event === "p2p-offer") {
    if (payload.senderId === peerId || transfer) return;
    p2pTransfers.set(payload.transferId, {
      id: payload.transferId,
      direction: "incoming",
      senderId: payload.senderId,
      senderNickname: payload.senderNickname,
      fileName: payload.fileName,
      mime: payload.mime,
      size: payload.size,
      offer: payload.offer,
      transferred: 0,
      status: "waiting",
      receiverId: "",
      chunks: [],
      pc: null,
      channel: null,
    });
    renderP2PTransfers();
    showToast(`${payload.senderNickname || "有人"} 发来了 P2P 文件`);
    return;
  }

  if (!transfer) return;

  if (event === "p2p-claim") {
    if (transfer.direction === "outgoing") {
      if (transfer.receiverId && transfer.receiverId !== payload.receiverId) return;
      transfer.receiverId = payload.receiverId;
      transfer.status = "claiming";
      renderP2PTransfers();
    } else if (transfer.status === "waiting" && payload.receiverId !== peerId) {
      transfer.status = "cancelled";
      renderP2PTransfers();
    }
    return;
  }

  if (event === "p2p-answer" && transfer.direction === "outgoing" && transfer.receiverId === payload.receiverId) {
    try {
      await transfer.pc.setRemoteDescription(payload.answer);
    } catch (error) {
      setP2PFailed(transfer, error.message || "无法完成连接");
    }
    return;
  }

  if (event === "p2p-complete" && transfer.direction === "outgoing") {
    transfer.status = "complete";
    renderP2PTransfers();
    return;
  }

  if (event === "p2p-cancel") {
    transfer.status = "cancelled";
    transfer.pc?.close();
    renderP2PTransfers();
  }
}

async function connect() {
  hydrateFromCache();
  updateProfile();
  if (!supabase) {
    setConnection("待配置", false);
    renderEmptyState("请先填写 public/config.js");
    showToast("请先配置 Supabase URL 和 publishable key");
    return;
  }

  try {
    setConnection("连接中", false);
    user = await ensureAnonymousUser();
    deviceId = user.id;
    localStorage.setItem("chat-device-id", deviceId);
    updateProfile();
    await loadMessages();
    await subscribeRealtime();
    setConnection("在线", true);
  } catch (error) {
    console.error(error);
    setConnection("连接失败", false);
    showToast(`Supabase 连接失败：${error.message}`);
  }
}

profileButton.addEventListener("click", openNicknameModal);
closeModalButton.addEventListener("click", closeNicknameModal);
saveNicknameButton.addEventListener("click", saveNickname);
nicknameInput.addEventListener("keydown", (event) => { if (event.key === "Enter") saveNickname(); });
nicknameModal.addEventListener("click", (event) => { if (event.target === nicknameModal) closeNicknameModal(); });
themeButton.addEventListener("click", () => toggleThemeMenu());
themeOptions.forEach((option) => option.addEventListener("click", () => { applyTheme(option.dataset.themeChoice); toggleThemeMenu(false); }));
document.addEventListener("click", (event) => { if (!event.target.closest(".theme-picker")) toggleThemeMenu(false); });
sendButton.addEventListener("click", async () => { await sendText(); await sendPendingFiles(); });
messageInput.addEventListener("input", resizeTextarea);
messageInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); sendText(); }
});
attachButton.addEventListener("click", () => fileInput.click());
p2pButton.addEventListener("click", () => p2pFileInput.click());
fileInput.addEventListener("change", () => { chooseFiles(fileInput.files); fileInput.value = ""; });
p2pFileInput.addEventListener("change", () => {
  const [file] = p2pFileInput.files || [];
  if (file) startP2PTransfer(file);
  p2pFileInput.value = "";
});
window.addEventListener("dragenter", (event) => {
  if (!event.dataTransfer?.types?.includes("Files")) return;
  event.preventDefault();
  dragDepth += 1;
  showDropOverlay();
});
window.addEventListener("dragover", (event) => {
  if (!event.dataTransfer?.types?.includes("Files")) return;
  event.preventDefault();
  showDropOverlay();
});
window.addEventListener("dragleave", (event) => {
  if (!event.dataTransfer?.types?.includes("Files")) return;
  event.preventDefault();
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) hideDropOverlay();
});
window.addEventListener("drop", (event) => {
  if (!event.dataTransfer?.files?.length) return;
  event.preventDefault();
  chooseFiles(event.dataTransfer.files);
  hideDropOverlay();
});
window.addEventListener("pagehide", () => p2pTransfers.forEach((transfer) => transfer.pc?.close()));

applyTheme(localStorage.getItem("chat-theme") || "light");
updateProfile();
connect();
