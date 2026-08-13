# GitHub Pages + Supabase 配置

## 1. Supabase

1. 创建 Supabase 项目。
2. 进入 `Authentication -> Providers`，打开 `Anonymous Sign-Ins`。
3. 打开 `SQL Editor`，执行 `supabase/schema.sql`。
4. 在 `Project Settings -> API Keys` 复制：
   - `Project URL`
   - `publishable key`；如果项目仍显示旧版密钥，也可以使用 `anon` key

## 2. 静态网页配置

编辑 `public/config.js`：

```js
window.CHAT_CONFIG = {
  supabaseUrl: "https://你的项目.supabase.co",
  supabaseAnonKey: "你的publishable或anon key",
  storageBucket: "chat-files",
  standardFileMaxBytes: 50 * 1024 * 1024,
};
```

publishable/anon key 可以出现在静态网页中；不要把 `service_role` key 写入 `config.js`。

## 3. GitHub Pages

项目已经包含 `.github/workflows/pages.yml`，会把 `public` 目录自动部署到 GitHub Pages。

在 GitHub 仓库中打开：

`Settings -> Pages -> Build and deployment -> Source: GitHub Actions`

推送到 `main` 分支后，Actions 会自动部署。

项目里的 `public/CNAME` 已写入 `chat.dongshi.asia`。腾讯云 DNS 需要把 `chat` 的 CNAME 指向 GitHub Pages 给出的域名，例如：

```text
你的用户名.github.io
```

## 4. 普通附件与 P2P 附件

- 普通图片和文件：上传到 Supabase Storage，并在 `messages` 表保存元数据。
- P2P 大文件：只通过 Supabase Realtime 交换 WebRTC offer/answer，文件本身在两台设备之间传输，不写入 Supabase Storage，也不会出现在历史消息中。
- P2P 需要发送方和接收方同时在线。部分公司网络、校园网或严格 NAT 环境无法直连，需要额外配置 TURN 服务器。

## 5. 安全边界

数据库访问由匿名 Supabase Auth 身份和 RLS 策略控制。浏览器里的 `publishable/anon key` 不是管理密钥；真正敏感的 `service_role` key 不再需要，也不应该放到 GitHub Pages。
