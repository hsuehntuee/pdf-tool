'use strict';
/* PDF Tool front-end — vanilla JS, no build step. */

const $ = (s, el = document) => el.querySelector(s);
const h = (tag, attrs = {}, ...kids) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'html') el.innerHTML = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids.flat()) if (k != null && k !== false) el.append(k.nodeType ? k : document.createTextNode(k));
  return el;
};
const fmtSize = (n) => n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(2)} MB`;
const uid = () => Math.random().toString(36).slice(2, 10);

/* ───────────── tool catalogue ───────────── */

const CATS = { org: ['整理', 'var(--c-org)'], opt: ['最佳化', 'var(--c-opt)'], conv: ['轉換', 'var(--c-conv)'],
  edit: ['編輯', 'var(--c-edit)'], sec: ['安全', 'var(--c-sec)'] };
const POS = 'pos';
const PAGES = { k: 'pages', label: '套用頁面', type: 'text', def: '', ph: '全部（例：1-3, 5, 8-, odd, even）' };
const PAPERS = [['A4', 'A4'], ['A3', 'A3'], ['A5', 'A5'], ['B5', 'B5'], ['Letter', 'Letter'], ['Legal', 'Legal']];

const TOOLS = [
  { id: 'merge', cat: 'org', ic: '🧩', name: '合併 PDF', desc: '多個 PDF 依順序合併，可指定每份的頁碼範圍', accept: 'pdf', multi: true, perFileRange: true,
    opts: [{ k: 'bookmarks', label: '每份檔案建立書籤', type: 'check', def: true }] },
  { id: 'organize', cat: 'org', ic: '🗂️', name: '整理頁面', desc: '縮圖拖曳排序、旋轉、刪除、插入空白頁，可混合多份 PDF', accept: 'pdf', multi: true, organizer: true, opts: [] },
  { id: 'split', cat: 'org', ic: '✂️', name: '分割 PDF', desc: '依範圍、每 N 頁、逐頁分割，或擷取指定頁', accept: 'pdf',
    opts: [{ k: 'mode', label: '分割方式', type: 'seg', def: 'ranges', options: [['ranges', '自訂範圍'], ['every', '每 N 頁'], ['each', '逐頁'], ['extract', '擷取成一份']] },
      { k: 'value', label: '範圍', type: 'text', def: '', ph: '例：1-3; 4-8; 9-', show: (o) => o.mode === 'ranges', hint: '用分號或逗號分隔，每組輸出一個檔案' },
      { k: 'value', label: '每份頁數', type: 'number', def: 2, min: 1, show: (o) => o.mode === 'every' },
      { k: 'value', label: '要擷取的頁', type: 'text', def: '', ph: '例：1, 3-5, last', show: (o) => o.mode === 'extract', hint: '依你寫的順序輸出，可重複' }] },
  { id: 'rotate', cat: 'org', ic: '🔄', name: '旋轉頁面', desc: '旋轉全部或指定頁面', accept: 'pdf',
    opts: [{ k: 'angle', label: '角度', type: 'seg', def: 90, options: [[90, '↻ 90°'], [180, '180°'], [270, '↺ 90°']] }, PAGES] },
  { id: 'delete', cat: 'org', ic: '🗑️', name: '刪除頁面', desc: '移除不要的頁', accept: 'pdf',
    opts: [{ ...PAGES, label: '要刪除的頁', ph: '例：2, 5-7' }] },
  { id: 'nup', cat: 'org', ic: '🔲', name: '多頁合一', desc: '2/4/6/8/9/16 頁排在同一張（講義、省紙列印）', accept: 'pdf',
    opts: [{ k: 'per_sheet', label: '每張頁數', type: 'seg', def: 2, options: [[2, '2'], [4, '4'], [6, '6'], [8, '8'], [9, '9'], [16, '16']] },
      { k: 'paper', label: '紙張', type: 'select', def: 'A4', options: PAPERS },
      { k: 'orientation', label: '方向', type: 'seg', def: 'auto', options: [['auto', '自動'], ['portrait', '直式'], ['landscape', '橫式']] },
      { k: 'margin', label: '外邊距 (mm)', type: 'range', def: 5, min: 0, max: 30, step: 1 },
      { k: 'gap', label: '間距 (mm)', type: 'range', def: 3, min: 0, max: 20, step: 1 },
      { k: 'border', label: '每頁加外框', type: 'check', def: false }] },
  { id: 'crop', cat: 'org', ic: '📐', name: '裁切邊界', desc: '裁掉四周白邊（單位 mm）', accept: 'pdf',
    opts: [{ k: 'top', label: '上', type: 'number', def: 10, min: 0, step: 0.5 }, { k: 'bottom', label: '下', type: 'number', def: 10, min: 0, step: 0.5 },
      { k: 'left', label: '左', type: 'number', def: 10, min: 0, step: 0.5 }, { k: 'right', label: '右', type: 'number', def: 10, min: 0, step: 0.5 }, PAGES] },

  { id: 'compress', cat: 'opt', ic: '🗜️', name: '壓縮 PDF', desc: '無損 / 推薦 / 極致三段，可調 DPI 與畫質', accept: 'pdf',
    opts: [{ k: 'level', label: '壓縮等級', type: 'seg', def: 'recommended', options: [['lossless', '無損'], ['recommended', '推薦'], ['extreme', '極致']] },
      { k: '_info', type: 'note', text: (o) => ({ lossless: '清理重複物件、重新壓縮串流與字型子集化，品質完全不變。',
        recommended: '另外把超過目標 DPI 的圖片降採樣並重新壓成 JPEG，文字仍可選取。',
        extreme: '每頁轉成圖片再組回 PDF，體積最小，但文字無法選取或搜尋。' })[o.level] },
      { k: 'dpi', label: '目標解析度', type: 'range', def: 150, min: 50, max: 300, step: 10, unit: ' DPI', show: (o) => o.level !== 'lossless' },
      { k: 'quality', label: 'JPEG 品質', type: 'range', def: 70, min: 10, max: 95, step: 5, show: (o) => o.level !== 'lossless' },
      { k: 'grayscale', label: '轉成灰階（更小）', type: 'check', def: false }] },
  { id: 'grayscale', cat: 'opt', ic: '⚫', name: '轉灰階', desc: '整份轉黑白（點陣化），列印省墨', accept: 'pdf',
    opts: [{ k: 'dpi', label: '解析度', type: 'range', def: 150, min: 72, max: 300, step: 10, unit: ' DPI' }] },
  { id: 'flatten', cat: 'opt', ic: '🧱', name: '扁平化', desc: '把表單欄位、註解燒進頁面，避免被修改', accept: 'pdf',
    opts: [{ k: 'widgets', label: '表單欄位', type: 'check', def: true }, { k: 'annots', label: '註解 / 標記', type: 'check', def: true }] },
  { id: 'repair', cat: 'opt', ic: '🩹', name: '修復 PDF', desc: '重建損毀或打不開的 PDF 結構', accept: 'pdf', opts: [] },

  { id: 'to_images', cat: 'conv', ic: '🖼️', name: 'PDF 轉圖片', desc: '每頁輸出 PNG / JPG / WebP，自訂 DPI', accept: 'pdf',
    opts: [{ k: 'format', label: '格式', type: 'seg', def: 'png', options: [['png', 'PNG'], ['jpg', 'JPG'], ['webp', 'WebP']] },
      { k: 'dpi', label: '解析度', type: 'range', def: 150, min: 50, max: 600, step: 10, unit: ' DPI' },
      { k: 'quality', label: '品質', type: 'range', def: 90, min: 30, max: 100, step: 5, show: (o) => o.format !== 'png' },
      { ...PAGES, label: '頁面' }] },
  { id: 'from_images', cat: 'conv', ic: '📷', name: '圖片轉 PDF', desc: 'JPG/PNG/WebP 合成 PDF，A4 置中、邊距、方向自動', accept: 'image', multi: true,
    opts: [{ k: 'paper', label: '頁面尺寸', type: 'select', def: 'A4', options: [['original', '跟圖片一樣大'], ...PAPERS] },
      { k: 'orientation', label: '方向', type: 'seg', def: 'auto', options: [['auto', '自動'], ['portrait', '直式'], ['landscape', '橫式']], show: (o) => o.paper !== 'original' },
      { k: 'fit', label: '擺放方式', type: 'seg', def: 'fit', options: [['fit', '等比置中'], ['fill', '填滿裁切'], ['stretch', '拉伸']], show: (o) => o.paper !== 'original' },
      { k: 'margin', label: '邊距 (mm)', type: 'range', def: 0, min: 0, max: 40, step: 1, show: (o) => o.paper !== 'original' },
      { k: 'quality', label: '重新壓縮 JPEG 品質（0 = 不壓）', type: 'range', def: 0, min: 0, max: 95, step: 5, hint: '手機照片很大時可設 75 左右' }] },
  { id: 'extract_images', cat: 'conv', ic: '🧲', name: '擷取內嵌圖片', desc: '把 PDF 裡的原始圖片無損抽出來', accept: 'pdf',
    opts: [{ k: 'min_px', label: '忽略小於此尺寸 (px)', type: 'number', def: 32, min: 0 }] },
  { id: 'text', cat: 'conv', ic: '📝', name: 'PDF 轉文字', desc: '擷取文字為 .txt，可直接複製', accept: 'pdf',
    opts: [{ ...PAGES, label: '頁面' }, { k: 'layout', label: '依區塊排版（段落較完整）', type: 'check', def: false }] },
  { id: 'html', cat: 'conv', ic: '🌐', name: 'HTML 轉 PDF', desc: '貼上 HTML 或上傳 .html 產生 PDF', accept: 'html', optionalFiles: true,
    opts: [{ k: 'html', label: 'HTML 內容（有上傳檔案時以檔案為主）', type: 'textarea', def: '<h1>標題</h1>\n<p>在這裡貼上 HTML。支援<b>粗體</b>、<i>斜體</i>、表格、清單。</p>' },
      { k: 'paper', label: '紙張', type: 'select', def: 'A4', options: PAPERS },
      { k: 'margin', label: '邊距 (mm)', type: 'range', def: 15, min: 0, max: 40, step: 1 }] },

  { id: 'watermark', cat: 'edit', ic: '💧', name: '浮水印', desc: '文字或圖片浮水印：透明度、角度、位置、平鋪', accept: 'pdf',
    opts: [{ k: 'kind', label: '類型', type: 'seg', def: 'text', options: [['text', '文字'], ['image', '圖片']] },
      { k: 'text', label: '文字', type: 'text', def: '機密 CONFIDENTIAL', show: (o) => o.kind === 'text' },
      { k: 'extra', label: '浮水印圖片', type: 'file', accept: 'image/*', show: (o) => o.kind === 'image' },
      { k: 'size', label: '字級', type: 'range', def: 48, min: 8, max: 160, step: 2, show: (o) => o.kind === 'text' },
      { k: 'scale', label: '圖片寬度（頁寬比例）', type: 'range', def: 0.4, min: 0.05, max: 1, step: 0.05, show: (o) => o.kind === 'image' },
      { k: 'color', label: '顏色', type: 'color', def: '#e5322d', show: (o) => o.kind === 'text' },
      { k: 'opacity', label: '不透明度', type: 'range', def: 0.25, min: 0.05, max: 1, step: 0.05 },
      { k: 'angle', label: '角度', type: 'range', def: 45, min: -90, max: 90, step: 5, unit: '°', show: (o) => o.kind === 'text' },
      { k: 'tiled', label: '平鋪整頁', type: 'check', def: false, show: (o) => o.kind === 'text' },
      { k: 'position', label: '位置', type: POS, def: 'center', show: (o) => !(o.kind === 'text' && o.tiled) },
      { k: 'behind', label: '放在內容下層', type: 'check', def: false }, PAGES] },
  { id: 'numbers', cat: 'edit', ic: '🔢', name: '加頁碼', desc: '位置、格式、起始數字、跳過封面', accept: 'pdf',
    opts: [{ k: 'format', label: '格式', type: 'select', def: '{n} / {total}', options: [['{n}', '1'], ['{n} / {total}', '1 / 10'], ['第 {n} 頁', '第 1 頁'], ['第 {n} 頁，共 {total} 頁', '第 1 頁，共 10 頁'], ['Page {n} of {total}', 'Page 1 of 10'], ['- {n} -', '- 1 -']] },
      { k: 'position', label: '位置', type: POS, def: 'bottom-center' },
      { k: 'start', label: '起始數字', type: 'number', def: 1, min: 0 },
      { k: 'size', label: '字級', type: 'range', def: 11, min: 6, max: 36, step: 1 },
      { k: 'color', label: '顏色', type: 'color', def: '#000000' },
      { k: 'margin', label: '離邊距離 (mm)', type: 'range', def: 10, min: 2, max: 40, step: 1 },
      { k: 'skip_first', label: '跳過第一頁（封面）', type: 'check', def: false }, PAGES] },
  { id: 'header', cat: 'edit', ic: '📰', name: '頁首 / 頁尾', desc: '每頁加上文字，支援 {n} {total}', accept: 'pdf',
    opts: [{ k: 'header', label: '頁首', type: 'text', def: '' , ph: '例：內部文件'}, { k: 'footer', label: '頁尾', type: 'text', def: '', ph: '例：{n} / {total}' },
      { k: 'size', label: '字級', type: 'range', def: 9, min: 6, max: 24, step: 1 }, { k: 'color', label: '顏色', type: 'color', def: '#555555' },
      { k: 'margin', label: '離邊距離 (mm)', type: 'range', def: 8, min: 2, max: 30, step: 1 }, PAGES] },
  { id: 'metadata', cat: 'edit', ic: '🏷️', name: '文件資訊', desc: '修改標題、作者、關鍵字，或全部清除', accept: 'pdf', meta: true,
    opts: [{ k: 'strip', label: '清除全部中繼資料（隱私）', type: 'check', def: false },
      ...['title:標題', 'author:作者', 'subject:主旨', 'keywords:關鍵字', 'creator:建立程式', 'producer:產生器'].map((s) => {
        const [k, label] = s.split(':'); return { k: `meta.${k}`, label, type: 'text', def: '', show: (o) => !o.strip };
      })] },

  { id: 'protect', cat: 'sec', ic: '🔐', name: '加密保護', desc: 'AES-256 開啟密碼 + 權限控制（列印、複製、修改…）', accept: 'pdf',
    opts: [{ k: 'user_pw', label: '開啟密碼', type: 'password', def: '', hint: '留空 = 任何人可開，只限制權限' },
      { k: 'owner_pw', label: '權限密碼（擁有者）', type: 'password', def: '', hint: '留空則與開啟密碼相同' },
      { k: 'algorithm', label: '加密演算法', type: 'seg', def: 'aes256', options: [['aes256', 'AES-256'], ['aes128', 'AES-128'], ['rc4', 'RC4（舊相容）']] },
      { k: 'allow', label: '允許的操作', type: 'checks', def: ['print', 'print_hq', 'copy', 'accessibility'],
        options: [['print', '列印'], ['print_hq', '高品質列印'], ['copy', '複製文字'], ['modify', '修改內容'], ['annotate', '註解'], ['form', '填表單'], ['assemble', '重組頁面'], ['accessibility', '無障礙讀取']] }] },
  { id: 'unlock', cat: 'sec', ic: '🔓', name: '解除密碼', desc: '輸入密碼後移除加密與權限限制', accept: 'pdf', alwaysPw: true,
    opts: [{ k: 'password', label: '密碼（每個檔案也可個別填）', type: 'password', def: '', hint: '只有權限鎖（能開但不能列印/複製）的檔案可留空' }] },
];
const byId = Object.fromEntries(TOOLS.map((t) => [t.id, t]));
const CHAIN = ['compress', 'watermark', 'numbers', 'protect', 'organize', 'split', 'to_images', 'merge'];

/* ───────────── state ───────────── */

const S = { tool: null, files: [], opts: {}, extra: null, pages: [], busy: false, results: [], error: '' };
const COLORS = ['#e5322d', '#2563eb', '#16a34a', '#9333ea', '#d97706', '#0891b2', '#db2777', '#4b5563'];
const app = $('#app');

/* ───────────── API ───────────── */

function post(url, form, onProgress) {
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open('POST', url);
    x.responseType = 'blob';
    if (onProgress) x.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    x.onload = async () => {
      if (x.status === 401) { location.href = '/login'; return; }
      if (x.status >= 400) {
        let msg = `HTTP ${x.status}`;
        try { msg = JSON.parse(await x.response.text()).error || msg; } catch {}
        reject(new Error(msg)); return;
      }
      resolve(x);
    };
    x.onerror = () => reject(new Error('連線失敗'));
    x.send(form);
  });
}
async function postJSON(url, form) {
  const x = await post(url, form);
  return JSON.parse(await x.response.text());
}

/* ───────────── files ───────────── */

function kindOf(f) {
  const n = f.name.toLowerCase();
  if (f.type === 'application/pdf' || n.endsWith('.pdf')) return 'pdf';
  if (f.type.startsWith('image/') || /\.(jpe?g|png|webp|bmp|gif|tiff?|heic)$/.test(n)) return 'image';
  if (n.endsWith('.html') || n.endsWith('.htm')) return 'html';
  return 'other';
}

async function addFiles(list) {
  const t = S.tool;
  const fresh = [];
  for (const file of list) {
    const kind = kindOf(file);
    if (kind !== t.accept) { flash(`略過「${file.name}」：這個工具只接受 ${t.accept.toUpperCase()}`); continue; }
    const item = { id: uid(), name: file.name, file, size: file.size, kind, pages: null, locked: false, password: '', range: '', thumb: null,
      color: COLORS[S.files.length % COLORS.length] };
    if (kind === 'image') item.thumb = URL.createObjectURL(file);
    S.files.push(item); fresh.push(item);
  }
  S.results = []; S.error = '';
  render();
  for (const item of fresh) if (item.kind === 'pdf') await inspect(item);
}

async function inspect(item) {
  const fd = new FormData();
  fd.append('files', item.file, item.name);
  if (item.password) fd.append('password', item.password);
  try {
    const [info] = await postJSON('/api/info', fd);
    item.pages = info.pages; item.locked = info.locked; item.encrypted = info.encrypted; item.metadata = info.metadata || {};
    if (S.tool.meta && S.files[0] === item) for (const [k, v] of Object.entries(item.metadata)) if (`meta.${k}` in S.opts) S.opts[`meta.${k}`] = v;
    if (!item.locked) await loadThumbs(item);
  } catch (e) { item.err = e.message; }
  render();
}

async function loadThumbs(item) {
  const fd = new FormData();
  fd.append('files', item.file, item.name);
  if (item.password) fd.append('password', item.password);
  fd.append('width', S.tool.organizer ? '220' : '90');
  if (!S.tool.organizer) fd.append('limit', '1');
  const { thumbs } = await postJSON('/api/thumbs', fd);
  item.thumb = thumbs[0];
  if (S.tool.organizer) {
    item.thumbs = thumbs;
    thumbs.forEach((_, p) => S.pages.push({ key: uid(), fid: item.id, p, r: 0, sel: false }));
  }
}

function removeFile(id) {
  S.files = S.files.filter((f) => f.id !== id);
  S.pages = S.pages.filter((p) => p.fid !== id);
  S.results = [];
  render();
}

/* ───────────── run ───────────── */

function collectOpts(file) {
  const o = {};
  const t = S.tool;
  for (const def of t.opts) {
    if (def.type === 'note' || def.type === 'file') continue;
    if (def.show && !def.show(S.opts)) continue;
    const v = S.opts[def.k];
    if (def.k.includes('.')) { const [a, b] = def.k.split('.'); (o[a] ||= {})[b] = v; } else o[def.k] = v;
  }
  if (file) { if (file.password) o.password = file.password; }
  if (t.multi) o.passwords = S.files.map((f) => f.password || '');
  if (t.perFileRange) o.ranges = S.files.map((f) => f.range || '');
  if (t.organizer) {
    const idx = Object.fromEntries(S.files.map((f, i) => [f.id, i]));
    o.pages = S.pages.map((p) => (p.blank ? { blank: true } : { f: idx[p.fid], p: p.p, r: p.r }));
  }
  return o;
}

async function runTool() {
  const t = S.tool;
  if (!S.files.length && !t.optionalFiles) return flash('請先加入檔案');
  if (t.id === 'merge' && S.files.length < 2) return flash('合併至少需要兩個檔案');
  if (t.id === 'watermark' && S.opts.kind === 'image' && !S.extra) return flash('請選擇浮水印圖片');
  S.busy = true; S.error = ''; S.results = []; S.progress = 0;
  render();
  const groups = t.multi || !S.files.length ? [S.files] : S.files.map((f) => [f]);
  try {
    for (const [i, group] of groups.entries()) {
      const fd = new FormData();
      group.forEach((f) => fd.append('files', f.file, f.name));
      if (S.extra) fd.append('extra', S.extra, S.extra.name);
      fd.append('options', JSON.stringify(collectOpts(group.length === 1 ? group[0] : null)));
      S.batch = groups.length > 1 ? `${i + 1} / ${groups.length}` : '';
      const x = await post(`/api/run/${t.id}`, fd, (p) => { S.progress = p; paintProgress(); });
      const name = decodeURIComponent(x.getResponseHeader('X-Filename') || 'output.pdf');
      const blob = x.response;
      const r = { name, blob, url: URL.createObjectURL(blob), inSize: +x.getResponseHeader('X-Input-Size'), outSize: blob.size,
        type: blob.type, text: blob.type.startsWith('text/') ? await blob.text() : null };
      S.results.push(r);
      if (groups.length === 1) download(r);
    }
  } catch (e) { S.error = e.message; }
  S.busy = false;
  render();
}

function download(r) {
  const a = h('a', { href: r.url, download: r.name });
  document.body.append(a); a.click(); a.remove();
}

let pendingFiles = null; // handed to the next tool once route() has reset state
function chainTo(toolId, r) {
  pendingFiles = [new File([r.blob], r.name, { type: 'application/pdf' })];
  go(toolId);
}

/* ───────────── drag-to-reorder (mouse + touch) ───────────── */

// One global drag at a time; window listeners are registered once, containers just opt in.
let drag = null;
function sortable(container, itemSel, onDone) {
  container.addEventListener('pointerdown', (e) => {
    const handle = e.target.closest('.handle');
    const item = e.target.closest(itemSel);
    if (!item || (!handle && (e.pointerType !== 'mouse' || e.target.closest('button,input,select')))) return;
    drag = { container, itemSel, onDone, item, x: e.clientX, y: e.clientY, started: false, id: e.pointerId };
  });
}
window.addEventListener('pointermove', (e) => {
  if (!drag || e.pointerId !== drag.id) return;
  if (!drag.started) {
    if (Math.hypot(e.clientX - drag.x, e.clientY - drag.y) < 6) return;
    drag.started = true; drag.item.classList.add('dragging');
  }
  e.preventDefault();
  const over = document.elementFromPoint(e.clientX, e.clientY)?.closest(drag.itemSel);
  if (!over || over === drag.item || over.parentNode !== drag.container) return;
  const r = over.getBoundingClientRect();
  const grid = getComputedStyle(drag.container).display === 'grid';
  const after = grid ? e.clientX > r.left + r.width / 2 : e.clientY > r.top + r.height / 2;
  drag.container.insertBefore(drag.item, after ? over.nextSibling : over);
}, { passive: false });
function endDrag() {
  if (!drag) return;
  const d = drag;
  drag = null;
  d.item.classList.remove('dragging');
  if (d.started) {
    // Swallow the click that follows a drag so it doesn't toggle page selection.
    const eat = (e) => e.stopPropagation();
    window.addEventListener('click', eat, { capture: true, once: true });
    setTimeout(() => window.removeEventListener('click', eat, { capture: true }), 50);
    d.onDone([...d.container.querySelectorAll(d.itemSel)].map((el) => el.dataset.key));
  }
}
window.addEventListener('pointerup', endDrag);
window.addEventListener('pointercancel', endDrag);

/* ───────────── views ───────────── */

function go(id) { location.hash = id ? `#/${id}` : '#/'; }

