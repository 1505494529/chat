import { createClient } from "https://esm.sh/@supabase/supabase-js@2.112.3";

const config = globalThis.CHAT_CONFIG || {};
const supabaseUrl = String(config.supabaseUrl || "").trim();
const supabaseAnonKey = String(config.supabaseAnonKey || "").trim();
const iceServers = config.iceServers || [
  { urls: ["stun:stun.l.google.com:19302", "stun:stun.cloudflare.com:3478"] },
];

const runButton = document.querySelector("#runButton");
const copyButton = document.querySelector("#copyButton");
const overallDot = document.querySelector("#overallDot");
const overallText = document.querySelector("#overallText");
const checkGrid = document.querySelector("#checkGrid");
const peerState = document.querySelector("#peerState");
const eventLog = document.querySelector("#eventLog");

const peerId = crypto.randomUUID();
const peerLabel = navigator.userAgentData?.mobile || /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent) ? "手机" : "电脑";
const checks = new Map();
const logLines = [];

let supabase = null;
let channel = null;
let peerConnection = null;
let dataChannel = null;
let remotePeer = null;
let role = "";
let offerSent = false;
let running = false;
let timeoutTimer = null;
let lastPath = "";
let localCandidateTypes = [];

function applySavedTheme() {
  const theme = localStorage.getItem("chat-theme") || "light";
  document.documentElement.dataset.theme = theme;
}

function log(message) {
  const stamp = new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(new Date());
  logLines.push(`[${stamp}] ${message}`);
  eventLog.textContent = logLines.slice(-80).join("\n");
  eventLog.scrollTop = eventLog.scrollHeight;
}

function setOverall(text, status = "") {
  overallText.textContent = text;
  overallDot.className = `status-dot${status ? ` ${status}` : ""}`;
}

function setPeer(text, status = "") {
  peerState.textContent = text;
  peerState.className = status ? `peer-state ${status}` : "";
}

function setCheck(key, title, detail, status = "") {
  checks.set(key, { title, detail, status });
  checkGrid.innerHTML = [...checks.values()].map((item) => `<article class="check-item ${item.status}">
    <span class="check-icon">${item.status === "good" ? "✓" : item.status === "bad" ? "!" : item.status === "warn" ? "·" : "?"}</span>
    <div><strong>${escapeHtml(item.title)}</strong><small>${escapeHtml(item.detail)}</small></div>
  </article>`).join("");
}

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;",
  }[character]));
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitForIceGatheringComplete(pc, timeout = 10000) {
  if (pc.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pc.removeEventListener("icegatheringstatechange", onStateChange);
      resolve();
    }, timeout);
    const onStateChange = () => {
      if (pc.iceGatheringState !== "complete") return;
      clearTimeout(timer);
      pc.removeEventListener("icegatheringstatechange", onStateChange);
      resolve();
    };
    pc.addEventListener("icegatheringstatechange", onStateChange);
  });
}

function parseCandidateTypes(sdp = "") {
  return [...new Set(sdp.split("\n").map((line) => line.match(/\btyp\s+(host|srflx|relay|prflx)\b/)?.[1]).filter(Boolean))];
}

function describeCandidateTypes(types) {
  if (!types.length) return "没有收集到 ICE 候选地址";
  const names = { host: "局域网 host", srflx: "公网 srflx", relay: "TURN relay", prflx: "对等 prflx" };
  return types.map((type) => names[type] || type).join("、");
}

async function runLocalIceCheck() {
  const pc = new RTCPeerConnection({ iceServers });
  try {
    pc.createDataChannel("local-probe");
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await waitForIceGatheringComplete(pc);
    localCandidateTypes = parseCandidateTypes(pc.localDescription?.sdp || "");
    const hasHost = localCandidateTypes.includes("host");
    const hasSrflx = localCandidateTypes.includes("srflx");
    const hasRelay = localCandidateTypes.includes("relay");
    const status = hasRelay || hasSrflx || hasHost ? "good" : "bad";
    setCheck("ice", "本机 ICE 候选", describeCandidateTypes(localCandidateTypes), status);
    log(`本机候选类型：${describeCandidateTypes(localCandidateTypes)}`);
    if (!hasSrflx && !hasRelay) log("未获得公网或 TURN 候选；可能是 STUN 被拦截，或当前配置没有 TURN。");
    return localCandidateTypes;
  } catch (error) {
    setCheck("ice", "本机 ICE 候选", error.message || "无法收集候选地址", "bad");
    log(`本机 ICE 检查失败：${error.message}`);
    return [];
  } finally {
    pc.close();
  }
}

