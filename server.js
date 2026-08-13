import http from "node:http";
import { Buffer } from "node:buffer";
import { createReadStream, existsSync, statSync } from "node:fs";
import { basename, extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { WebSocketServer } from "ws";

const root = resolve(fileURLToPath(new URL(".", import.meta.url)));
const publicDir = join(root, "public");
const port = Number(process.env.PORT || 8787);
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_SYNC_MESSAGES = 120;
const STORAGE_BUCKET = process.env.SUPABASE_STORAGE_BUCKET || "chat-files";
const supabaseUrl = process.env.SUPABASE_URL?.trim();
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
const supabase = supabaseUrl && supabaseServiceRoleKey
  ? createClient(supabaseUrl, supabaseServiceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    })
  : null;

const group = { clients: new Map(), history: [] };
let persistenceState = supabase ? "starting" : "memory";

const mimeTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

function cleanNickname(value) {
  const nickname = String(value || "访客").trim().replace(/\s+/g, " ");
  return nickname.slice(0, 24) || "访客";
}

function users() {
  return [...group.clients.values()].map(({ sessionId, nickname, color }) => ({ sessionId, nickname, color }));
}

function broadcast(payload) {
  const message = JSON.stringify(payload);
  for (const client of group.clients.keys()) {
    if (client.readyState === 1) client.send(message);
  }
}

function error(client, message) {
  if (client.readyState === 1) client.send(JSON.stringify({ type: "error", message }));
}

function publicMessage(message) {
  const { storagePath, ...safeMessage } = message;
  return safeMessage;
}

function fromDatabase(row) {
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
    createdAt: new Date(row.created_at).getTime(),
    storagePath: row.storage_path || "",
  };
}

async function loadHistory() {
  if (!supabase) return;

  const { data, error: queryError } = await supabase
    .from("messages")
    .select("id, kind, text, file_url, storage_path, name, mime, size, nickname, session_id, color, created_at")
    .order("created_at", { ascending: false })
    .limit(MAX_SYNC_MESSAGES);

  if (queryError) throw queryError;
  group.history = (data || []).reverse().map(fromDatabase);
  persistenceState = "ready";
  console.log(`Supabase persistence enabled; loaded ${group.history.length} messages.`);
}

const persistenceReady = loadHistory().catch((startupError) => {
  persistenceState = "error";
  console.error("Supabase initialization failed:", startupError.message);
});

async function ensurePersistenceReady() {
  await persistenceReady;
  if (persistenceState === "error") {
    throw new Error("Supabase 尚未完成配置，请检查数据库表和环境变量");
  }
}

function decodeDataUrl(value) {
  const match = /^data:([^;,]+)?(?:;[^;,]+)*;base64,(.+)$/s.exec(String(value || ""));
  if (!match) return null;

  const buffer = Buffer.from(match[2], "base64");
  if (!buffer.length) return null;
  return { buffer, contentType: match[1] || "application/octet-stream" };
}

function safeFileName(value) {
  const originalName = basename(String(value || "file"));
  return originalName.replace(/[^\p{L}\p{N}._-]+/gu, "-").slice(0, 100) || "file";
}

async function removeStorageFile(storagePath) {
  if (!supabase || !storagePath) return;
  const { error: removeError } = await supabase.storage.from(STORAGE_BUCKET).remove([storagePath]);
  if (removeError) console.warn("Unable to remove Supabase Storage object:", removeError.message);
}

async function persistMessage(message, attachment) {
  if (!supabase) {
    message.data = attachment?.dataUrl || "";
    return;
  }

  await ensurePersistenceReady();
  let storagePath = "";

  try {
    if (attachment) {
      storagePath = `${new Date(message.createdAt).toISOString().slice(0, 10)}/${message.id}-${safeFileName(message.name)}`;
      const { error: uploadError } = await supabase.storage.from(STORAGE_BUCKET).upload(storagePath, attachment.buffer, {
        contentType: message.mime || attachment.contentType,
        upsert: false,
      });
      if (uploadError) throw uploadError;

      const { data: publicData } = supabase.storage.from(STORAGE_BUCKET).getPublicUrl(storagePath);
      message.data = publicData.publicUrl;
      message.storagePath = storagePath;
    }

    const { error: insertError } = await supabase.from("messages").insert({
      id: message.id,
      kind: message.kind,
      text: message.text,
      file_url: message.data,
      storage_path: message.storagePath || null,
      name: message.name,
      mime: message.mime,
      size: message.size,
      nickname: message.nickname,
      session_id: message.sessionId,
      color: message.color,
      created_at: new Date(message.createdAt).toISOString(),
    });

    if (insertError) throw insertError;
  } catch (saveError) {
    await removeStorageFile(storagePath);
    throw saveError;
  }
}

async function findPersistedMessage(messageId) {
  const { data, error: queryError } = await supabase
    .from("messages")
    .select("id, session_id, storage_path")
    .eq("id", messageId)
    .maybeSingle();
  if (queryError) throw queryError;
  return data;
}