function route() {
  const id = location.hash.replace(/^#\/?/, '');
  const t = byId[id];
  S.tool = t || null; S.files = []; S.pages = []; S.results = []; S.error = ''; S.extra = null;
  S.opts = {};
  if (t) for (const d of t.opts) if ('def' in d) S.opts[d.k] = Array.isArray(d.def) ? [...d.def] : d.def;
  render();
  window.scrollTo(0, 0);
  if (t && pendingFiles) { const f = pendingFiles; pendingFiles = null; addFiles(f); }
}

let homeCat = 'all', homeQuery = '';
function renderHome() {
  const q = homeQuery.trim().toLowerCase();
  const list = TOOLS.filter((t) => (homeCat === 'all' || t.cat === homeCat) &&
    (!q || (t.name + t.desc + t.id).toLowerCase().includes(q)));
  const search = h('input', { class: 'search', type: 'search', placeholder: '搜尋工具…（合併、壓縮、浮水印…）', value: homeQuery,
    oninput: (e) => { homeQuery = e.target.value; const pos = e.target.selectionStart; render(); const s = $('.search'); s.focus(); s.setSelectionRange(pos, pos); } });
  return h('div', {},
    h('section', { class: 'hero' }, h('h1', {}, '你的私人 PDF 工具箱'),
      h('p', {}, `${TOOLS.length} 種工具 · 全部在你自己的機器上處理 · 不上傳第三方、不寫入硬碟`), search),
    h('div', { class: 'cats' }, [['all', '全部'], ...Object.entries(CATS).map(([k, [n]]) => [k, n])].map(([k, n]) =>
      h('button', { class: `cat ${homeCat === k ? 'on' : ''}`, onclick: () => { homeCat = k; render(); } }, n))),
    h('div', { class: 'grid' }, list.map((t) =>
      h('button', { class: 'card', style: `--hue:${CATS[t.cat][1]}`, onclick: () => go(t.id) },
        h('div', { class: 'ic' }, t.ic), h('h3', {}, t.name), h('p', {}, t.desc)))),
    h('p', { class: 'foot' }, '小技巧：處理完可以直接把結果「接著」丟進下一個工具，不必重新上傳。'));
}

function optField(d) {
  const o = S.opts;
  const set = (v) => { o[d.k] = v; S.results = []; render(); };
  const lbl = (extra) => h('label', {}, d.label, extra);
  switch (d.type) {
    case 'note': return h('div', { class: 'opt' }, h('div', { class: 'hint' }, d.text(o)));
    case 'seg': return h('div', { class: 'opt' }, h('span', { class: 'lbl' }, d.label),
      h('div', { class: 'seg' }, d.options.map(([v, n]) => h('button', { class: o[d.k] === v ? 'on' : '', onclick: () => set(v) }, n))));
    case 'select': return h('div', { class: 'opt' }, lbl(),
      h('select', { onchange: (e) => set(e.target.value) }, d.options.map(([v, n]) => h('option', { value: v, selected: o[d.k] === v }, n))));
    case 'check': return h('div', { class: 'opt' }, h('label', { class: 'check' },
      h('input', { type: 'checkbox', checked: !!o[d.k], onchange: (e) => set(e.target.checked) }), d.label));
    case 'checks': return h('div', { class: 'opt' }, h('span', { class: 'lbl' }, d.label), h('div', { class: 'checks' },
      d.options.map(([v, n]) => h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: o[d.k].includes(v),
        onchange: (e) => set(e.target.checked ? [...o[d.k], v] : o[d.k].filter((x) => x !== v)) }), n))));
    case 'range': {
      const val = h('span', { class: 'range-val' }, `${o[d.k]}${d.unit || ''}`);
      return h('div', { class: 'opt' }, lbl(val), h('input', { type: 'range', min: d.min, max: d.max, step: d.step, value: o[d.k],
        oninput: (e) => { o[d.k] = +e.target.value; val.textContent = `${o[d.k]}${d.unit || ''}`; }, onchange: () => { S.results = []; } }),
      d.hint && h('div', { class: 'hint' }, d.hint));
    }
    case 'color': return h('div', { class: 'opt' }, lbl(), h('input', { type: 'color', value: o[d.k], oninput: (e) => { o[d.k] = e.target.value; } }));
    case 'textarea': return h('div', { class: 'opt' }, lbl(), h('textarea', { oninput: (e) => { o[d.k] = e.target.value; } }, o[d.k]));
    case 'file': return h('div', { class: 'opt' }, lbl(), h('input', { type: 'file', accept: d.accept,
      onchange: (e) => { S.extra = e.target.files[0] || null; } }), S.extra && h('div', { class: 'hint' }, `已選：${S.extra.name}`));
    case POS: {
      const cells = ['top-left', 'top-center', 'top-right', 'middle-left', 'center', 'middle-right', 'bottom-left', 'bottom-center', 'bottom-right'];
      return h('div', { class: 'opt' }, h('span', { class: 'lbl' }, d.label),
        h('div', { class: 'pos' }, cells.map((c) => h('button', { class: o[d.k] === c ? 'on' : '', title: c, onclick: () => set(c) }))));
    }
    default: return h('div', { class: 'opt' }, lbl(),
      h('input', { type: d.type, value: o[d.k] ?? '', placeholder: d.ph || '', min: d.min, step: d.step,
        autocomplete: d.type === 'password' ? 'new-password' : 'off',
        oninput: (e) => { o[d.k] = d.type === 'number' ? +e.target.value : e.target.value; } }),
      d.hint && h('div', { class: 'hint' }, d.hint));
  }
}

