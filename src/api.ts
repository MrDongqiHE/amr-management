// API 基地址：本地开发走 Vite proxy（/api → supabase functions），
// 生产构建（Vercel 等静态托管）直接用 Supabase Functions URL。
const FN_BASE = 'https://zmpfjtnhldeckinukbcs.supabase.co/functions/v1';
export const apiBase = import.meta.env.DEV ? '/api' : FN_BASE;
export function apiUrl(action: string) { return `${apiBase}/kk-notion-sync?action=${action}`; }

// 带登录 JWT 的 fetch：Edge Function verify_jwt=true 后所有调用必须带 Authorization 头。
// 登录成功后调 setApiToken(session.access_token)，登出时 setApiToken(null)。
let apiToken: string | null = null;
export function setApiToken(t: string | null) { apiToken = t; }
export function apiFetch(url: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers || {});
  if (apiToken) headers.set('Authorization', `Bearer ${apiToken}`);
  if (init.body) headers.set('Content-Type', 'application/json');
  return fetch(url, { ...init, headers });
}
