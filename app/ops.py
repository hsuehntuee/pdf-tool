"""PDF operations. Every function takes bytes and returns bytes — nothing touches disk.

Consolidated from the old scripts (decrypt.py / code2.py / testtest.py / pdfmerger.py /
imagetopdf.py / trans.py / C2H.py) onto a single engine: PyMuPDF.
"""
from __future__ import annotations

import io
import re
import zipfile
from dataclasses import dataclass

import pymupdf
from PIL import Image

MM = 72 / 25.4  # points per millimetre

PAPER = {
    "A3": (297, 420),
    "A4": (210, 297),
    "A5": (148, 210),
    "B5": (176, 250),
    "Letter": (215.9, 279.4),
    "Legal": (215.9, 355.6),
}

class PdfError(ValueError):
    """User-facing error (bad password, bad page range, ...)."""


@dataclass
class OutFile:
    name: str
    data: bytes
    mime: str = "application/pdf"


# ───────────────────────── helpers ─────────────────────────

def open_pdf(data: bytes, password: str = "") -> pymupdf.Document:
    try:
        doc = pymupdf.open(stream=data, filetype="pdf")
    except Exception as exc:  # noqa: BLE001
        raise PdfError(f"無法讀取 PDF，檔案可能損毀：{exc}") from exc
    if doc.needs_pass:
        if not password or not doc.authenticate(password):
            raise PdfError("此 PDF 有密碼保護，請提供正確密碼。")
    return doc


def save(doc: pymupdf.Document, **kw) -> bytes:
    opts = dict(garbage=3, deflate=True)
    opts.update(kw)
    return doc.tobytes(**opts)


def parse_ranges(spec: str, total: int) -> list[int]:
    """'1-3, 5, 8-' → zero-based page indices. Also: 'odd', 'even', 'last', '-3'.

    Empty spec means every page. Order and duplicates are kept as written.
    """
    spec = (spec or "").strip().lower()
    if not spec or spec == "all":
        return list(range(total))
    out: list[int] = []
    for part in re.split(r"[,\s;，]+", spec):
        if not part:
            continue
        if part == "odd":
            out += range(0, total, 2)
            continue
        if part == "even":
            out += range(1, total, 2)
            continue
        part = part.replace("last", str(total)).replace("end", str(total))
        m = re.fullmatch(r"(\d*)-(\d*)", part)
        if m:
            a = int(m.group(1)) if m.group(1) else 1
            b = int(m.group(2)) if m.group(2) else total
            step = 1 if b >= a else -1
            seq = range(a, b + step, step)
        elif part.isdigit():
            seq = [int(part)]
        else:
            raise PdfError(f"看不懂的頁碼範圍：「{part}」")
        for n in seq:
            if not 1 <= n <= total:
                raise PdfError(f"頁碼 {n} 超出範圍（共 {total} 頁）")
            out.append(n - 1)
    if not out:
        raise PdfError("頁碼範圍是空的")
    return out


def page_set(spec: str, total: int) -> set[int]:
    return set(parse_ranges(spec, total))


def zip_files(files: list[OutFile], name: str) -> OutFile:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for f in files:
            z.writestr(f.name, f.data)
    return OutFile(name, buf.getvalue(), "application/zip")


def hex_rgb(color: str) -> tuple[float, float, float]:
    c = (color or "#000000").lstrip("#")
    if len(c) == 3:
        c = "".join(ch * 2 for ch in c)
    try:
        return tuple(int(c[i:i + 2], 16) / 255 for i in (0, 2, 4))  # type: ignore[return-value]
    except ValueError as exc:
        raise PdfError(f"顏色格式錯誤：{color}") from exc


def stem(filename: str) -> str:
    return re.sub(r"\.[^.]+$", "", filename or "file") or "file"


# ───────────────────────── info / preview ─────────────────────────