function fileRow(f) {
  const t = S.tool;
  const sub = [fmtSize(f.size), f.pages != null && !f.locked ? `${f.pages} 頁` : null, f.encrypted && !f.locked ? '已加密' : null].filter(Boolean).join(' · ');
  const needPw = f.locked || (t.alwaysPw && f.encrypted);
  return h('div', { class: 'file', 'data-key': f.id },
    (t.multi) && h('span', { class: 'handle', title: '拖曳排序' }, '⠿'),
    f.thumb ? h('img', { class: 'th', src: f.thumb, alt: '' }) : h('div', { class: 'th', style: 'width:40px;height:52px;background:var(--surface-2);border-radius:6px' }),
    h('div', { class: 'meta' }, h('div', { class: 'name', title: f.name }, f.name), h('div', { class: 'sub' }, sub),
      f.locked && h('div', { class: 'lock' }, '🔒 需要密碼才能開啟'), f.err && h('div', { class: 'lock' }, f.err)),
    needPw && h('input', { class: 'mini', type: 'password', placeholder: '密碼', value: f.password, autocomplete: 'off',
      oninput: (e) => { f.password = e.target.value; },
      onkeydown: (e) => { if (e.key === 'Enter' && f.locked) { f.err = ''; inspect(f); } },
      onchange: () => { if (f.locked) { f.err = ''; inspect(f); } } }),
    t.perFileRange && !f.locked && h('input', { class: 'mini', type: 'text', placeholder: '頁碼（全部）', value: f.range,
      oninput: (e) => { f.range = e.target.value; } }),
    h('button', { class: 'x', title: '移除', onclick: () => removeFile(f.id) }, '✕'));
}

