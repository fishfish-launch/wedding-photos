// ゲスト用画面：撮影・アップロード・みんなのギャラリー
const $ = (id) => document.getElementById(id);
$("couple").textContent = CFG.couple;
$("date").textContent = CFG.date;
document.title = `${CFG.couple} | Wedding Photos`;

let photos = [];      // 新しい順
let lastSeen = null;  // 差分取得用
let lbIndex = -1;

if (!EVENT_CODE) {
  $("nocode").hidden = false;
} else {
  $("app").hidden = false;
  try { $("name").value = localStorage.getItem("wp_name") || ""; } catch {}
  $("name").addEventListener("change", () => { try { localStorage.setItem("wp_name", $("name").value.trim()); } catch {} });
  for (const id of ["shoot", "pick"]) {
    $(id).addEventListener("change", (e) => { enqueue([...e.target.files]); e.target.value = ""; });
  }
  loadQuota();
  refresh();
  setInterval(() => { if (!document.hidden) refresh(); }, 8000);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) refresh(); });
}

// ---------- のこり枚数（フィルムカメラ方式） ----------
let limit = null, used = 0;
function deviceId() {
  try {
    let d = localStorage.getItem("wp_device");
    if (!d) { d = crypto.randomUUID(); localStorage.setItem("wp_device", d); }
    return d;
  } catch { return (window._dev ||= crypto.randomUUID()); }
}
async function loadQuota() {
  try {
    const [q] = await rpc("get_quota", { p_code: EVENT_CODE, p_device: deviceId() });
    limit = q.shot_limit; used = q.used;
    showQuota();
  } catch (e) { console.error(e); }
}
// まだ撮れる枚数（送信待ちの分も引く）
const remaining = () => (limit == null ? Infinity : Math.max(0, limit - used - queue.length - (sending ? 1 : 0)));
function showQuota() {
  if (limit == null) return;
  $("film").hidden = false;
  $("left").textContent = remaining();
  $("limit").textContent = $("limit2").textContent = limit;
  $("actions").classList.toggle("out", remaining() <= 0);
}

// ---------- ギャラリー ----------
async function refresh() {
  try {
    const rows = await fetchPhotos(lastSeen);
    addPhotos(rows);
  } catch (e) {
    if (String(e.message).includes("invalid code")) { $("app").hidden = true; $("nocode").hidden = false; }
  }
}

function addPhotos(rows) {
  for (const r of rows) {
    if (photos.some((p) => p.id === r.id)) continue;
    photos.unshift(r);
    const b = document.createElement("button");
    b.dataset.id = r.id;
    b.innerHTML = `<img loading="lazy" alt="" src="${esc(publicUrl(r.thumb_path))}">`;
    b.onclick = () => openLb(photos.findIndex((p) => p.id === r.id));
    $("grid").prepend(b);
    if (!lastSeen || r.created_at > lastSeen) lastSeen = r.created_at;
  }
  $("empty").hidden = photos.length > 0;
  $("count").textContent = photos.length ? `みんなの写真 ${photos.length}枚` : "";
}

// ---------- 拡大表示 ----------
function openLb(i) {
  if (i < 0 || i >= photos.length) return;
  lbIndex = i;
  const p = photos[i];
  $("lbImg").src = publicUrl(p.path);
  $("lbCap").textContent = p.guest_name ? `撮影：${p.guest_name} さん` : "";
  $("lbSave").href = publicUrl(p.path);
  $("lbHide").hidden = !ADMIN_CODE;
  $("lb").classList.add("show");
}
const closeLb = () => { $("lb").classList.remove("show"); $("lbImg").removeAttribute("src"); };
$("lbClose").onclick = closeLb;
$("lbPrev").onclick = () => openLb(lbIndex - 1);
$("lbNext").onclick = () => openLb(lbIndex + 1);
$("lb").addEventListener("click", (e) => { if (e.target === $("lb")) closeLb(); });
$("lbHide").onclick = async () => {
  const p = photos[lbIndex];
  if (!p || !confirm("この写真をみんなの画面から非表示にしますか？")) return;
  try {
    await rpc("hide_photo", { p_admin_code: ADMIN_CODE, p_id: p.id });
    photos.splice(lbIndex, 1);
    document.querySelector(`#grid button[data-id="${p.id}"]`)?.remove();
    $("count").textContent = `みんなの写真 ${photos.length}枚`;
    closeLb();
  } catch { alert("非表示にできませんでした"); }
};