def info(data: bytes, password: str = "") -> dict:
    doc = pymupdf.open(stream=data, filetype="pdf")
    encrypted = doc.needs_pass
    if encrypted and not (password and doc.authenticate(password)):
        return {"encrypted": True, "locked": True, "pages": 0}
    return {
        "encrypted": encrypted or bool(doc.is_encrypted),
        "locked": False,
        "pages": doc.page_count,
        "metadata": {k: v for k, v in (doc.metadata or {}).items() if v},
        "sizes": [[round(p.rect.width), round(p.rect.height)] for p in doc][:2000],
        "has_forms": bool(doc.is_form_pdf),
        "toc": len(doc.get_toc()),
    }


def thumbnails(data: bytes, password: str = "", width: int = 180, limit: int = 500) -> list[bytes]:
    doc = open_pdf(data, password)
    out = []
    for page in list(doc)[:limit]:
        zoom = width / max(page.rect.width, 1)
        pix = page.get_pixmap(matrix=pymupdf.Matrix(zoom, zoom), alpha=False)
        out.append(pix.tobytes("jpeg", jpg_quality=70))
    return out


# ───────────────────────── organise ─────────────────────────

def merge(files: list[tuple[str, bytes]], ranges: list[str] | None = None,
          passwords: list[str] | None = None, bookmarks: bool = True) -> bytes:
    if not files:
        raise PdfError("沒有檔案")
    out = pymupdf.open()
    toc = []
    for i, (name, data) in enumerate(files):
        src = open_pdf(data, (passwords or [""] * len(files))[i] if passwords else "")
        idx = parse_ranges((ranges or [""] * len(files))[i] if ranges else "", src.page_count)
        start = out.page_count
        for n in idx:
            out.insert_pdf(src, from_page=n, to_page=n)
        if bookmarks and idx:
            toc.append([1, stem(name), start + 1])
    if bookmarks and toc:
        out.set_toc(toc)
    return save(out)


def compose(files: list[bytes], pages: list[dict], passwords: list[str] | None = None) -> bytes:
    """Build a new PDF from a page list: [{"f": fileIdx, "p": pageIdx, "r": extraRotation}, ...].

    Drives the visual page organiser (reorder / rotate / delete / mix files / blank pages).
    """
    srcs = [open_pdf(d, (passwords or [""] * len(files))[i] if passwords else "") for i, d in enumerate(files)]
    out = pymupdf.open()
    for item in pages:
        if item.get("blank"):
            w, h = item.get("size") or (595, 842)
            out.new_page(width=w, height=h)
            continue
        src = srcs[int(item["f"])]
        p = int(item["p"])
        if not 0 <= p < src.page_count:
            raise PdfError("頁面索引錯誤")
        out.insert_pdf(src, from_page=p, to_page=p)
        rot = int(item.get("r", 0)) % 360
        if rot:
            pg = out[-1]
            pg.set_rotation((pg.rotation + rot) % 360)
    if out.page_count == 0:
        raise PdfError("至少要保留一頁")
    return save(out)


def split(data: bytes, filename: str, mode: str, value: str = "", password: str = "") -> OutFile:
    """mode: 'ranges' ('1-3,4-6' → one file per group), 'every' (N pages each),
    'each' (one file per page), 'extract' (selected pages into one file)."""
    doc = open_pdf(data, password)
    total = doc.page_count
    base = stem(filename)
    groups: list[tuple[str, list[int]]] = []
    if mode == "extract":
        idx = parse_ranges(value, total)
        part = pymupdf.open()
        for n in idx:
            part.insert_pdf(doc, from_page=n, to_page=n)
        return OutFile(f"{base}_extract.pdf", save(part))
    if mode == "each":
        groups = [(f"{base}_p{n + 1}.pdf", [n]) for n in range(total)]
    elif mode == "every":
        try:
            k = max(1, int(value or 1))
        except ValueError as exc:
            raise PdfError("每份頁數必須是數字") from exc
        groups = [(f"{base}_{i // k + 1}.pdf", list(range(i, min(i + k, total)))) for i in range(0, total, k)]
    elif mode == "ranges":
        specs = [s for s in re.split(r"[;,，]+", value or "") if s.strip()]
        if not specs:
            raise PdfError("請輸入分割範圍，例如 1-3, 4-8, 9-")
        groups = [(f"{base}_{s.strip()}.pdf", parse_ranges(s, total)) for s in specs]
    else:
        raise PdfError(f"未知分割模式：{mode}")
    files = []
    for name, idx in groups:
        part = pymupdf.open()
        for n in idx:
            part.insert_pdf(doc, from_page=n, to_page=n)
        files.append(OutFile(name, save(part)))
    if len(files) == 1:
        return files[0]
    return zip_files(files, f"{base}_split.zip")