function organizer() {
  const fileById = Object.fromEntries(S.files.map((f) => [f.id, f]));
  const selected = S.pages.filter((p) => p.sel);
  const act = (fn) => () => { fn(); S.results = []; render(); };
  const targets = () => (selected.length ? selected : S.pages);
  const bar = h('div', { class: 'pg-tools' },
    h('button', { class: 'btn ghost sm', onclick: act(() => targets().forEach((p) => { p.r = (p.r + 270) % 360; })) }, '↺ 左轉'),
    h('button', { class: 'btn ghost sm', onclick: act(() => targets().forEach((p) => { p.r = (p.r + 90) % 360; })) }, '↻ 右轉'),
    h('button', { class: 'btn ghost sm', onclick: act(() => { S.pages = S.pages.filter((p) => !p.sel); }), disabled: !selected.length }, '🗑 刪除選取'),
    h('button', { class: 'btn ghost sm', onclick: act(() => { S.pages.reverse(); }) }, '⇅ 反轉順序'),
    h('button', { class: 'btn ghost sm', onclick: act(() => { const all = S.pages.every((p) => p.sel); S.pages.forEach((p) => { p.sel = !all; }); }) }, '☑ 全選'),
    h('button', { class: 'btn ghost sm', onclick: act(() => { S.pages.push({ key: uid(), blank: true, r: 0 }); }) }, '＋ 空白頁'),
    h('span', { class: 'hint', style: 'align-self:center;color:var(--muted);font-size:12px' }, `${S.pages.length} 頁${selected.length ? ` · 已選 ${selected.length}` : ''} · 拖曳排序，點一下選取`));
  const grid = h('div', { class: 'pages' }, S.pages.map((p, i) => {
    const f = fileById[p.fid];
    return h('div', { class: `pg ${p.sel ? 'sel' : ''}`, 'data-key': p.key,
      onclick: (e) => { if (e.target.closest('button,.handle')) return; p.sel = !p.sel; render(); } },
      h('span', { class: 'handle' }, '⠿'),
      h('div', { class: 'acts' },
        h('button', { title: '右轉', onclick: act(() => { p.r = (p.r + 90) % 360; }) }, '↻'),
        h('button', { title: '複製此頁', onclick: act(() => { S.pages.splice(i + 1, 0, { ...p, key: uid(), sel: false }); }) }, '⧉'),
        h('button', { title: '刪除', onclick: act(() => { S.pages.splice(i, 1); }) }, '✕')),
      h('div', { class: 'imgwrap' }, p.blank ? h('div', { class: 'blank', style: `transform:rotate(${p.r}deg)` })
        : h('img', { src: f.thumbs[p.p], style: `transform:rotate(${p.r}deg)`, draggable: 'false' })),
      h('div', { class: 'lbl' }, !p.blank && h('span', { class: 'dot', style: `background:${f.color}` }),
        `${i + 1}`, h('span', { style: 'opacity:.6' }, p.blank ? '（空白）' : `· ${f.name.slice(0, 12)} p${p.p + 1}`)));
  }));
  sortable(grid, '.pg', (keys) => { const m = Object.fromEntries(S.pages.map((p) => [p.key, p])); S.pages = keys.map((k) => m[k]); S.results = []; render(); });
  return h('div', { class: 'panel', style: 'margin-top:12px' }, bar, grid);
}

