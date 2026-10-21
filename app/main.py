"""PDF Tool web server. Uploads are held in RAM only, processed, streamed back, and dropped."""
from __future__ import annotations

import base64
import json
import os
from pathlib import Path
from typing import Any, Callable
from urllib.parse import quote

from fastapi import FastAPI, Request, UploadFile
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse, Response
from fastapi.staticfiles import StaticFiles
from starlette.formparsers import MultiPartParser
from starlette.middleware.sessions import SessionMiddleware

from . import ops
from .auth import Throttle, ensure_config, verify_password

# Keep every uploaded part in memory instead of spooling big files to a temp dir.
MAX_UPLOAD_MB = int(os.environ.get("PDFTOOL_MAX_UPLOAD_MB", "512"))
MultiPartParser.spool_max_size = MAX_UPLOAD_MB * 1024 * 1024
MultiPartParser.max_part_size = MAX_UPLOAD_MB * 1024 * 1024

CONFIG, GENERATED_PASSWORD = ensure_config()
AUTH_ON = CONFIG.get("PDFTOOL_AUTH", "on").lower() not in ("off", "0", "false", "no")
STATIC = Path(__file__).parent / "static"

app = FastAPI(title="PDF Tool", docs_url=None, redoc_url=None, openapi_url=None)
throttle = Throttle()

PUBLIC = ("/login", "/api/login", "/static/", "/favicon", "/manifest.webmanifest", "/healthz")


@app.middleware("http")
async def guard(request: Request, call_next):
    path = request.url.path
    if AUTH_ON and not path.startswith(PUBLIC) and not request.session.get("user"):
        if path.startswith("/api/"):
            return JSONResponse({"error": "請先登入"}, status_code=401)
        return RedirectResponse("/login")
    resp = await call_next(request)
    resp.headers["Cache-Control"] = "no-store"
    resp.headers["X-Content-Type-Options"] = "nosniff"
    resp.headers["Referrer-Policy"] = "no-referrer"
    return resp


# Added after guard so it wraps it (outermost) and request.session is ready inside guard.
app.add_middleware(
    SessionMiddleware,
    secret_key=CONFIG["PDFTOOL_SECRET"],
    session_cookie="pdftool_session",
    max_age=60 * 60 * 24 * int(CONFIG.get("PDFTOOL_SESSION_DAYS", "30")),
    same_site="strict",
    https_only=CONFIG.get("PDFTOOL_HTTPS", "").lower() in ("1", "true", "on"),
)


# ───────────────────────── pages & auth ─────────────────────────

@app.get("/")
async def index():
    return FileResponse(STATIC / "index.html")


@app.get("/login")
async def login_page(request: Request):
    if not AUTH_ON or request.session.get("user"):
        return RedirectResponse("/")
    return FileResponse(STATIC / "login.html")


@app.get("/healthz")
async def healthz():
    return {"ok": True}


@app.get("/manifest.webmanifest")
async def manifest():
    return FileResponse(STATIC / "manifest.webmanifest", media_type="application/manifest+json")


@app.post("/api/login")
async def login(request: Request):
    ip = request.client.host if request.client else "?"
    wait = throttle.blocked(ip)
    if wait:
        return JSONResponse({"error": f"嘗試太多次，請 {wait // 60 + 1} 分鐘後再試"}, status_code=429)
    body = await request.json()
    user_ok = body.get("user", "") == CONFIG["PDFTOOL_USER"]
    pw_ok = verify_password(body.get("password", ""), CONFIG["PDFTOOL_PASSWORD_HASH"])
    if not (user_ok and pw_ok):
        throttle.fail(ip)
        return JSONResponse({"error": "帳號或密碼錯誤"}, status_code=401)
    throttle.reset(ip)
    request.session["user"] = CONFIG["PDFTOOL_USER"]
    return {"ok": True}


@app.post("/api/logout")
async def logout(request: Request):
    request.session.clear()
    return {"ok": True}


@app.get("/api/me")
async def me(request: Request):
    return {"user": request.session.get("user"), "auth": AUTH_ON, "max_upload_mb": MAX_UPLOAD_MB}


# ───────────────────────── tools ─────────────────────────

def _b(v: Any) -> bool:
    return str(v).lower() in ("1", "true", "on", "yes")


def _f(o: dict, k: str, d: float) -> float:
    try:
        return float(o.get(k, d))
    except (TypeError, ValueError):
        return d


def _i(o: dict, k: str, d: int) -> int:
    return int(_f(o, k, d))


Files = list[tuple[str, bytes]]


def _first(files: Files) -> tuple[str, bytes]:
    if not files:
        raise ops.PdfError("請先選擇檔案")
    return files[0]


def _pdf_out(name: str, suffix: str, data: bytes) -> ops.OutFile:
    return ops.OutFile(f"{ops.stem(name)}_{suffix}.pdf", data)


def t_merge(files: Files, extra: Files, o: dict):
    return ops.OutFile("merged.pdf", ops.merge(files, o.get("ranges"), o.get("passwords"),
                                               _b(o.get("bookmarks", True))))