def rotate(data: bytes, angle: int, pages: str = "", password: str = "") -> bytes:
    doc = open_pdf(data, password)
    for n in page_set(pages, doc.page_count):
        pg = doc[n]
        pg.set_rotation((pg.rotation + angle) % 360)
    return save(doc)


def delete_pages(data: bytes, pages: str, password: str = "") -> bytes:
    doc = open_pdf(data, password)
    kill = sorted(page_set(pages, doc.page_count))
    if len(kill) >= doc.page_count:
        raise PdfError("不能刪除全部頁面")
    doc.delete_pages(kill)
    return save(doc)


def nup(data: bytes, per_sheet: int = 2, paper: str = "A4", landscape: bool | None = None,
        margin_mm: float = 5, gap_mm: float = 3, border: bool = False, password: str = "") -> bytes:
    """Put 2/4/6/8/9/16 pages on one sheet."""
    layouts = {2: (2, 1), 4: (2, 2), 6: (3, 2), 8: (4, 2), 9: (3, 3), 16: (4, 4)}
    if per_sheet not in layouts:
        raise PdfError("每張頁數只支援 2/4/6/8/9/16")
    if landscape is None:
        landscape = per_sheet in (2, 6, 8)
    big, small = layouts[per_sheet]
    cols, rows = (big, small) if landscape else (small, big)
    w, h = (PAPER.get(paper) or PAPER["A4"])
    W, H = (h * MM, w * MM) if landscape else (w * MM, h * MM)
    src = open_pdf(data, password)
    out = pymupdf.open()
    m, g = margin_mm * MM, gap_mm * MM
    cw = (W - 2 * m - (cols - 1) * g) / cols
    ch = (H - 2 * m - (rows - 1) * g) / rows
    for i in range(src.page_count):
        slot = i % per_sheet
        if slot == 0:
            sheet = out.new_page(width=W, height=H)
        r, c = divmod(slot, cols)
        cell = pymupdf.Rect(m + c * (cw + g), m + r * (ch + g), m + c * (cw + g) + cw, m + r * (ch + g) + ch)
        sheet.show_pdf_page(cell, src, i, keep_proportion=True)
        if border:
            sheet.draw_rect(cell, color=(0.6, 0.6, 0.6), width=0.5)
    return save(out)


def crop(data: bytes, top: float, right: float, bottom: float, left: float,
         pages: str = "", password: str = "") -> bytes:
    """Trim margins (mm) off each selected page."""
    doc = open_pdf(data, password)
    for n in page_set(pages, doc.page_count):
        pg = doc[n]
        r = pg.mediabox
        new = pymupdf.Rect(r.x0 + left * MM, r.y0 + top * MM, r.x1 - right * MM, r.y1 - bottom * MM)
        if new.width < 10 or new.height < 10:
            raise PdfError(f"第 {n + 1} 頁裁切過多")
        pg.set_cropbox(new)
    return save(doc)


# ───────────────────────── optimise ─────────────────────────

def compress(data: bytes, level: str = "recommended", dpi: int = 150, quality: int = 70,
             grayscale: bool = False, password: str = "") -> bytes:
    """level:
    - lossless    : garbage collect, dedupe, deflate, object streams (no quality loss)
    - recommended : lossless + downsample images above dpi*1.5 to dpi, JPEG quality
    - extreme     : rasterise every page to JPEG (text no longer selectable)
    """
    doc = open_pdf(data, password)
    if level == "extreme":
        out = pymupdf.open()
        zoom = dpi / 72
        cs = pymupdf.csGRAY if grayscale else pymupdf.csRGB
        for page in doc:
            pix = page.get_pixmap(matrix=pymupdf.Matrix(zoom, zoom), colorspace=cs, alpha=False)
            img = pix.tobytes("jpeg", jpg_quality=quality)
            np = out.new_page(width=page.rect.width, height=page.rect.height)
            np.insert_image(np.rect, stream=img)
        return out.tobytes(garbage=4, deflate=True, use_objstms=1)
    if level == "recommended":
        doc.rewrite_images(dpi_threshold=int(dpi * 1.5), dpi_target=dpi, quality=quality,
                           set_to_gray=grayscale)
    elif grayscale:
        doc.rewrite_images(set_to_gray=True, lossy=False)
    doc.subset_fonts()
    return doc.tobytes(garbage=4, deflate=True, deflate_images=True, deflate_fonts=True,
                       clean=True, use_objstms=1, compression_effort=100)


