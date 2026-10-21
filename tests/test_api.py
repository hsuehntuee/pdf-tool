import io
import json
import os
import tempfile
import zipfile

import pymupdf
import pytest
from PIL import Image

os.environ["PDFTOOL_ENV"] = os.path.join(tempfile.mkdtemp(), ".env")
os.environ["PDFTOOL_PASSWORD"] = "secret123"

from fastapi.testclient import TestClient  # noqa: E402

from app import ops  # noqa: E402
from app.main import app  # noqa: E402


def make_pdf(pages=3, text="Hello"):
    doc = pymupdf.open()
    for i in range(pages):
        p = doc.new_page()
        p.insert_text((72, 72), f"{text} page {i + 1}", fontsize=24)
        pix = pymupdf.Pixmap(pymupdf.csRGB, pymupdf.IRect(0, 0, 600, 600), 0)
        pix.set_rect(pix.irect, (200, 50 + i * 40, 90))
        p.insert_image(pymupdf.Rect(72, 120, 372, 420), pixmap=pix)
    return doc.tobytes()


def make_png(w=400, h=300):
    b = io.BytesIO()
    Image.new("RGB", (w, h), (30, 140, 220)).save(b, "PNG")
    return b.getvalue()


@pytest.fixture(scope="module")
def client():
    c = TestClient(app)
    # Guests may load the UI and /api/me, but every server-side tool stays locked.
    assert c.get("/", follow_redirects=False).status_code == 200
    assert c.get("/api/me").json()["user"] is None
    for path in ("/api/run/compress", "/api/run/merge", "/api/info", "/api/thumbs"):
        assert c.post(path).status_code == 401
    assert c.post("/api/login", json={"user": "admin", "password": "nope"}).status_code == 401
    assert c.post("/api/login", json={"user": "admin", "password": "secret123"}).status_code == 200
    return c


def run(client, tool, files, opts=None, extra=None, ok=True):
    multipart = [("files", (n, d, "application/octet-stream")) for n, d in files]
    multipart += [("extra", (n, d, "application/octet-stream")) for n, d in (extra or [])]
    r = client.post(f"/api/run/{tool}", files=multipart, data={"options": json.dumps(opts or {})})
    if ok:
        assert r.status_code == 200, r.text
    return r


def pages_of(data):
    return pymupdf.open(stream=data, filetype="pdf").page_count


def test_ranges():
    assert ops.parse_ranges("", 5) == [0, 1, 2, 3, 4]
    assert ops.parse_ranges("1-2, 4-", 5) == [0, 1, 3, 4]
    assert ops.parse_ranges("odd", 5) == [0, 2, 4]
    assert ops.parse_ranges("3-1", 5) == [2, 1, 0]
    assert ops.parse_ranges("last", 5) == [4]
    with pytest.raises(ops.PdfError):
        ops.parse_ranges("9", 5)


def test_merge_split_organize(client):
    a, b = make_pdf(3, "A"), make_pdf(2, "B")
    r = run(client, "merge", [("a.pdf", a), ("b.pdf", b)], {"ranges": ["1-2", ""]})
    assert pages_of(r.content) == 4
    assert pymupdf.open(stream=r.content).get_toc() == [[1, "a", 1], [1, "b", 3]]

    r = run(client, "split", [("a.pdf", a)], {"mode": "each"})
    assert len(zipfile.ZipFile(io.BytesIO(r.content)).namelist()) == 3
    r = run(client, "split", [("a.pdf", a)], {"mode": "ranges", "value": "1-2;3"})
    assert len(zipfile.ZipFile(io.BytesIO(r.content)).namelist()) == 2
    r = run(client, "split", [("a.pdf", a)], {"mode": "extract", "value": "3,1"})
    assert pages_of(r.content) == 2

    pages = [{"f": 1, "p": 0}, {"f": 0, "p": 2, "r": 90}, {"blank": True}]
    r = run(client, "organize", [("a.pdf", a), ("b.pdf", b)], {"pages": pages})
    out = pymupdf.open(stream=r.content)
    assert out.page_count == 3 and out[1].rotation == 90 and "B page 1" in out[0].get_text()


def test_page_tools(client):
    a = make_pdf(4)
    assert pymupdf.open(stream=run(client, "rotate", [("a.pdf", a)], {"angle": 180, "pages": "2"}).content)[1].rotation == 180
    assert pages_of(run(client, "delete", [("a.pdf", a)], {"pages": "1,3"}).content) == 2
    assert pages_of(run(client, "nup", [("a.pdf", a)], {"per_sheet": 4}).content) == 1
    assert pages_of(run(client, "nup", [("a.pdf", a)], {"per_sheet": 2}).content) == 2
    c = pymupdf.open(stream=run(client, "crop", [("a.pdf", a)], {"top": 10, "left": 10}).content)
    assert c[0].cropbox.width < 595
    assert run(client, "delete", [("a.pdf", a)], {"pages": "1-4"}, ok=False).status_code == 400