def t_organize(files: Files, extra: Files, o: dict):
    name = files[0][0] if files else "organized.pdf"
    return _pdf_out(name, "organized", ops.compose([d for _, d in files], o.get("pages", []),
                                                    o.get("passwords")))


def t_split(files: Files, extra: Files, o: dict):
    n, d = _first(files)
    return ops.split(d, n, o.get("mode", "each"), str(o.get("value", "")), o.get("password", ""))


def t_rotate(files: Files, extra: Files, o: dict):
    n, d = _first(files)
    return _pdf_out(n, "rotated", ops.rotate(d, _i(o, "angle", 90), o.get("pages", ""), o.get("password", "")))


def t_delete(files: Files, extra: Files, o: dict):
    n, d = _first(files)
    return _pdf_out(n, "trimmed", ops.delete_pages(d, o.get("pages", ""), o.get("password", "")))


def t_nup(files: Files, extra: Files, o: dict):
    n, d = _first(files)
    land = o.get("orientation", "auto")
    return _pdf_out(n, f"{o.get('per_sheet', 2)}up", ops.nup(
        d, _i(o, "per_sheet", 2), o.get("paper", "A4"),
        None if land == "auto" else land == "landscape",
        _f(o, "margin", 5), _f(o, "gap", 3), _b(o.get("border")), o.get("password", "")))


def t_crop(files: Files, extra: Files, o: dict):
    n, d = _first(files)
    return _pdf_out(n, "cropped", ops.crop(d, _f(o, "top", 0), _f(o, "right", 0), _f(o, "bottom", 0),
                                           _f(o, "left", 0), o.get("pages", ""), o.get("password", "")))


def t_compress(files: Files, extra: Files, o: dict):
    n, d = _first(files)
    out = ops.compress(d, o.get("level", "recommended"), _i(o, "dpi", 150), _i(o, "quality", 70),
                       _b(o.get("grayscale")), o.get("password", ""))
    if len(out) >= len(d) and o.get("level") != "extreme":
        out = d  # never hand back something bigger than the input
    return _pdf_out(n, "compressed", out)


def t_grayscale(files: Files, extra: Files, o: dict):
    n, d = _first(files)
    return _pdf_out(n, "gray", ops.grayscale(d, _i(o, "dpi", 150), o.get("password", "")))


def t_flatten(files: Files, extra: Files, o: dict):
    n, d = _first(files)
    return _pdf_out(n, "flat", ops.flatten(d, _b(o.get("annots", True)), _b(o.get("widgets", True)),
                                           o.get("password", "")))


def t_repair(files: Files, extra: Files, o: dict):
    n, d = _first(files)
    return _pdf_out(n, "repaired", ops.repair(d, o.get("password", "")))


def t_protect(files: Files, extra: Files, o: dict):
    n, d = _first(files)
    return _pdf_out(n, "protected", ops.encrypt(d, o.get("user_pw", ""), o.get("owner_pw", ""),
                                                o.get("allow"), o.get("algorithm", "aes256"),
                                                o.get("password", "")))


def t_unlock(files: Files, extra: Files, o: dict):
    n, d = _first(files)
    return _pdf_out(n, "unlocked", ops.decrypt(d, o.get("password", "")))


def t_watermark(files: Files, extra: Files, o: dict):
    n, d = _first(files)
    common = dict(opacity=_f(o, "opacity", 0.25), position=o.get("position", "center"),
                  pages=o.get("pages", ""), behind=_b(o.get("behind")), password=o.get("password", ""))
    if o.get("kind") == "image":
        if not extra:
            raise ops.PdfError("請上傳浮水印圖片")
        out = ops.watermark_image(d, extra[0][1], scale=_f(o, "scale", 0.4), **common)
    else:
        out = ops.watermark_text(d, o.get("text", ""), _f(o, "size", 48), o.get("color", "#ff0000"),
                                 angle=_f(o, "angle", 45), tiled=_b(o.get("tiled")), **common)
    return _pdf_out(n, "watermarked", out)


def t_numbers(files: Files, extra: Files, o: dict):
    n, d = _first(files)
    return _pdf_out(n, "numbered", ops.page_numbers(
        d, o.get("format", "{n} / {total}"), o.get("position", "bottom-center"), _i(o, "start", 1),
        _f(o, "size", 11), o.get("color", "#000000"), _f(o, "margin", 10), o.get("pages", ""),
        _b(o.get("skip_first")), o.get("password", "")))


def t_header(files: Files, extra: Files, o: dict):
    n, d = _first(files)
    return _pdf_out(n, "header", ops.header_footer(
        d, o.get("header", ""), o.get("footer", ""), _f(o, "size", 9), o.get("color", "#555555"),
        _f(o, "margin", 8), o.get("pages", ""), o.get("password", "")))


