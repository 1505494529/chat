# 网页聊天

打开网址即可进入同一个群聊，无需登录。支持文字、图片和文件消息，点击右上角昵称即可修改昵称。

## 本地运行

需要 Node.js 18+。

```bash
npm install
npm start
```

打开 http://localhost:8787 。

消息保存在服务端内存中，服务重启后清空；单文件最大 8MB。每个浏览器会生成一个持久化设备 ID，改昵称不会改变设备身份；清除浏览器站点数据后会生成新的设备 ID。

## 免费部署：Render

推荐使用 Render Free Web Service。它可以直接运行当前 Node + WebSocket 项目，支持自定义域名和 TLS，不需要改写前端或后端。免费实例连续 15 分钟没有请求或 WebSocket 消息时会休眠；重新打开时可能需要等待约 1 分钟。服务重启或休眠后，当前内存里的历史消息会清空。

1. 把这个文件夹上传到一个 GitHub 仓库。
2. 打开 Render，选择 **New → Blueprint**，连接这个 GitHub 仓库。
3. Render 会读取 `render.yaml`，创建一个名为 `simple-chat` 的 Free Web Service。
4. 等部署完成后，在 Render 服务页面找到 `*.onrender.com` 地址，先打开确认聊天正常。
5. 在 Render 服务的 **Settings → Custom Domains** 添加你准备使用的域名或子域名，例如 `chat.example.com`。
6. Render 会显示 DNS 配置值。到你的域名 DNS 管理处添加 CNAME：

   - 主机记录：`chat`（如果你绑定的是 `chat.example.com`）
   - 记录类型：`CNAME`
   - 记录值：Render 页面显示的 `*.onrender.com` 地址

7. 等待 DNS 生效，再回到 Render 完成域名验证。Render 会自动签发 HTTPS 证书；前端会自动使用 `wss://` 连接 WebSocket。

如果你使用的是根域名而不是子域名，DNS 服务商可能不支持根域名 CNAME。自用场景建议使用 `chat.你的域名.com` 这种子域名，最简单稳定。