// ---------- アップロード ----------
const queue = [];
let total = 0, done = 0, failed = 0, running = false, sending = false, skipped = 0;

function enqueue(files) {
  const imgs = files.filter((f) => f.type.startsWith("image/") || /\.(heic|heif)$/i.test(f.name));
  if (!imgs.length) return;
  if (!running) { total = 0; done = 0; failed = 0; skipped = 0; }
  const room = remaining();
  const take = imgs.slice(0, room);
  skipped += imgs.length - take.length;
  queue.push(...take);
  total += take.length;
  showQuota();
  showStatus();
  if (!take.length) return;
  if (!running) work();
}

async function work() {
  running = true;
  while (queue.length) {
    const file = queue.shift();
    sending = true;
    try {
      const row = await withRetry(() => sendOne(file));
      used++;
      addPhotos([row]);
    } catch (e) {
      console.error(e);
      failed++;
      if (String(e.message).includes("limit reached")) { failed += queue.length; done += queue.length; queue.length = 0; await loadQuota(); }
    }
    sending = false;
    done++;
    showQuota();
    showStatus();
  }
  running = false;
  showStatus();
}

async function withRetry(fn, tries = 3) {
  for (let i = 0; ; i++) {
    try { return await fn(); }
    catch (e) { if (i >= tries - 1 || String(e.message).includes("limit reached")) throw e; await new Promise((r) => setTimeout(r, 1500 * (i + 1))); }
  }
}

async function sendOne(file) {
  const src = await loadImage(file);
  const full = await toJpeg(src, 2048, 0.85);
  const thumb = await toJpeg(src, 480, 0.75);
  src.close?.();
  const id = crypto.randomUUID();
  const path = `${EVENT_CODE}/${id}.jpg`;
  const thumbPath = `${EVENT_CODE}/${id}_t.jpg`;
  await uploadObject(path, full);
  await uploadObject(thumbPath, thumb);
  const rows = await rpc("add_photo", {
    p_code: EVENT_CODE, p_path: path, p_thumb_path: thumbPath, p_device: deviceId(), p_guest_name: $("name").value.trim() || null,
  });
  return rows[0];
}

// 端末の写真を読み込む（向きの情報も反映する）
async function loadImage(file) {
  try { return await createImageBitmap(file, { imageOrientation: "from-image" }); }
  catch {
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      return img;
    } finally { setTimeout(() => URL.revokeObjectURL(url), 10000); }
  }
}

// 長辺を max に縮めて JPEG にする（通信量と保存容量の節約）
function toJpeg(src, max, quality) {
  const w = src.width || src.naturalWidth, h = src.height || src.naturalHeight;
  const s = Math.min(1, max / Math.max(w, h));
  const c = document.createElement("canvas");
  c.width = Math.round(w * s); c.height = Math.round(h * s);
  c.getContext("2d").drawImage(src, 0, 0, c.width, c.height);
  return new Promise((ok, ng) => c.toBlob((b) => (b ? ok(b) : ng(new Error("変換に失敗"))), "image/jpeg", quality));
}

function showStatus() {
  const el = $("status");
  el.classList.add("show");
  el.classList.toggle("error", !running && failed > 0);
  $("bar").style.width = total ? `${(done / total) * 100}%` : "0";
  const over = skipped ? `のこり枚数を超えた${skipped}枚は送信していません。` : "";
  if (!total && skipped) {
    el.classList.add("error");
    $("statusText").textContent = "フィルムを使い切りました。たくさんの写真をありがとうございます！";
  } else if (running) {
    $("statusText").textContent = `アップロード中… ${Math.min(done + 1, total)} / ${total}枚（画面を閉じないでください）`;
  } else if (failed) {
    $("statusText").textContent = `${total - failed}枚を保存しました。${failed}枚は失敗しました。電波の良い場所でもう一度お試しください。${over}`;
  } else {
    $("statusText").textContent = `${total}枚を保存しました。ありがとうございます！${over}`;
    if (!skipped) setTimeout(() => { if (!running) el.classList.remove("show"); }, 5000);
  }
}

window.addEventListener("beforeunload", (e) => { if (running) e.preventDefault(); });