def t_to_images(files: Files, extra: Files, o: dict):
    n, d = _first(files)
    return ops.to_images(d, n, o.get("format", "png"), _i(o, "dpi", 150), o.get("pages", ""),
                         _i(o, "quality", 90), o.get("password", ""))


def t_extract_images(files: Files, extra: Files, o: dict):
    n, d = _first(files)
    return ops.extract_images(d, n, _i(o, "min_px", 32), o.get("password", ""))


def t_from_images(files: Files, extra: Files, o: dict):
    name = (ops.stem(files[0][0]) if len(files) == 1 else "images") + ".pdf"
    return ops.OutFile(name, ops.images_to_pdf(
        files, o.get("paper", "A4"), o.get("orientation", "auto"), _f(o, "margin", 0),
        o.get("fit", "fit"), _i(o, "dpi", 0), _i(o, "quality", 0)))


def t_text(files: Files, extra: Files, o: dict):
    n, d = _first(files)
    txt = ops.extract_text(d, o.get("pages", ""), _b(o.get("layout")), o.get("password", ""))
    return ops.OutFile(f"{ops.stem(n)}.txt", txt.encode("utf-8"), "text/plain; charset=utf-8")


def t_html(files: Files, extra: Files, o: dict):
    html = o.get("html", "")
    if files:
        html = files[0][1].decode("utf-8", errors="replace")
    return ops.OutFile("document.pdf", ops.html_to_pdf(html, o.get("paper", "A4"), _f(o, "margin", 15)))


def t_metadata(files: Files, extra: Files, o: dict):
    n, d = _first(files)
    return _pdf_out(n, "meta", ops.set_metadata(d, o.get("meta", {}), _b(o.get("strip")),
                                                o.get("password", "")))


TOOLS: dict[str, Callable] = {
    "merge": t_merge, "organize": t_organize, "split": t_split, "rotate": t_rotate,
    "delete": t_delete, "nup": t_nup, "crop": t_crop, "compress": t_compress,
    "grayscale": t_grayscale, "flatten": t_flatten, "repair": t_repair, "protect": t_protect,
    "unlock": t_unlock, "watermark": t_watermark, "numbers": t_numbers, "header": t_header,
    "to_images": t_to_images, "extract_images": t_extract_images, "from_images": t_from_images,
    "text": t_text, "html": t_html, "metadata": t_metadata,
}


async def _read(form, key: str) -> Files:
    items = []
    for f in form.getlist(key):
        if isinstance(f, UploadFile) or hasattr(f, "read"):
            items.append((f.filename or "file", await f.read()))
    return items


@app.post("/api/run/{tool}")
async def run_tool(tool: str, request: Request):
    fn = TOOLS.get(tool)
    if not fn:
        return JSONResponse({"error": f"未知工具：{tool}"}, status_code=404)
    form = await request.form()
    try:
        files, extra = await _read(form, "files"), await _read(form, "extra")
        opts = json.loads(form.get("options") or "{}")
        in_size = sum(len(d) for _, d in files)
        out = await run_in_threadpool(fn, files, extra, opts)
    except ops.PdfError as exc:
        return JSONResponse({"error": str(exc)}, status_code=400)
    except Exception as exc:  # noqa: BLE001
        return JSONResponse({"error": f"處理失敗：{type(exc).__name__}: {exc}"}, status_code=500)
    finally:
        await form.close()
    return Response(out.data, media_type=out.mime, headers={
        "Content-Disposition": f"attachment; filename*=UTF-8''{quote(out.name)}",
        "X-Filename": quote(out.name),
        "X-Input-Size": str(in_size),
        "X-Output-Size": str(len(out.data)),
        "Access-Control-Expose-Headers": "X-Filename, X-Input-Size, X-Output-Size",
    })


@app.post("/api/info")
async def pdf_info(request: Request):
    form = await request.form()
    try:
        files = await _read(form, "files")
        pw = form.get("password") or ""
        res = [dict(name=n, size=len(d), **await run_in_threadpool(ops.info, d, pw)) for n, d in files]
    except Exception as exc:  # noqa: BLE001
        return JSONResponse({"error": str(exc)}, status_code=400)
    finally:
        await form.close()
    return res


@app.post("/api/thumbs")
async def thumbs(request: Request):
    form = await request.form()
    try:
        files = await _read(form, "files")
        if not files:
            raise ops.PdfError("沒有檔案")
        width = min(int(form.get("width") or 180), 600)
        limit = int(form.get("limit") or 500)
        imgs = await run_in_threadpool(ops.thumbnails, files[0][1], form.get("password") or "", width, limit)
    except ops.PdfError as exc:
        return JSONResponse({"error": str(exc)}, status_code=400)
    except Exception as exc:  # noqa: BLE001
        return JSONResponse({"error": f"無法產生縮圖：{exc}"}, status_code=400)
    finally:
        await form.close()
    return {"thumbs": ["data:image/jpeg;base64," + base64.b64encode(i).decode() for i in imgs]}


app.mount("/static", StaticFiles(directory=STATIC), name="static")
