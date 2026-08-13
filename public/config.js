// Supabase 的 URL 和 publishable/anon key 可以安全地放在静态网页里。
// 真正的安全边界由 Supabase Auth 和 RLS 策略提供，不要把 service_role key 放这里。
window.CHAT_CONFIG = {
  // 将下面两项替换成 Supabase 项目中的实际值。
  // 留空时页面会以“待配置”状态打开，不会尝试连接错误地址。
  supabaseUrl: "https://iptnofeqdonypmxoapii.supabase.co",
  supabaseAnonKey: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImlwdG5vZmVxZG9ueXBteG9hcGlpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODY2OTY4NjIsImV4cCI6MjEwMjI3Mjg2Mn0.n6FuzS0qjWQpTBMZ4NJhSMbJ7HKhKPTwVzt6ryVnHNM",
  storageBucket: "chat-files",
  standardFileMaxBytes: 50 * 1024 * 1024,
  iceServers: [
    { urls: ["stun:stun.l.google.com:19302", "stun:stun.cloudflare.com:3478"] },
  ],
};