async function runBasicChecks() {
  checks.clear();
  checkGrid.innerHTML = "";
  const secure = globalThis.isSecureContext || ["localhost", "127.0.0.1"].includes(location.hostname);
  setCheck("secure", "安全上下文", secure ? "HTTPS / localhost，可使用 WebRTC" : "当前不是 HTTPS，部分浏览器会限制 WebRTC", secure ? "good" : "warn");
  setCheck("browser", "浏览器支持", globalThis.RTCPeerConnection ? "支持 RTCPeerConnection" : "不支持 RTCPeerConnection", globalThis.RTCPeerConnection ? "good" : "bad");
  setCheck("online", "网络状态", navigator.onLine ? "浏览器显示在线" : "浏览器显示离线", navigator.onLine ? "good" : "bad");
  const configReady = Boolean(supabaseUrl && supabaseAnonKey);
  setCheck("config", "Supabase 配置", configReady ? "URL 和 publishable/anon key 已填写" : "请先填写 public/config.js", configReady ? "good" : "bad");
  log(`设备标识：${peerLabel} / ${peerId.slice(0, 8)}`);
  if (globalThis.RTCPeerConnection) await runLocalIceCheck();
  return configReady && Boolean(globalThis.RTCPeerConnection);
}

async function ensureChannel() {
  supabase = createClient(supabaseUrl, supabaseAnonKey, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
  });
  const { data: sessionData, error: sessionError } = await supabase.auth.getSession();
  if (sessionError) throw sessionError;
  if (!sessionData.session?.user) {
    const { error } = await supabase.auth.signInAnonymously();
    if (error) throw error;
  }

  channel = supabase.channel("webrtc:diagnostics", { config: { broadcast: { self: false } } });
  channel
    .on("broadcast", { event: "diag-hello" }, ({ payload }) => handleSignal("diag-hello", payload))
    .on("broadcast", { event: "diag-offer" }, ({ payload }) => handleSignal("diag-offer", payload))
    .on("broadcast", { event: "diag-answer" }, ({ payload }) => handleSignal("diag-answer", payload));

  const status = await new Promise((resolve) => {
    channel.subscribe((nextStatus) => {
      if (["SUBSCRIBED", "CHANNEL_ERROR", "TIMED_OUT", "CLOSED"].includes(nextStatus)) resolve(nextStatus);
    });
  });
  if (status !== "SUBSCRIBED") throw new Error(`Realtime 连接失败：${status}`);
  setCheck("realtime", "Supabase Realtime", "信令通道已连接", "good");
  log("Supabase Realtime 信令通道已连接。");
}

async function sendSignal(event, payload) {
  const status = await channel.send({ type: "broadcast", event, payload });
  if (status !== "ok") throw new Error(`信令发送失败：${status}`);
}

function closePeerConnection() {
  if (dataChannel) dataChannel.close();
  if (peerConnection) peerConnection.close();
  dataChannel = null;
  peerConnection = null;
}

function selectedCandidatePair() {
  if (!peerConnection) return Promise.resolve(null);
  return peerConnection.getStats().then((stats) => {
    const reports = [...stats.values()];
    const pair = reports.find((item) => item.type === "candidate-pair" && item.state === "succeeded" && (item.selected || item.nominated))
      || reports.find((item) => item.type === "candidate-pair" && item.state === "succeeded");
    if (!pair) return null;
    const local = reports.find((item) => item.id === pair.localCandidateId);
    const remote = reports.find((item) => item.id === pair.remoteCandidateId);
    return { localType: local?.candidateType || "unknown", remoteType: remote?.candidateType || "unknown" };
  }).catch(() => null);
}