def grayscale(data: bytes, dpi: int = 150, password: str = "") -> bytes:
    return compress(data, "extreme", dpi=dpi, quality=85, grayscale=True, password=password)


def flatten(data: bytes, annots: bool = True, widgets: bool = True, password: str = "") -> bytes:
    """Burn form fields and annotations into the page content."""
    doc = open_pdf(data, password)
    doc.bake(annots=annots, widgets=widgets)
    return save(doc)


def repair(data: bytes, password: str = "") -> bytes:
    doc = open_pdf(data, password)
    return doc.tobytes(garbage=4, deflate=True, clean=True)


# ───────────────────────── security ─────────────────────────

PERMS = {
    "print": pymupdf.PDF_PERM_PRINT,
    "print_hq": pymupdf.PDF_PERM_PRINT_HQ,
    "copy": pymupdf.PDF_PERM_COPY,
    "modify": pymupdf.PDF_PERM_MODIFY,
    "annotate": pymupdf.PDF_PERM_ANNOTATE,
    "form": pymupdf.PDF_PERM_FORM,
    "assemble": pymupdf.PDF_PERM_ASSEMBLE,
    "accessibility": pymupdf.PDF_PERM_ACCESSIBILITY,
}


def encrypt(data: bytes, user_pw: str, owner_pw: str = "", allow: list[str] | None = None,
            algorithm: str = "aes256", password: str = "") -> bytes:
    if not user_pw and not owner_pw:
        raise PdfError("至少要設定開啟密碼或權限密碼")
    doc = open_pdf(data, password)
    algo = {
        "aes256": pymupdf.PDF_ENCRYPT_AES_256,
        "aes128": pymupdf.PDF_ENCRYPT_AES_128,
        "rc4": pymupdf.PDF_ENCRYPT_RC4_128,
    }.get(algorithm, pymupdf.PDF_ENCRYPT_AES_256)
    allow = list(PERMS) if allow is None else allow
    perm = 0
    for k in allow:
        perm |= PERMS.get(k, 0)
    return doc.tobytes(garbage=3, deflate=True, encryption=algo,
                       user_pw=user_pw or "", owner_pw=owner_pw or user_pw, permissions=perm)


def decrypt(data: bytes, password: str) -> bytes:
    doc = pymupdf.open(stream=data, filetype="pdf")
    if doc.needs_pass and not doc.authenticate(password or ""):
        raise PdfError("密碼錯誤，無法解密 PDF。")
    # authenticate() also succeeds for owner-only (permission) locks, which we strip here.
    return doc.tobytes(garbage=3, deflate=True, encryption=pymupdf.PDF_ENCRYPT_NONE)


# ───────────────────────── stamp ─────────────────────────

def _anchor(rect: pymupdf.Rect, pos: str, w: float, h: float, margin: float) -> pymupdf.Point:
    """Bottom-left baseline point for a w×h box at position like 'top-left', 'center', 'bottom-right'."""
    v, _, hz = pos.partition("-") if "-" in pos else ("middle", "", pos)
    if pos == "center":
        v, hz = "middle", "center"
    x = {"left": rect.x0 + margin, "center": rect.x0 + (rect.width - w) / 2,
         "right": rect.x1 - margin - w}.get(hz, rect.x0 + (rect.width - w) / 2)
    y = {"top": rect.y0 + margin + h, "middle": rect.y0 + (rect.height + h) / 2,
         "bottom": rect.y1 - margin}.get(v, rect.y0 + (rect.height + h) / 2)
    return pymupdf.Point(x, y)