async function deleteMessage(messageId, sessionId) {
  if (!supabase) {
    const index = group.history.findIndex((message) => message.id === messageId);
    if (index < 0) return "missing";
    if (group.history[index].sessionId !== sessionId) return "forbidden";
    group.history.splice(index, 1);
    return "deleted";
  }

  await ensurePersistenceReady();
  const storedMessage = await findPersistedMessage(messageId);
  if (!storedMessage) return "missing";
  if (storedMessage.session_id !== sessionId) return "forbidden";

  const { error: deleteError } = await supabase
    .from("messages")
    .delete()
    .eq("id", messageId)
    .eq("session_id", sessionId);
  if (deleteError) throw deleteError;

  await removeStorageFile(storedMessage.storage_path);
  group.history = group.history.filter((message) => message.id !== messageId);
  return "deleted";
}

const server = http.createServer((req, res) => {
  let pathname = decodeURIComponent(new URL(req.url || "/", `http://${req.headers.host || "localhost"}`).pathname);
  if (pathname === "/") pathname = "/index.html";
  if (pathname === "/healthz") {
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: true, persistence: persistenceState }));
    return;
  }

  const relativePath = normalize(pathname).replace(/^([.][.][/\\])+/, "");
  const filePath = join(publicDir, relativePath);

  if (!filePath.startsWith(publicDir) || !existsSync(filePath) || !statSync(filePath).isFile()) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not found");
    return;
  }

  res.writeHead(200, {
    "Content-Type": mimeTypes[extname(filePath)] || "application/octet-stream",
    "Cache-Control": "no-cache",
  });
  createReadStream(filePath).pipe(res);
});

const wss = new WebSocketServer({ server });

wss.on("connection", (client) => {
  client.sessionId = null;

  client.on("message", async (raw) => {
    let payload;
    try {
      payload = JSON.parse(raw.toString());
    } catch {
      error(client, "消息格式不正确");
      return;
    }

    try {
      if (payload.type === "join") {
        await persistenceReady;
        client.sessionId = String(payload.deviceId || payload.sessionId || randomUUID()).slice(0, 80);
        client.nickname = cleanNickname(payload.nickname);
        client.color = String(payload.color || "#6c63ff").slice(0, 16);
        group.clients.set(client, { sessionId: client.sessionId, nickname: client.nickname, color: client.color });
        client.send(JSON.stringify({
          type: "sync",
          messages: group.history.map(publicMessage),
          users: users(),
          maxFileBytes: MAX_FILE_BYTES,
          persistence: persistenceState === "ready",
        }));
        broadcast({ type: "presence", users: users() });
        return;
      }

      if (!client.sessionId) {
        error(client, "连接还未准备好");
        return;
      }

      if (payload.type === "ping") {
        client.send(JSON.stringify({ type: "pong" }));
        return;
      }

      if (payload.type === "rename") {
        client.nickname = cleanNickname(payload.nickname);
        const member = group.clients.get(client);
        if (member) member.nickname = client.nickname;
        broadcast({ type: "presence", users: users() });
        return;
      }

      if (payload.type === "delete") {
        const messageId = String(payload.messageId || "");
        const result = await deleteMessage(messageId, client.sessionId);
        if (result === "missing") {
          error(client, "这条消息已经不存在了");
          return;
        }
        if (result === "forbidden") {
          error(client, "只能删除自己发送的消息");
          return;
        }
        broadcast({ type: "deleted", messageId });
        return;
      }

      if (payload.type === "message") {
        const kind = ["text", "image", "file"].includes(payload.kind) ? payload.kind : "text";
        const text = String(payload.text || "").trim().slice(0, 4000);
        const dataUrl = typeof payload.data === "string" ? payload.data : "";
        if (kind === "text" && !text) return;

        let attachment = null;
        if (kind !== "text") {
          attachment = decodeDataUrl(dataUrl);
          if (!attachment || attachment.buffer.length > MAX_FILE_BYTES) {
            error(client, "文件不能超过 8MB");
            return;
          }
        }

        const message = {
          id: randomUUID(),
          kind,
          text,
          data: "",
          name: String(payload.name || "未命名文件").slice(0, 160),
          mime: String(payload.mime || attachment?.contentType || "application/octet-stream").slice(0, 100),
          size: Number(payload.size || attachment?.buffer.length || 0),
          nickname: client.nickname,
          sessionId: client.sessionId,
          color: client.color,
          createdAt: Date.now(),
        };

        await persistMessage(message, attachment ? { ...attachment, dataUrl } : null);
        group.history.push(message);
        if (group.history.length > MAX_SYNC_MESSAGES) group.history.splice(0, group.history.length - MAX_SYNC_MESSAGES);
        broadcast({ type: "message", message: publicMessage(message) });
      }
    } catch (messageError) {
      console.error("Message handling failed:", messageError);
      error(client, messageError.message || "操作失败，请稍后重试");
    }
  });

  client.on("close", () => {
    group.clients.delete(client);
    broadcast({ type: "presence", users: users() });
  });
});

server.listen(port, () => {
  console.log(`Chat is running at http://localhost:${port}`);
  if (!supabase) console.warn("Supabase is not configured; using in-memory history only.");
});