function resultView() {
  if (S.busy) {
    return h('div', { class: 'result' }, h('div', { class: 'row' }, h('span', { class: 'spinner' }),
      h('span', { id: 'prog' }, progressText())));
  }
  if (S.error) return h('div', { class: 'err' }, '⚠ ', S.error);
  if (!S.results.length) return null;
  const single = S.results.length === 1 ? S.results[0] : null;
  const inTotal = S.results.reduce((a, r) => a + (r.inSize || 0), 0), outTotal = S.results.reduce((a, r) => a + r.outSize, 0);
  const pct = inTotal ? Math.round((1 - outTotal / inTotal) * 100) : 0;
  const showSaving = ['compress', 'grayscale', 'flatten', 'repair'].includes(S.tool.id);
  return h('div', { class: 'result' },
    h('div', { class: 'ok' }, '✓ 完成'),
    h('div', { class: 'stat' }, showSaving && inTotal
      ? `${fmtSize(inTotal)} → ${fmtSize(outTotal)}（${pct >= 0 ? `省下 ${pct}%` : `增加 ${-pct}%`}）`
      : `${S.results.length > 1 ? `${S.results.length} 個檔案 · ` : ''}${fmtSize(outTotal)}`),
    h('div', { class: 'row' }, S.results.length > 1
      ? [h('button', { class: 'btn', onclick: () => S.results.forEach(download) }, '⬇ 全部下載'),
        ...S.results.map((r) => h('button', { class: 'btn ghost sm', onclick: () => download(r) }, r.name))]
      : h('button', { class: 'btn', onclick: () => download(single) }, `⬇ 下載 ${single.name}`)),
    single?.text != null && [h('div', { class: 'row', style: 'margin-top:10px' },
      h('button', { class: 'btn ghost sm', onclick: () => navigator.clipboard.writeText(single.text).then(() => flash('已複製')) }, '複製文字')),
      h('pre', {}, single.text.slice(0, 200000))],
    single && single.type === 'application/pdf' && h('div', { class: 'chain' }, h('span', { style: 'color:var(--muted);font-size:13px;align-self:center' }, '接著用：'),
      CHAIN.filter((id) => id !== S.tool.id).map((id) => h('button', { onclick: () => chainTo(id, single) }, `${byId[id].ic} ${byId[id].name}`))));
}
const progressText = () => `${S.progress < 1 ? `上傳中 ${Math.round((S.progress || 0) * 100)}%` : '處理中…'}${S.batch ? `（${S.batch}）` : ''}`;
function paintProgress() { const el = $('#prog'); if (el) el.textContent = progressText(); }