_FONT: pymupdf.Font | None = None


def _font() -> pymupdf.Font:
    """Droid Sans Fallback (CJK + Latin) — embedded via TextWriter, subset on save."""
    global _FONT
    if _FONT is None:
        _FONT = pymupdf.Font("cjk")
    return _FONT


def _text_width(text: str, size: float) -> float:
    return _font().text_length(text, fontsize=size)


def _wrap(page: pymupdf.Page) -> None:
    """Isolate existing content in q/Q so a leftover CTM can't flip what we add."""
    if not page.is_wrapped:
        page.wrap_contents()


def _draw_text(page: pymupdf.Page, at: pymupdf.Point, text: str, size: float, rgb) -> None:
    _wrap(page)
    tw = pymupdf.TextWriter(page.rect)
    tw.append(at, text, font=_font(), fontsize=size)
    tw.write_text(page, color=rgb)


def save_text(doc: pymupdf.Document) -> bytes:
    doc.subset_fonts()  # otherwise every output carries the full 3.5 MB CJK font
    return save(doc, garbage=4)


def watermark_text(data: bytes, text: str, size: float = 48, color: str = "#ff0000",
                   opacity: float = 0.25, angle: float = 45, position: str = "center",
                   tiled: bool = False, pages: str = "", behind: bool = False, password: str = "") -> bytes:
    if not text.strip():
        raise PdfError("請輸入浮水印文字")
    doc = open_pdf(data, password)
    rgb = hex_rgb(color)
    tw = _text_width(text, size)
    for n in page_set(pages, doc.page_count):
        page = doc[n]
        rect = page.rect
        if tiled:
            step_x, step_y = tw + size * 2, size * 4
            pts = [pymupdf.Point(x, y)
                   for y in _frange(-rect.height * 0.2, rect.height * 1.2, step_y)
                   for x in _frange(-rect.width * 0.2, rect.width * 1.2, step_x)]
        else:
            pts = [_anchor(rect, position, tw, size * 0.8, 36)]
        _wrap(page)
        writer = pymupdf.TextWriter(rect)
        for p in pts:
            writer.append(p, text, font=_font(), fontsize=size)
        # Rotate each copy about its own centre for a single stamp, about the page centre when tiled.
        pivot = rect.tl + (rect.width / 2, rect.height / 2) if tiled else \
            pymupdf.Point(pts[0].x + tw / 2, pts[0].y - size * 0.35)
        writer.write_text(page, color=rgb, opacity=opacity, overlay=not behind,
                          morph=(pivot, pymupdf.Matrix(angle)) if angle else None)
    return save_text(doc)


def watermark_image(data: bytes, image: bytes, scale: float = 0.4, opacity: float = 0.3,
                    position: str = "center", pages: str = "", behind: bool = False,
                    password: str = "") -> bytes:
    doc = open_pdf(data, password)
    img = Image.open(io.BytesIO(image)).convert("RGBA")
    if opacity < 1:
        alpha = img.getchannel("A").point(lambda a: int(a * opacity))
        img.putalpha(alpha)
    buf = io.BytesIO()
    img.save(buf, "PNG")
    png = buf.getvalue()
    for n in page_set(pages, doc.page_count):
        page = doc[n]
        r = page.rect
        w = r.width * scale
        h = w * img.height / img.width
        p = _anchor(r, position, w, h, 24)
        page.insert_image(pymupdf.Rect(p.x, p.y - h, p.x + w, p.y), stream=png, overlay=not behind)
    return save(doc)


def _frange(a: float, b: float, step: float):
    while a < b:
        yield a
        a += step