def test_compress(client):
    a = make_pdf(5)
    for level in ("lossless", "recommended", "extreme"):
        r = run(client, "compress", [("a.pdf", a)], {"level": level, "dpi": 72, "quality": 40})
        assert pages_of(r.content) == 5
        assert int(r.headers["x-output-size"]) > 0
    assert pages_of(run(client, "grayscale", [("a.pdf", a)]).content) == 5


def test_security(client):
    a = make_pdf(2)
    locked = run(client, "protect", [("a.pdf", a)], {"user_pw": "pw1", "allow": ["print"]}).content
    assert pymupdf.open(stream=locked).needs_pass
    assert run(client, "unlock", [("a.pdf", locked)], {"password": "bad"}, ok=False).status_code == 400
    assert run(client, "rotate", [("a.pdf", locked)], {"angle": 90}, ok=False).status_code == 400
    open_ = run(client, "unlock", [("a.pdf", locked)], {"password": "pw1"}).content
    assert not pymupdf.open(stream=open_).is_encrypted
    # other tools accept the password directly
    assert pages_of(run(client, "rotate", [("a.pdf", locked)], {"angle": 90, "password": "pw1"}).content) == 2


def test_stamps(client):
    a = make_pdf(3)
    r = run(client, "watermark", [("a.pdf", a)], {"text": "機密 CONFIDENTIAL", "tiled": True})
    assert "機密" in pymupdf.open(stream=r.content)[0].get_text()
    r = run(client, "watermark", [("a.pdf", a)], {"kind": "image", "position": "bottom-right"},
            extra=[("logo.png", make_png())])
    assert pages_of(r.content) == 3
    r = run(client, "numbers", [("a.pdf", a)], {"format": "第 {n} 頁 / 共 {total} 頁", "skip_first": True})
    doc = pymupdf.open(stream=r.content)
    assert "第 1 頁 / 共 2 頁" in doc[1].get_text() and "第" not in doc[0].get_text()
    r = run(client, "header", [("a.pdf", a)], {"header": "報告 {n}", "footer": "footer"})
    assert "報告 1" in pymupdf.open(stream=r.content)[0].get_text()


def test_convert(client):
    a = make_pdf(2)
    r = run(client, "to_images", [("a.pdf", a)], {"format": "jpg", "dpi": 50})
    assert len(zipfile.ZipFile(io.BytesIO(r.content)).namelist()) == 2
    r = run(client, "to_images", [("a.pdf", a)], {"format": "webp", "pages": "1"})
    assert r.headers["content-type"] == "image/webp"
    r = run(client, "extract_images", [("a.pdf", a)])
    assert zipfile.ZipFile(io.BytesIO(r.content)).namelist()
    r = run(client, "from_images", [("x.png", make_png()), ("y.png", make_png(300, 600))],
            {"paper": "A4", "margin": 10})
    doc = pymupdf.open(stream=r.content)
    assert doc.page_count == 2 and doc[0].rect.width > doc[0].rect.height  # auto landscape
    r = run(client, "from_images", [("x.png", make_png())], {"paper": "original", "fit": "fill"})
    assert pages_of(r.content) == 1
    r = run(client, "text", [("a.pdf", a)])
    assert "Hello page 2" in r.content.decode()
    r = run(client, "html", [], {"html": "<h1>標題</h1><p>內文 text</p>"})
    assert "text" in pymupdf.open(stream=r.content)[0].get_text()


def test_meta_flatten_info(client):
    a = make_pdf(1)
    r = run(client, "metadata", [("a.pdf", a)], {"meta": {"title": "我的標題", "author": "me"}})
    assert pymupdf.open(stream=r.content).metadata["title"] == "我的標題"
    assert pages_of(run(client, "flatten", [("a.pdf", a)]).content) == 1
    assert pages_of(run(client, "repair", [("a.pdf", a)]).content) == 1
    info = client.post("/api/info", files=[("files", ("a.pdf", a))]).json()
    assert info[0]["pages"] == 1
    th = client.post("/api/thumbs", files=[("files", ("a.pdf", a))]).json()
    assert th["thumbs"][0].startswith("data:image/jpeg")
