'use strict';
/* In-browser PDF engine for guest mode: files never leave the visitor's device.
   pdf-lib edits, pdf.js renders, JSZip bundles multi-file results. Loaded on first use. */

const Edge = (() => {
  const CDN = 'https://cdnjs.cloudflare.com/ajax/libs';
  const LIBS = {
    PDFLib: `${CDN}/pdf-lib/1.17.1/pdf-lib.min.js`,
    pdfjsLib: `${CDN}/pdf.js/3.11.174/pdf.min.js`,
    JSZip: `${CDN}/jszip/3.10.1/jszip.min.js`,
  };
  const WORKER = `${CDN}/pdf.js/3.11.174/pdf.worker.min.js`;
  const MM = 72 / 25.4;
  const PAPER = { A3: [297, 420], A4: [210, 297], A5: [148, 210], B5: [176, 250], Letter: [215.9, 279.4], Legal: [215.9, 355.6] };

  const loading = {};
  function load(name) {
    if (window[name]) return Promise.resolve(window[name]);
    return (loading[name] ||= new Promise((ok, fail) => {
      const s = document.createElement('script');
      s.src = LIBS[name];
      s.onload = () => ok(window[name]);
      s.onerror = () => fail(new Error(`無法載入 ${name}（需要網路連線）`));
      document.head.append(s);
    }));
  }
  let workerReady;
  async function pdfjs() {
    const lib = await load('pdfjsLib');
    // A cross-origin worker URL is refused by the browser, so hand pdf.js a same-origin blob copy.
    workerReady ||= fetch(WORKER).then((r) => r.text()).then((code) => {
      lib.GlobalWorkerOptions.workerSrc = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
    });
    await workerReady;
    return lib;
  }

  class EdgeError extends Error {}
  const fail = (msg) => { throw new EdgeError(msg); };
  const stem = (n) => (n || 'file').replace(/\.[^.]+$/, '') || 'file';
  const pdfBlob = (bytes) => new Blob([bytes], { type: 'application/pdf' });

  function parseRanges(spec, total) {
    spec = String(spec ?? '').trim().toLowerCase();
    if (!spec || spec === 'all') return [...Array(total).keys()];
    const out = [];
    for (let part of spec.split(/[,\s;，]+/)) {
      if (!part) continue;
      if (part === 'odd') { for (let i = 0; i < total; i += 2) out.push(i); continue; }
      if (part === 'even') { for (let i = 1; i < total; i += 2) out.push(i); continue; }
      part = part.replace(/last|end/g, String(total));
      let seq;
      const m = part.match(/^(\d*)-(\d*)$/);
      if (m) {
        const a = m[1] ? +m[1] : 1, b = m[2] ? +m[2] : total, step = b >= a ? 1 : -1;
        seq = []; for (let n = a; step > 0 ? n <= b : n >= b; n += step) seq.push(n);
      } else if (/^\d+$/.test(part)) seq = [+part];
      else fail(`看不懂的頁碼範圍：「${part}」`);
      for (const n of seq) { if (n < 1 || n > total) fail(`頁碼 ${n} 超出範圍（共 ${total} 頁）`); out.push(n - 1); }
    }
    if (!out.length) fail('頁碼範圍是空的');
    return out;
  }
  const pageSet = (spec, total) => new Set(parseRanges(spec, total));

  async function open(file) {
    const { PDFDocument } = await load('PDFLib');
    const buf = await file.arrayBuffer();
    let doc;
    try { doc = await PDFDocument.load(buf, { ignoreEncryption: true }); } catch (e) { fail(`無法讀取 PDF：${e.message}`); }
    if (doc.isEncrypted) fail('加密的 PDF 需要登入後由伺服器處理');
    return doc;
  }
  const save = async (doc) => pdfBlob(await doc.save());

  async function zip(items, name) {
    if (items.length === 1) return items[0];
    const JSZip = await load('JSZip');
    const z = new JSZip();
    items.forEach((it) => z.file(it.name, it.blob));
    return { name, blob: await z.generateAsync({ type: 'blob', compression: 'DEFLATE' }) };
  }

  function rgb(hex) {
    const { rgb: mk } = window.PDFLib;
    let c = (hex || '#000000').replace('#', '');
    if (c.length === 3) c = [...c].map((x) => x + x).join('');
    return mk(parseInt(c.slice(0, 2), 16) / 255, parseInt(c.slice(2, 4), 16) / 255, parseInt(c.slice(4, 6), 16) / 255);
  }
  function latinOnly(text) {
    // pdf-lib's standard fonts only cover WinAnsi; CJK needs the server's embedded font.
    if (/[^\x20-\x7E -ÿ]/.test(text)) fail('訪客模式的文字只支援英數字；中文浮水印/頁碼請登入使用伺服器版');
  }
  // Top-left origin box (x, y-from-top) → pdf-lib baseline point for a w×h label at `pos`.
  function anchor(W, H, pos, w, h, m) {
    let [v, hz] = pos === 'center' ? ['middle', 'center'] : pos.split('-');
    const x = { left: m, center: (W - w) / 2, right: W - m - w }[hz] ?? (W - w) / 2;
    const yTop = { top: m + h, middle: (H + h) / 2, bottom: H - m }[v] ?? (H + h) / 2;
    return { x, y: H - yTop };
  }

  /* ───────────── info / thumbnails ───────────── */

  async function info(file) {
    const { PDFDocument } = await load('PDFLib');
    const doc = await PDFDocument.load(await file.arrayBuffer(), { ignoreEncryption: true });
    return { pages: doc.getPageCount(), encrypted: doc.isEncrypted, locked: doc.isEncrypted,
      metadata: { title: doc.getTitle() || '', author: doc.getAuthor() || '', subject: doc.getSubject() || '',
        keywords: doc.getKeywords() || '', creator: doc.getCreator() || '', producer: doc.getProducer() || '' } };
  }

  async function render(file, each, scaleFor, pages) {
    const lib = await pdfjs();
    const pdf = await lib.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
    try {
      for (const n of pages ? pages(pdf.numPages) : [...Array(pdf.numPages).keys()]) {
        const page = await pdf.getPage(n + 1);
        const base = page.getViewport({ scale: 1 });
        const vp = page.getViewport({ scale: scaleFor(base) });
        const canvas = document.createElement('canvas');
        canvas.width = Math.ceil(vp.width); canvas.height = Math.ceil(vp.height);
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
        // 'print' intent renders without requestAnimationFrame, so it keeps going in background tabs.
        await page.render({ canvasContext: ctx, viewport: vp, intent: 'print' }).promise;
        await each(canvas, n);
        page.cleanup();
      }
    } finally { pdf.destroy(); }
  }

  async function thumbs(file, width, limit = 500) {
    const out = [];
    await render(file, (c) => { out.push(c.toDataURL('image/jpeg', 0.7)); }, (vp) => width / vp.width,
      (total) => [...Array(Math.min(total, limit)).keys()]);
    return out;
  }

  const toBlob = (canvas, type, q) => new Promise((ok) => canvas.toBlob(ok, type, q));

  /* ───────────── tools ───────────── */

  const T = {};

  T.merge = async (files, o) => {
    const { PDFDocument } = window.PDFLib;
    const out = await PDFDocument.create();
    for (const [i, f] of files.entries()) {
      const src = await open(f);
      const idx = parseRanges(o.ranges?.[i] || '', src.getPageCount());
      (await out.copyPages(src, idx)).forEach((p) => out.addPage(p));
    }
    return { name: 'merged.pdf', blob: await save(out) };
  };

  T.organize = async (files, o) => {
    const { PDFDocument, degrees } = window.PDFLib;
    const srcs = await Promise.all(files.map(open));
    const out = await PDFDocument.create();
    for (const it of o.pages || []) {
      if (it.blank) { out.addPage([595, 842]); continue; }
      const [p] = await out.copyPages(srcs[it.f], [it.p]);
      if (it.r) p.setRotation(degrees((p.getRotation().angle + it.r) % 360));
      out.addPage(p);
    }
    if (!out.getPageCount()) fail('至少要保留一頁');
    return { name: `${stem(files[0]?.name)}_organized.pdf`, blob: await save(out) };
  };

  async function pick(src, idx) {
    const { PDFDocument } = window.PDFLib;
    const out = await PDFDocument.create();
    (await out.copyPages(src, idx)).forEach((p) => out.addPage(p));
    return save(out);
  }

  T.split = async ([f], o) => {
    const src = await open(f), total = src.getPageCount(), base = stem(f.name);
    if (o.mode === 'extract') return { name: `${base}_extract.pdf`, blob: await pick(src, parseRanges(o.value, total)) };
    let groups;
    if (o.mode === 'each') groups = [...Array(total).keys()].map((n) => [`${base}_p${n + 1}.pdf`, [n]]);
    else if (o.mode === 'every') {
      const k = Math.max(1, parseInt(o.value, 10) || 1);
      groups = [];
      for (let i = 0; i < total; i += k) groups.push([`${base}_${i / k + 1}.pdf`, [...Array(Math.min(k, total - i)).keys()].map((j) => i + j)]);
    } else {
      const specs = String(o.value || '').split(/[;,，]+/).map((s) => s.trim()).filter(Boolean);
      if (!specs.length) fail('請輸入分割範圍，例如 1-3, 4-8, 9-');
      groups = specs.map((s) => [`${base}_${s}.pdf`, parseRanges(s, total)]);
    }
    const items = [];
    for (const [name, idx] of groups) items.push({ name, blob: await pick(src, idx) });
    return zip(items, `${base}_split.zip`);
  };

  T.rotate = async ([f], o) => {
    const { degrees } = window.PDFLib;
    const doc = await open(f);
    const pages = doc.getPages();
    for (const n of pageSet(o.pages, pages.length)) pages[n].setRotation(degrees((pages[n].getRotation().angle + +o.angle) % 360));
    return { name: `${stem(f.name)}_rotated.pdf`, blob: await save(doc) };
  };

  T.delete = async ([f], o) => {
    const doc = await open(f);
    const kill = [...pageSet(o.pages, doc.getPageCount())].sort((a, b) => b - a);
    if (kill.length >= doc.getPageCount()) fail('不能刪除全部頁面');
    kill.forEach((n) => doc.removePage(n));
    return { name: `${stem(f.name)}_trimmed.pdf`, blob: await save(doc) };
  };

  T.nup = async ([f], o) => {
    const { PDFDocument, rgb: mk } = window.PDFLib;
    const per = +o.per_sheet || 2;
    const layouts = { 2: [2, 1], 4: [2, 2], 6: [3, 2], 8: [4, 2], 9: [3, 3], 16: [4, 4] };
    const land = o.orientation === 'auto' ? [2, 6, 8].includes(per) : o.orientation === 'landscape';
    const [big, small] = layouts[per];
    const [cols, rows] = land ? [big, small] : [small, big];
    const [w, h] = PAPER[o.paper] || PAPER.A4;
    const [W, H] = land ? [h * MM, w * MM] : [w * MM, h * MM];
    const src = await open(f), out = await PDFDocument.create();
    const embedded = await out.embedPages(src.getPages());
    const m = (+o.margin || 0) * MM, g = (+o.gap || 0) * MM;
    const cw = (W - 2 * m - (cols - 1) * g) / cols, ch = (H - 2 * m - (rows - 1) * g) / rows;
    let sheet;
    embedded.forEach((ep, i) => {
      const slot = i % per;
      if (!slot) sheet = out.addPage([W, H]);
      const r = Math.floor(slot / cols), c = slot % cols;
      const x0 = m + c * (cw + g), yTop = m + r * (ch + g);
      const s = Math.min(cw / ep.width, ch / ep.height);
      const dw = ep.width * s, dh = ep.height * s;
      sheet.drawPage(ep, { x: x0 + (cw - dw) / 2, y: H - yTop - ch + (ch - dh) / 2, width: dw, height: dh });
      if (o.border) sheet.drawRectangle({ x: x0, y: H - yTop - ch, width: cw, height: ch, borderColor: mk(0.6, 0.6, 0.6), borderWidth: 0.5 });
    });
    return { name: `${stem(f.name)}_${per}up.pdf`, blob: await save(out) };
  };

  T.crop = async ([f], o) => {
    const doc = await open(f);
    const pages = doc.getPages();
    for (const n of pageSet(o.pages, pages.length)) {
      const p = pages[n], b = p.getMediaBox();
      const l = (+o.left || 0) * MM, r = (+o.right || 0) * MM, t = (+o.top || 0) * MM, btm = (+o.bottom || 0) * MM;
      if (b.width - l - r < 10 || b.height - t - btm < 10) fail(`第 ${n + 1} 頁裁切過多`);
      p.setCropBox(b.x + l, b.y + btm, b.width - l - r, b.height - t - btm);
    }
    return { name: `${stem(f.name)}_cropped.pdf`, blob: await save(doc) };
  };

  T.from_images = async (files, o) => {
    const { PDFDocument } = window.PDFLib;
    const out = await PDFDocument.create();
    for (const f of files) {
      // createImageBitmap applies EXIF rotation, so phone photos come out upright.
      let bmp;
      try { bmp = await createImageBitmap(f, { imageOrientation: 'from-image' }); } catch { fail(`無法讀取圖片：${f.name}`); }
      const c = document.createElement('canvas');
      c.width = bmp.width; c.height = bmp.height;
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
      ctx.drawImage(bmp, 0, 0);
      const usePng = !o.quality && /\.png$/i.test(f.name);
      const blob = await toBlob(c, usePng ? 'image/png' : 'image/jpeg', o.quality ? o.quality / 100 : 0.92);
      const bytes = await blob.arrayBuffer();
      const img = usePng ? await out.embedPng(bytes) : await out.embedJpg(bytes);
      const iw = bmp.width, ih = bmp.height;
      let W, H;
      if (o.paper === 'original') { W = iw * 0.75; H = ih * 0.75; } else {
        const [pw, ph] = PAPER[o.paper] || PAPER.A4;
        const land = o.orientation === 'auto' ? iw > ih : o.orientation === 'landscape';
        [W, H] = land ? [ph * MM, pw * MM] : [pw * MM, ph * MM];
      }
      const page = out.addPage([W, H]);
      const m = o.paper === 'original' ? 0 : (+o.margin || 0) * MM;
      const bw = W - 2 * m, bh = H - 2 * m;
      if (o.fit === 'stretch' || o.paper === 'original') page.drawImage(img, { x: m, y: m, width: bw, height: bh });
      else {
        const s = (o.fit === 'fill' ? Math.max : Math.min)(bw / iw, bh / ih);
        const dw = iw * s, dh = ih * s;
        page.drawImage(img, { x: m + (bw - dw) / 2, y: m + (bh - dh) / 2, width: dw, height: dh });
      }
    }
    return { name: files.length === 1 ? `${stem(files[0].name)}.pdf` : 'images.pdf', blob: await save(out) };
  };

  T.to_images = async ([f], o) => {
    const fmt = o.format || 'png', type = fmt === 'jpg' ? 'image/jpeg' : `image/${fmt}`;
    const items = [], base = stem(f.name);
    let pages = null;
    if (o.pages) { const doc = await open(f); pages = () => parseRanges(o.pages, doc.getPageCount()); }
    await render(f, async (c, n) => { items.push({ name: `${base}_p${n + 1}.${fmt}`, blob: await toBlob(c, type, (o.quality || 90) / 100) }); },
      () => (o.dpi || 150) / 72, pages);
    return zip(items, `${base}_images.zip`);
  };

  T.text = async ([f], o) => {
    const lib = await pdfjs();
    const pdf = await lib.getDocument({ data: new Uint8Array(await f.arrayBuffer()) }).promise;
    const chunks = [];
    for (const n of parseRanges(o.pages, pdf.numPages)) {
      const tc = await (await pdf.getPage(n + 1)).getTextContent();
      const txt = tc.items.map((it) => it.str + (it.hasEOL ? '\n' : '')).join('');
      chunks.push(`──────── 第 ${n + 1} 頁 ────────\n${txt.trim()}`);
    }
    pdf.destroy();
    return { name: `${stem(f.name)}.txt`, blob: new Blob([chunks.join('\n\n')], { type: 'text/plain;charset=utf-8' }) };
  };

  T.watermark = async ([f], o, extra) => {
    const { StandardFonts, degrees } = window.PDFLib;
    const doc = await open(f);
    const pages = doc.getPages();
    const targets = pageSet(o.pages, pages.length);
    if (o.kind === 'image') {
      if (!extra) fail('請上傳浮水印圖片');
      const bmp = await createImageBitmap(extra);
      const c = document.createElement('canvas'); c.width = bmp.width; c.height = bmp.height;
      c.getContext('2d').drawImage(bmp, 0, 0);
      const img = await doc.embedPng(await (await toBlob(c, 'image/png')).arrayBuffer());
      for (const n of targets) {
        const p = pages[n], { width: W, height: H } = p.getSize();
        const w = W * (o.scale || 0.4), h = w * bmp.height / bmp.width;
        const a = anchor(W, H, o.position, w, h, 24);
        p.drawImage(img, { x: a.x, y: a.y, width: w, height: h, opacity: o.opacity });
      }
    } else {
      const text = String(o.text || '').trim() || fail('請輸入浮水印文字');
      latinOnly(text);
      const font = await doc.embedFont(StandardFonts.HelveticaBold);
      const size = +o.size || 48, tw = font.widthOfTextAtSize(text, size), ang = (+o.angle || 0) * Math.PI / 180;
      // Offset the baseline origin so the label rotates about its own centre.
      const cx = tw / 2, cy = size * 0.35;
      const off = { x: cx * Math.cos(ang) - cy * Math.sin(ang), y: cx * Math.sin(ang) + cy * Math.cos(ang) };
      for (const n of targets) {
        const p = pages[n], { width: W, height: H } = p.getSize();
        let centres;
        if (o.tiled) {
          centres = [];
          for (let y = -H * 0.2; y < H * 1.2; y += size * 4) for (let x = -W * 0.2; x < W * 1.2; x += tw + size * 2) centres.push({ x, y });
        } else {
          const a = anchor(W, H, o.position, tw, size * 0.8, 36);
          centres = [{ x: a.x + cx, y: a.y + cy }];
        }
        for (const c of centres) p.drawText(text, { x: c.x - off.x, y: c.y - off.y, size, font, color: rgb(o.color), opacity: o.opacity, rotate: degrees(+o.angle || 0) });
      }
    }
    return { name: `${stem(f.name)}_watermarked.pdf`, blob: await save(doc) };
  };

  async function stampText(doc, items, size, color, margin) {
    const font = await doc.embedFont(window.PDFLib.StandardFonts.Helvetica);
    for (const [page, label, pos] of items) {
      latinOnly(label);
      const { width: W, height: H } = page.getSize();
      const a = anchor(W, H, pos, font.widthOfTextAtSize(label, size), size * 0.8, margin * MM);
      page.drawText(label, { x: a.x, y: a.y, size, font, color: rgb(color) });
    }
  }

  T.numbers = async ([f], o) => {
    const doc = await open(f);
    const pages = doc.getPages();
    let targets = [...pageSet(o.pages, pages.length)].sort((a, b) => a - b);
    if (o.skip_first) targets = targets.slice(1);
    const start = +o.start || 0, total = targets.length + start - 1;
    const fmt = o.format || '{n} / {total}';
    const items = targets.map((n, i) => [pages[n], fmt.replaceAll('{n}', start + i).replaceAll('{total}', total)
      .replaceAll('{page}', n + 1).replaceAll('{pages}', pages.length), o.position || 'bottom-center']);
    await stampText(doc, items, +o.size || 11, o.color, +o.margin || 10);
    return { name: `${stem(f.name)}_numbered.pdf`, blob: await save(doc) };
  };

  T.header = async ([f], o) => {
    const doc = await open(f);
    const pages = doc.getPages(), items = [];
    for (const n of pageSet(o.pages, pages.length)) {
      for (const [text, pos] of [[o.header, 'top-center'], [o.footer, 'bottom-center']]) {
        if (text) items.push([pages[n], text.replaceAll('{n}', n + 1).replaceAll('{total}', pages.length), pos]);
      }
    }
    await stampText(doc, items, +o.size || 9, o.color, +o.margin || 8);
    return { name: `${stem(f.name)}_header.pdf`, blob: await save(doc) };
  };

  T.metadata = async ([f], o) => {
    const doc = await open(f);
    const m = o.strip ? {} : (o.meta || {});
    doc.setTitle(m.title || ''); doc.setAuthor(m.author || ''); doc.setSubject(m.subject || '');
    doc.setKeywords(m.keywords ? [m.keywords] : []); doc.setCreator(m.creator || ''); doc.setProducer(m.producer || '');
    return { name: `${stem(f.name)}_meta.pdf`, blob: await save(doc) };
  };

  async function run(tool, files, opts, extra) {
    const fn = T[tool] || fail('這個工具需要登入');
    await load('PDFLib');
    return fn(files, opts, extra);
  }

  return { run, info, thumbs, tools: new Set(Object.keys(T)), EdgeError };
})();