def page_numbers(data: bytes, fmt: str = "{n} / {total}", position: str = "bottom-center",
                 start: int = 1, size: float = 11, color: str = "#000000", margin_mm: float = 10,
                 pages: str = "", skip_first: bool = False, password: str = "") -> bytes:
    doc = open_pdf(data, password)
    rgb = hex_rgb(color)
    targets = sorted(page_set(pages, doc.page_count))
    if skip_first and targets:
        targets = targets[1:]
    total = len(targets) + start - 1
    for i, n in enumerate(targets):
        page = doc[n]
        label = fmt.replace("{n}", str(start + i)).replace("{total}", str(total)) \
                   .replace("{page}", str(n + 1)).replace("{pages}", str(doc.page_count))
        tw = _text_width(label, size)
        p = _anchor(page.rect, position, tw, size * 0.8, margin_mm * MM)
        _draw_text(page, p, label, size, rgb)
    return save_text(doc)


def header_footer(data: bytes, header: str = "", footer: str = "", size: float = 9,
                  color: str = "#555555", margin_mm: float = 8, pages: str = "",
                  password: str = "") -> bytes:
    doc = open_pdf(data, password)
    rgb = hex_rgb(color)
    for n in page_set(pages, doc.page_count):
        page = doc[n]
        for text, pos in ((header, "top-center"), (footer, "bottom-center")):
            if text:
                label = text.replace("{n}", str(n + 1)).replace("{total}", str(doc.page_count))
                p = _anchor(page.rect, pos, _text_width(label, size), size * 0.8, margin_mm * MM)
                _draw_text(page, p, label, size, rgb)
    return save_text(doc)


# ───────────────────────── convert ─────────────────────────

def to_images(data: bytes, filename: str, fmt: str = "png", dpi: int = 150, pages: str = "",
              quality: int = 90, password: str = "") -> OutFile:
    doc = open_pdf(data, password)
    fmt = fmt.lower()
    if fmt not in ("png", "jpg", "webp"):
        raise PdfError("格式只支援 png / jpg / webp")
    base = stem(filename)
    zoom = dpi / 72
    files = []
    for n in parse_ranges(pages, doc.page_count):
        pix = doc[n].get_pixmap(matrix=pymupdf.Matrix(zoom, zoom), alpha=False)
        if fmt == "png":
            blob = pix.tobytes("png")
        elif fmt == "jpg":
            blob = pix.tobytes("jpeg", jpg_quality=quality)
        else:
            im = Image.frombytes("RGB", (pix.width, pix.height), pix.samples)
            b = io.BytesIO()
            im.save(b, "WEBP", quality=quality)
            blob = b.getvalue()
        files.append(OutFile(f"{base}_p{n + 1}.{fmt}", blob, f"image/{'jpeg' if fmt == 'jpg' else fmt}"))
    if len(files) == 1:
        return files[0]
    return zip_files(files, f"{base}_images.zip")


def extract_images(data: bytes, filename: str, min_px: int = 32, password: str = "") -> OutFile:
    doc = open_pdf(data, password)
    base = stem(filename)
    seen, files = set(), []
    for pno, page in enumerate(doc):
        for img in page.get_images(full=True):
            xref = img[0]
            if xref in seen:
                continue
            seen.add(xref)
            info_ = doc.extract_image(xref)
            if not info_ or min(info_["width"], info_["height"]) < min_px:
                continue
            files.append(OutFile(f"{base}_p{pno + 1}_{xref}.{info_['ext']}", info_["image"]))
    if not files:
        raise PdfError("這份 PDF 裡沒有找到內嵌圖片")
    return zip_files(files, f"{base}_embedded_images.zip")