function renderTool() {
  const t = S.tool;
  const accept = { pdf: '.pdf,application/pdf', image: 'image/*', html: '.html,.htm' }[t.accept];
  const picker = $('#picker');
  const pick = () => { picker.accept = accept; picker.multiple = true; picker.value = ''; picker.click(); };
  picker.onchange = () => addFiles([...picker.files]);
  const drop = h('div', { class: 'drop', onclick: pick },
    h('div', { class: 'big' }, S.files.length ? '＋ 加入更多檔案' : `選擇${{ pdf: ' PDF', image: '圖片', html: ' HTML' }[t.accept]}檔案`),
    h('div', { class: 'sub' }, `或拖放到這裡${t.multi ? '' : '（可一次多個，逐一批次處理）'}`));
  ['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
  drop.addEventListener('drop', (e) => addFiles([...e.dataTransfer.files]));

  const list = h('div', { class: 'files' }, S.files.map(fileRow));
  if (t.multi) sortable(list, '.file', (keys) => { const m = Object.fromEntries(S.files.map((f) => [f.id, f])); S.files = keys.map((k) => m[k]); S.results = []; render(); });

  const fields = t.opts.filter((d) => !d.show || d.show(S.opts)).map(optField);
  const canRun = !S.busy && (S.files.length || t.optionalFiles) && !S.files.some((f) => f.locked && !f.password);
  const runLabel = S.files.length > 1 && !t.multi ? `${t.name}（${S.files.length} 個檔案）` : t.name;
  return h('div', {},
    h('div', { class: 'tool-head' }, h('button', { class: 'back', onclick: () => go('') }, '←'),
      h('div', {}, h('h2', {}, `${t.ic} ${t.name}`), h('p', {}, t.desc))),
    h('div', { class: 'layout' },
      h('div', {}, drop, !t.organizer && list,
        t.organizer && S.files.length > 0 && h('div', { class: 'files' }, S.files.map(fileRow)),
        t.organizer && S.pages.length > 0 && organizer()),
      h('aside', { class: 'side panel' }, fields.length ? fields : h('p', { class: 'hint', style: 'color:var(--muted);margin-top:0' }, '沒有額外選項，直接執行即可。'),
        h('button', { class: 'btn block', onclick: runTool, disabled: !canRun }, S.busy ? '處理中…' : runLabel),
        resultView())));
}

function render() {
  app.replaceChildren(S.tool ? renderTool() : renderHome());
  document.title = S.tool ? `${S.tool.name} · PDF Tool` : 'PDF Tool';
}

let flashTimer;
function flash(msg) {
  let el = $('#flash');
  if (!el) {
    el = h('div', { id: 'flash', style: 'position:fixed;left:50%;bottom:24px;transform:translateX(-50%);background:var(--text);color:var(--bg);padding:10px 16px;border-radius:10px;z-index:99;font-size:14px;max-width:90vw' });
    document.body.append(el);
  }
  el.textContent = msg; el.hidden = false;
  clearTimeout(flashTimer); flashTimer = setTimeout(() => { el.hidden = true; }, 2600);
}

/* ───────────── chrome ───────────── */

$('#home').addEventListener('click', (e) => { e.preventDefault(); go(''); });
$('#logout').addEventListener('click', async () => { await fetch('/api/logout', { method: 'POST' }); location.href = '/login'; });
$('#theme').addEventListener('click', () => {
  const root = document.documentElement;
  const dark = root.dataset.theme ? root.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
  root.dataset.theme = dark ? 'light' : 'dark';
  try { localStorage.setItem('theme', root.dataset.theme); } catch {}
});
try { const th = localStorage.getItem('theme'); if (th) document.documentElement.dataset.theme = th; } catch {}
fetch('/api/me').then((r) => r.json()).then((m) => { if (!m.auth) $('#logout').classList.add('hidden'); }).catch(() => {});
// Dropping a file anywhere on the page shouldn't navigate away.
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => { e.preventDefault(); if (S.tool && !e.target.closest('.drop')) addFiles([...e.dataTransfer.files]); });
window.addEventListener('hashchange', route);
route();
