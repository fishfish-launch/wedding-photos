// Supabase との通信と共通処理
const CFG = window.APP_CONFIG;
const AUTH = { apikey: CFG.supabaseKey, Authorization: "Bearer " + CFG.supabaseKey };

async function rpc(fn, args) {
  const r = await fetch(`${CFG.supabaseUrl}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers: { ...AUTH, "Content-Type": "application/json" },
    body: JSON.stringify(args),
  });
  if (!r.ok) throw new Error(`${fn} ${r.status}: ${await r.text()}`);
  return r.status === 204 ? null : r.json();
}

async function uploadObject(path, blob) {
  const r = await fetch(`${CFG.supabaseUrl}/storage/v1/object/photos/${path}`, {
    method: "POST",
    headers: { ...AUTH, "Content-Type": "image/jpeg", "cache-control": "max-age=31536000" },
    body: blob,
  });
  if (!r.ok) throw new Error(`upload ${r.status}: ${await r.text()}`);
}

const publicUrl = (p) => `${CFG.supabaseUrl}/storage/v1/object/public/photos/${p}`;

// 合言葉（QRコードのURLに入っている ?k=...）
function getParam(name, storage) {
  const v = new URLSearchParams(location.search).get(name);
  try {
    if (v) storage.setItem("wp_" + name, v);
    return v || storage.getItem("wp_" + name) || "";
  } catch { return v || ""; }
}
const EVENT_CODE = getParam("k", localStorage);
const ADMIN_CODE = getParam("admin", sessionStorage);

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// 写真一覧の取得（since 以降の差分だけ取ることもできる）
async function fetchPhotos(since) {
  return rpc("list_photos", { p_code: EVENT_CODE, p_since: since || null });
}
