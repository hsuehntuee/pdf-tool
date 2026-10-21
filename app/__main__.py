"""python -m app [--host 0.0.0.0] [--port 8765] [--no-browser] | python -m app passwd"""
from __future__ import annotations

import argparse
import getpass
import socket
import threading
import webbrowser


def lan_ips() -> list[str]:
    ips = set()
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(("10.255.255.255", 1))  # no packet is sent; just picks the outbound interface
            ips.add(s.getsockname()[0])
    except OSError:
        pass
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            ips.add(info[4][0])
    except OSError:
        pass
    return sorted(i for i in ips if not i.startswith("127."))


def free_port(host: str, port: int) -> int:
    """First port from `port` upward that nobody is listening on."""
    for p in range(port, port + 30):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            if s.connect_ex(("127.0.0.1", p)) == 0:
                continue  # someone answers here
            try:
                s2 = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
                s2.bind((host, p))
                s2.close()
                if p != port:
                    print(f"  (port {port} 已被占用，改用 {p})")
                return p
            except OSError:
                continue
    return port


def set_password() -> None:
    from .auth import ensure_config, hash_password, write_env

    ensure_config()
    user = input("帳號（Enter 保留 admin）: ").strip() or "admin"
    while True:
        pw = getpass.getpass("新密碼: ")
        if len(pw) < 6:
            print("至少 6 個字元")
            continue
        if pw != getpass.getpass("再輸入一次: "):
            print("兩次不一致")
            continue
        break
    write_env({"PDFTOOL_USER": user, "PDFTOOL_PASSWORD_HASH": hash_password(pw)})
    print("已更新 .env，重新啟動伺服器後生效。")


def main() -> None:
    ap = argparse.ArgumentParser(prog="pdftool")
    ap.add_argument("cmd", nargs="?", default="serve", choices=["serve", "passwd"])
    ap.add_argument("--host", default="0.0.0.0", help="0.0.0.0 = 同網路的手機/平板也能連；127.0.0.1 = 只限本機")
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--no-browser", action="store_true")
    args = ap.parse_args()

    if args.cmd == "passwd":
        set_password()
        return

    import uvicorn

    from .main import AUTH_ON, CONFIG, GENERATED_PASSWORD

    args.port = free_port(args.host, args.port)
    url = f"http://127.0.0.1:{args.port}"
    print("\n  ┌─ PDF Tool ─────────────────────────────────────")
    print(f"  │ 本機:   {url}")
    if args.host == "0.0.0.0":
        for ip in lan_ips():
            print(f"  │ 區網:   http://{ip}:{args.port}   ← 手機/平板連這個")
    if AUTH_ON:
        print(f"  │ 帳號:   {CONFIG['PDFTOOL_USER']}")
        if GENERATED_PASSWORD:
            print(f"  │ 密碼:   {GENERATED_PASSWORD}   ← 首次啟動自動產生，請記下來")
            print("  │         改密碼: run.bat passwd  (或 python -m app passwd)")
    else:
        print("  │ 登入:   已關閉 (PDFTOOL_AUTH=off)")
    print("  │ 檔案只在記憶體處理，不寫入硬碟。Ctrl+C 結束。")
    print("  └────────────────────────────────────────────────\n")

    if not args.no_browser:
        threading.Timer(1.2, lambda: webbrowser.open(url)).start()
    uvicorn.run("app.main:app", host=args.host, port=args.port, log_level="warning")


if __name__ == "__main__":
    main()