function describePath(pair) {
  if (!pair) return { label: "没有找到已成功的候选对", status: "bad", detail: "双方已完成信令，但没有可用的网络路径。优先检查 Wi‑Fi 客户端隔离、电脑防火墙或 TURN。" };
  const types = [pair.localType, pair.remoteType];
  if (types.includes("relay")) return { label: "TURN 中继", status: "good", detail: `已通过 TURN relay 建立连接（${pair.localType} ↔ ${pair.remoteType}）。` };
  if (types.every((type) => type === "host")) return { label: "局域网直连", status: "good", detail: "两台设备通过局域网地址直连，Wi‑Fi 允许设备互访。" };
  if (types.includes("srflx") || types.includes("prflx")) return { label: "公网直连（STUN）", status: "good", detail: `已通过公网候选地址直连（${pair.localType} ↔ ${pair.remoteType}），没有使用 TURN。` };
  return { label: "直连", status: "good", detail: `连接已建立（${pair.localType} ↔ ${pair.remoteType}）。` };
}

async function finishSuccess() {
  if (!running) return;
  running = false;
  clearTimeout(timeoutTimer);
  const path = describePath(await selectedCandidatePair());
  lastPath = path.label;
  setCheck("path", "最终连接路径", path.label, path.status);
  setOverall(`诊断成功：${path.label}`, "good");
  setPeer(`测试数据包已往返成功。${path.detail}`, "good");
  log(`诊断成功：${path.detail}`);
  copyButton.disabled = false;
  runButton.disabled = false;
}

function failTest(message) {
  if (!running) return;
  running = false;
  clearTimeout(timeoutTimer);
  setCheck("path", "最终连接路径", message, "bad");
  setOverall("诊断失败：未建立 WebRTC 通道", "bad");
  setPeer(message, "bad");
  log(`诊断失败：${message}`);
  copyButton.disabled = false;
  runButton.disabled = false;
}

function installDataChannel(nextChannel) {
  dataChannel = nextChannel;
  dataChannel.binaryType = "arraybuffer";
  dataChannel.addEventListener("open", () => {
    log("DataChannel 已打开，发送测试数据包。");
    setPeer("WebRTC 通道已打开，正在验证数据往返…", "good");
    if (role === "offerer") dataChannel.send(JSON.stringify({ type: "diagnostic-ping", sentAt: Date.now() }));
  });
  dataChannel.addEventListener("message", ({ data }) => {
    if (typeof data !== "string") return;
    try {
      const packet = JSON.parse(data);
      if (packet.type === "diagnostic-ping" && dataChannel.readyState === "open") {
        dataChannel.send(JSON.stringify({ type: "diagnostic-pong", sentAt: packet.sentAt, receivedAt: Date.now() }));
      }
      if (packet.type === "diagnostic-pong") finishSuccess();
    } catch {
      log("收到无法解析的测试数据。");
    }
  });
  dataChannel.addEventListener("error", () => failTest("DataChannel 报错，可能是浏览器或防火墙阻止了 UDP 通信。"));
}

function watchPeerConnection() {
  peerConnection.addEventListener("iceconnectionstatechange", () => {
    log(`ICE 状态：${peerConnection.iceConnectionState}`);
    if (peerConnection.iceConnectionState === "failed") failTest("ICE 连接失败：当前网络没有可用的直连路径，检查 Wi‑Fi 隔离或配置 TURN。 ");
  });
  peerConnection.addEventListener("connectionstatechange", () => {
    log(`PeerConnection 状态：${peerConnection.connectionState}`);
    if (["failed", "closed"].includes(peerConnection.connectionState)) failTest("PeerConnection 连接失败：双方设备无法建立可用通道。");
  });
}

async function createOffer() {
  if (!running || offerSent || !remotePeer) return;
  role = "offerer";
  offerSent = true;
  peerConnection = new RTCPeerConnection({ iceServers });
  watchPeerConnection();
  installDataChannel(peerConnection.createDataChannel("diagnostic", { ordered: true }));
  const offer = await peerConnection.createOffer();
  await peerConnection.setLocalDescription(offer);
  await waitForIceGatheringComplete(peerConnection);
  await sendSignal("diag-offer", { from: peerId, to: remotePeer.id, label: peerLabel, sdp: peerConnection.localDescription });
  setPeer(`已向${remotePeer.label || "另一端"}发送连接请求，等待应答…`);
  log(`已发送 offer，目标：${remotePeer.label || "另一端"}。`);
}

