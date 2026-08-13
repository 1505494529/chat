import http from "node:http";
import { createReadStream, existsSync, statSync } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { WebSocketServer } from "ws";

const root = resolve(fileURLToPath(new URL(".", import.meta.url)));
const publicDir = join(root, "public");
const port = Number(process.env.PORT || 8787);
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_HISTORY = 120;
const group = { clients: new Map(), history: [] };

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
  client.send(JSON.stringify({ type: "error", message }));
}

const server = http.createServer((req, res) => {
  let pathname = decodeURIComponent(new URL(req.url || "/", `http://${req.headers.host || "localhost"}`).pathname);
  if (pathname === "/") pathname = "/index.html";
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

  client.on("message", (raw) => {
    let payload;
    try {
      payload = JSON.parse(raw.toString());
    } catch {
      error(client, "消息格式不正确");
      return;
    }

    if (payload.type === "join") {
      client.sessionId = String(payload.deviceId || payload.sessionId || randomUUID()).slice(0, 80);
      client.nickname = cleanNickname(payload.nickname);
      client.color = String(payload.color || "#6c63ff").slice(0, 16);
      group.clients.set(client, { sessionId: client.sessionId, nickname: client.nickname, color: client.color });
      client.send(JSON.stringify({ type: "sync", messages: group.history, users: users(), maxFileBytes: MAX_FILE_BYTES }));
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
      const index = group.history.findIndex((message) => message.id === messageId);
      if (index < 0) {
        error(client, "这条消息已经不存在了");
        return;
      }
      if (group.history[index].sessionId !== client.sessionId) {
        error(client, "只能删除自己发送的消息");
        return;
      }
      group.history.splice(index, 1);
      broadcast({ type: "deleted", messageId });
      return;
    }

    if (payload.type === "message") {
      const kind = ["text", "image", "file"].includes(payload.kind) ? payload.kind : "text";
      const text = String(payload.text || "").trim().slice(0, 4000);
      const data = typeof payload.data === "string" ? payload.data : "";
      if (kind === "text" && !text) return;
      if (kind !== "text" && (!data || data.length > MAX_FILE_BYTES * 1.5)) {
        error(client, "文件不能超过 8MB");
        return;
      }

      const message = {
        id: randomUUID(),
        kind,
        text,
        data: kind === "text" ? "" : data,
        name: String(payload.name || "未命名文件").slice(0, 160),
        mime: String(payload.mime || "application/octet-stream").slice(0, 100),
        size: Number(payload.size || 0),
        nickname: client.nickname,
        sessionId: client.sessionId,
        color: client.color,
        createdAt: Date.now(),
      };
      group.history.push(message);
      if (group.history.length > MAX_HISTORY) group.history.splice(0, group.history.length - MAX_HISTORY);
      broadcast({ type: "message", message });
    }
  });

  client.on("close", () => {
    group.clients.delete(client);
    broadcast({ type: "presence", users: users() });
  });
});

server.listen(port, () => {
  console.log(`Chat is running at http://localhost:${port}`);
});
