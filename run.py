"""Start QuantVision locally.

    python run.py            build the UI if needed, start the engine, open the browser
    python run.py --build    force a fresh UI build first
    python run.py --dev      hot-reload mode: `next dev` on :3000 + uvicorn --reload on :8000

Works with any Python 3.12+; the backend itself runs inside backend/.venv.
"""

import argparse
import os
import shutil
import subprocess
import sys
import threading
import time
import urllib.request
import venv
import webbrowser
from pathlib import Path

ROOT = Path(__file__).resolve().parent
BACKEND = ROOT / "backend"
FRONTEND = ROOT / "frontend"
VENV = BACKEND / ".venv"
VENV_PY = VENV / ("Scripts/python.exe" if os.name == "nt" else "bin/python")


def ensure_backend_env() -> None:
    if not VENV_PY.exists():
        print("Creating backend virtual environment…")
        venv.create(VENV, with_pip=True)
        subprocess.check_call([VENV_PY, "-m", "pip", "install", "-r", BACKEND / "requirements.txt"])


def npm(*args: str) -> None:
    exe = shutil.which("npm")
    if exe is None:
        sys.exit("npm not found. Install Node.js 20+ to build the UI.")
    subprocess.check_call([exe, *args], cwd=FRONTEND)


UI_SOURCES = ["src", "public", "scripts", "next.config.ts", "package.json", "package-lock.json", "postcss.config.mjs", "tsconfig.json"]


def ui_build_is_stale() -> bool:
    built = FRONTEND / "out" / "index.html"
    if not built.exists():
        return True
    built_at = built.stat().st_mtime
    for name in UI_SOURCES:
        path = FRONTEND / name
        files = path.rglob("*") if path.is_dir() else [path]
        if any(f.is_file() and f.stat().st_mtime > built_at for f in files):
            return True
    return False


def ensure_frontend_build(force: bool) -> None:
    if not (FRONTEND / "node_modules").exists():
        print("Installing UI dependencies…")
        npm("ci")
    if force or ui_build_is_stale():
        print("Building UI…")
        npm("run", "build")


def open_when_ready(url: str, health_url: str) -> None:
    def wait_and_open() -> None:
        for _ in range(60):
            try:
                urllib.request.urlopen(health_url, timeout=1)
                webbrowser.open(url)
                return
            except OSError:
                time.sleep(0.5)

    threading.Thread(target=wait_and_open, daemon=True).start()


def main() -> None:
    parser = argparse.ArgumentParser(description="Run QuantVision locally")
    parser.add_argument("--dev", action="store_true", help="hot-reload frontend and backend")
    parser.add_argument("--build", action="store_true", help="rebuild the UI before starting")
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--no-browser", action="store_true")
    args = parser.parse_args()

    ensure_backend_env()
    # Bind to loopback only: the engine holds broker sessions and must not be reachable from the network.
    uvicorn = [VENV_PY, "-m", "uvicorn", "app.main:app", "--host", "127.0.0.1", "--port", str(args.port)]
    health = f"http://127.0.0.1:{args.port}/api/health"

    if args.dev:
        if not (FRONTEND / "node_modules").exists():
            npm("ci")
        ui = subprocess.Popen([shutil.which("npm"), "run", "dev"], cwd=FRONTEND)
        api = subprocess.Popen([*uvicorn, "--reload"], cwd=BACKEND)
        if not args.no_browser:
            open_when_ready("http://localhost:3000", health)
        procs = [ui, api]
    else:
        ensure_frontend_build(args.build)
        api = subprocess.Popen(uvicorn, cwd=BACKEND)
        if not args.no_browser:
            open_when_ready(f"http://127.0.0.1:{args.port}", health)
        print(f"QuantVision running at http://127.0.0.1:{args.port}  (Ctrl+C to stop)")
        procs = [api]

    try:
        while all(p.poll() is None for p in procs):
            time.sleep(0.5)
    except KeyboardInterrupt:
        pass
    finally:
        for p in procs:
            if p.poll() is None:
                p.terminate()
        for p in procs:
            try:
                p.wait(timeout=10)
            except subprocess.TimeoutExpired:
                p.kill()


if __name__ == "__main__":
    main()