async function createAnswer(payload) {
  if (!running || peerConnection) return;
  role = "answerer";
  remotePeer = { id: payload.from, label: payload.label };
  peerConnection = new RTCPeerConnection({ iceServers });
  watchPeerConnection();
  peerConnection.addEventListener("datachannel", ({ channel: nextChannel }) => installDataChannel(nextChannel));
  await peerConnection.setRemoteDescription(payload.sdp);
  const answer = await peerConnection.createAnswer();
  await peerConnection.setLocalDescription(answer);
  await waitForIceGatheringComplete(peerConnection);
  await sendSignal("diag-answer", { from: peerId, to: payload.from, label: peerLabel, sdp: peerConnection.localDescription });
  setPeer(`已向${remotePeer.label || "另一端"}返回应答，等待通道打开…`);
  log("已发送 answer。");
}

async function handleSignal(event, payload) {
  if (!running || !payload || payload.from === peerId) return;
  if (event === "diag-hello") {
    if (remotePeer && remotePeer.id !== payload.from) return;
    remotePeer = { id: payload.from, label: payload.label };
    setPeer(`发现${payload.label || "另一端"}，正在协商…`);
    log(`发现另一端：${payload.label || "未知设备"}。`);
    await wait(450);
    if (peerId < payload.from) {
      try { await createOffer(); } catch (error) { failTest(`创建 offer 失败：${error.message}`); }
    }
    return;
  }
  if (payload.to !== peerId) return;
  if (event === "diag-offer") {
    try { await createAnswer(payload); } catch (error) { failTest(`创建 answer 失败：${error.message}`); }
    return;
  }
  if (event === "diag-answer" && role === "offerer" && peerConnection) {
    try {
      await peerConnection.setRemoteDescription(payload.sdp);
      log("已收到 answer。");
      setPeer("已收到应答，等待 ICE 连接…");
    } catch (error) {
      failTest(`设置 answer 失败：${error.message}`);
    }
  }
}

async function runDiagnostics() {
  if (running) return;
  running = true;
  runButton.disabled = true;
  copyButton.disabled = true;
  logLines.length = 0;
  eventLog.textContent = "";
  remotePeer = null;
  role = "";
  offerSent = false;
  lastPath = "";
  closePeerConnection();
  setOverall("正在检查本机环境…");
  setPeer("正在连接诊断信令…");
  log("开始诊断。");

  const canContinue = await runBasicChecks();
  if (!canContinue) {
    running = false;
    runButton.disabled = false;
    copyButton.disabled = false;
    setOverall("本机环境未通过，无法开始双端测试", "bad");
    setPeer("请先解决上面的浏览器、HTTPS 或 Supabase 配置问题。", "bad");
    return;
  }

  try {
    await ensureChannel();
    setOverall("等待另一台设备…", "warn");
    setPeer(`当前设备：${peerLabel}。请在另一台设备也点击“开始诊断”。`, "warn");
    await sendSignal("diag-hello", { from: peerId, label: peerLabel });
    log("已广播 hello，等待另一端。");
    timeoutTimer = setTimeout(() => failTest("等待超时：请确认手机和电脑都打开了诊断页，并且 Supabase Realtime 正常。"), 35000);
  } catch (error) {
    failTest(`诊断信令失败：${error.message}`);
  }
}

async function copyReport() {
  const report = [
    `设备：${peerLabel}`,
    `本机候选：${describeCandidateTypes(localCandidateTypes)}`,
    `最终路径：${lastPath || "未建立"}`,
    `日志：`,
    ...logLines,
  ].join("\n");
  try {
    await navigator.clipboard.writeText(report);
    setOverall("诊断结果已复制", "good");
  } catch {
    setOverall("浏览器不允许自动复制，请手动复制日志", "warn");
  }
}

runButton.addEventListener("click", runDiagnostics);
copyButton.addEventListener("click", copyReport);
window.addEventListener("beforeunload", () => {
  clearTimeout(timeoutTimer);
  closePeerConnection();
  channel?.unsubscribe();
});
applySavedTheme();