def images_to_pdf(images: list[tuple[str, bytes]], paper: str = "A4", orientation: str = "auto",
                  margin_mm: float = 0, fit: str = "fit", dpi: int = 0, quality: int = 0) -> bytes:
    """paper: A4/Letter/... or 'original' (page = image size).
    fit: 'fit' (keep ratio, centred), 'fill' (cover, cropped), 'stretch'.
    quality > 0 re-encodes as JPEG at that quality (shrinks phone photos)."""
    if not images:
        raise PdfError("沒有圖片")
    out = pymupdf.open()
    for name, blob in images:
        try:
            im = Image.open(io.BytesIO(blob))
            im.load()
        except Exception as exc:  # noqa: BLE001
            raise PdfError(f"無法讀取圖片：{name}") from exc
        im = _exif_upright(im)
        if im.mode in ("RGBA", "LA", "P"):
            bg = Image.new("RGB", im.size, (255, 255, 255))
            rgba = im.convert("RGBA")
            bg.paste(rgba, mask=rgba.getchannel("A"))
            im = bg
        elif im.mode not in ("RGB", "L"):
            im = im.convert("RGB")
        b = io.BytesIO()
        if quality:
            im.save(b, "JPEG", quality=quality, optimize=True)
        else:
            im.save(b, "PNG" if (name.lower().endswith(".png") or im.mode == "L") else "JPEG",
                    quality=95)
        stream = b.getvalue()
        iw, ih = im.size
        if paper == "original":
            scale = 72 / (dpi or 96)
            W, H = iw * scale, ih * scale
        else:
            w, h = PAPER.get(paper, PAPER["A4"])
            W, H = w * MM, h * MM
            land = (iw > ih) if orientation == "auto" else orientation == "landscape"
            if land:
                W, H = H, W
        page = out.new_page(width=W, height=H)
        m = margin_mm * MM
        box = pymupdf.Rect(m, m, W - m, H - m)
        if fit == "stretch":
            page.insert_image(box, stream=stream, keep_proportion=False)
        elif fit == "fill":
            r = max(box.width / iw, box.height / ih)
            dw, dh = iw * r, ih * r
            target = pymupdf.Rect(box.x0 + (box.width - dw) / 2, box.y0 + (box.height - dh) / 2,
                                  box.x0 + (box.width + dw) / 2, box.y0 + (box.height + dh) / 2)
            page.insert_image(target, stream=stream)  # overflow is clipped by the page box
        else:
            page.insert_image(box, stream=stream, keep_proportion=True)
    return save(out)


def _exif_upright(im: Image.Image) -> Image.Image:
    try:
        from PIL import ImageOps
        return ImageOps.exif_transpose(im)
    except Exception:  # noqa: BLE001
        return im


def extract_text(data: bytes, pages: str = "", layout: bool = False, password: str = "") -> str:
    doc = open_pdf(data, password)
    chunks = []
    for n in parse_ranges(pages, doc.page_count):
        txt = doc[n].get_text("blocks" if layout else "text", sort=True)
        if layout:
            txt = "\n\n".join(b[4].strip() for b in txt if b[6] == 0)
        chunks.append(f"──────── 第 {n + 1} 頁 ────────\n{txt.strip()}")
    return "\n\n".join(chunks)


def html_to_pdf(html: str, paper: str = "A4", margin_mm: float = 15) -> bytes:
    """Lightweight HTML/CSS → PDF via MuPDF Story (replaces the weasyprint C2H.py)."""
    if not html.strip():
        raise PdfError("請輸入 HTML 內容")
    w, h = PAPER.get(paper, PAPER["A4"])
    mediabox = pymupdf.Rect(0, 0, w * MM, h * MM)
    where = mediabox + (margin_mm * MM, margin_mm * MM, -margin_mm * MM, -margin_mm * MM)
    css = "* { font-family: sans-serif; }"
    story = pymupdf.Story(html=html, user_css=css)
    buf = io.BytesIO()
    writer = pymupdf.DocumentWriter(buf)
    more = 1
    while more:
        dev = writer.begin_page(mediabox)
        more, _ = story.place(where)
        story.draw(dev)
        writer.end_page()
    writer.close()
    doc = pymupdf.open(stream=buf.getvalue(), filetype="pdf")
    doc.subset_fonts()  # Story embeds the whole CJK fallback font (~3.5 MB) otherwise
    return doc.tobytes(garbage=4, deflate=True)


# ───────────────────────── metadata ─────────────────────────

META_KEYS = ("title", "author", "subject", "keywords", "creator", "producer")


def set_metadata(data: bytes, meta: dict, strip: bool = False, password: str = "") -> bytes:
    doc = open_pdf(data, password)
    if strip:
        doc.set_metadata({})
        doc.del_xml_metadata()
    else:
        cur = doc.metadata or {}
        cur.update({k: v for k, v in meta.items() if k in META_KEYS})
        doc.set_metadata(cur)
    return save(doc)
