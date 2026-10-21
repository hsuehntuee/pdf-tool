# PDF Tool

Your own self-hosted, iLovePDF-style PDF toolbox. 22 tools behind a login, all processing done on **your** machine, **in memory only**: uploads are never written to disk and nothing is kept after the response is sent.

![tools](https://img.shields.io/badge/tools-22-e5322d) ![python](https://img.shields.io/badge/python-3.10%2B-blue)

## 快速開始

**Windows**：雙擊 `run.bat`
**macOS / Linux**：`./run.sh`

第一次啟動會自動建立 `.venv` 並安裝套件，然後在終端機印出：

```
  │ 本機:   http://127.0.0.1:8765
  │ 區網:   http://192.168.x.x:8765   ← 手機/平板連這個
  │ 帳號:   admin
  │ 密碼:   xxxxxxxx   ← 首次啟動自動產生，請記下來
```

改帳號密碼：`run.bat passwd`（或 `./run.sh passwd`）

其他參數：`run.bat --port 9000`、`run.bat --host 127.0.0.1`（只允許本機）、`run.bat --no-browser`

## 工具

| 分類 | 工具 |
|---|---|
| 整理 | 合併（每份可指定頁碼、自動書籤）· **整理頁面**（縮圖拖曳排序／旋轉／刪除／複製／空白頁，可混合多份）· 分割（自訂範圍／每 N 頁／逐頁／擷取）· 旋轉 · 刪除頁 · 多頁合一（2/4/6/8/9/16-up）· 裁切邊界 |
| 最佳化 | 壓縮（無損／推薦／極致，可調 DPI、JPEG 品質、灰階）· 轉灰階 · 扁平化表單與註解 · 修復 |
| 轉換 | PDF → PNG/JPG/WebP（可調 DPI）· 圖片 → PDF（A4/Letter/原尺寸、方向、邊距、等比/填滿）· 擷取內嵌圖片 · PDF → 文字 · HTML → PDF |
| 編輯 | 浮水印（文字/圖片、透明度、角度、九宮格位置、平鋪、上/下層）· 頁碼（多種格式、起始值、跳過封面）· 頁首頁尾 · 文件資訊（編輯或全部清除） |
| 安全 | 加密（AES-256/128、開啟密碼、權限密碼、8 種權限開關）· 解除密碼 |

全部工具共通：
- 頁碼範圍語法：`1-3, 5, 8-`、`odd`、`even`、`last`、`3-1`（倒序）
- 加密的 PDF 直接在檔案列輸入密碼即可用在任何工具
- 單檔工具可一次丟多個檔案批次處理
- 結果可「接著用」下一個工具，不必重新上傳

## 訪客模式 vs 登入

| | 訪客（不用登入） | 登入 |
|---|---|---|
| 在哪裡運算 | **訪客自己的瀏覽器**（pdf-lib + pdf.js），檔案完全不上傳 | 你的伺服器（PyMuPDF），檔案只放在記憶體 |
| 可用工具 | 14 種：合併、整理頁面、分割、旋轉、刪除頁、多頁合一、裁切、圖片↔PDF、轉文字、浮水印、頁碼、頁首頁尾、文件資訊 | 全部 22 種，另外有壓縮、灰階、扁平化、修復、加密、解密、擷取內嵌圖片、HTML→PDF |
| 限制 | 文字戳記只支援英數字、不能處理加密檔、合併不建書籤 | 無 |

就算有人猜你的密碼，訪客能用的功能也完全不會用到伺服器資源。所有 `/api/run`、`/api/info`、`/api/thumbs` 沒登入都會回 401（測試裡有驗證）。

## 隱私設計

- 上傳的內容保留在 RAM 裡（Starlette 預設會把 >1 MB 的上傳暫存到磁碟，這裡把門檻調高，所以不會寫入暫存檔）
- 沒有資料庫，沒有上傳資料夾，也不記錄檔案內容
- 回應帶 `Cache-Control: no-store`
- 唯一會寫入的檔案是 `.env`（帳號 + PBKDF2 密碼雜湊 + session 金鑰），已列在 git-ignore

> 說明：這是一個**自架伺服器**，不是只在瀏覽器裡跑的網頁。你的手機連到你自己的電腦，所以檔案只會經過你的網路和你的機器，不會送到第三方。

## 從其他裝置使用

| 情境 | 做法 |
|---|---|
| 同一個 Wi-Fi | 開 `區網` 那個網址。Windows 第一次會跳防火牆提示，選「允許私人網路」 |
| 外出時 | 建議裝 [Tailscale](https://tailscale.com)（免費，不用開 port），用 `http://<電腦的 tailscale IP>:8765` 連 |
| 公開網址 | `cloudflared tunnel --url http://localhost:8765`，或用下面的 Docker 部署到雲端 |
| 手機桌面捷徑 | 用瀏覽器開啟後選「加到主畫面」（有 PWA manifest） |

## Docker / 雲端部署

```bash
docker build -t pdftool .
docker run -p 8765:8765 -e PDFTOOL_PASSWORD='你的密碼' -e PDFTOOL_SECRET="$(openssl rand -hex 32)" pdftool
```

有 HTTPS 時（Render、Fly.io、Railway、或 reverse proxy 後面）再加上 `-e PDFTOOL_HTTPS=on`，cookie 就會設 Secure。

## 設定（`.env`）

| 變數 | 預設 | 說明 |
|---|---|---|
| `PDFTOOL_USER` | `admin` | 帳號 |
| `PDFTOOL_PASSWORD_HASH` | 自動產生 | 由 `passwd` 指令寫入 |
| `PDFTOOL_PASSWORD` | – | 直接給明文密碼（適合 Docker），啟動時才雜湊 |
| `PDFTOOL_SECRET` | 自動產生 | session cookie 簽章金鑰 |
| `PDFTOOL_AUTH` | `on` | `off` 關閉登入（只建議搭配 `--host 127.0.0.1`） |
| `PDFTOOL_SESSION_DAYS` | `30` | 登入維持天數 |
| `PDFTOOL_MAX_UPLOAD_MB` | `512` | 單一檔案上限 |
| `PDFTOOL_HTTPS` | off | HTTPS 部署時開啟 |

連續登入失敗 8 次會鎖該 IP 10 分鐘。

## 開發

```bash
pip install -r requirements-dev.txt
pytest
```

結構：

```
app/
  ops.py       所有 PDF 運算（bytes 進 → bytes 出，PyMuPDF）
  main.py      FastAPI：登入、/api/run/{tool}、縮圖、資訊
  auth.py      PBKDF2 密碼、.env、登入節流
  __main__.py  啟動器（印出區網網址、自動選 port、passwd 指令）
  static/      前端（原生 JS，不需 build）
tests/         API 測試，涵蓋每個工具
```

整合自舊腳本：`decrypt.py`、`code2.py`（解密）、`testtest.py`（PyQt 解密/壓縮/圖轉 PDF/合併）、`pdfmerger.py`、`PDFtool/pdfmerge.py`（合併）、`imagetopdf.py`、`trans.py`（圖片轉 A4 PDF）、`C2H.py`（HTML→PDF，改用 MuPDF Story，不用再裝 weasyprint/GTK）。
