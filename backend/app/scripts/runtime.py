"""The isolated Python environment user scripts run in (QV_HOME/runtime/venv).

Kept separate from the engine's own environment so scripts can't break it, and
created on first use with the pinned packages in sdk/runtime-requirements.txt.
"""

import hashlib
import logging
import os
import subprocess
import threading
import venv
from pathlib import Path

log = logging.getLogger(__name__)

SDK_DIR = Path(__file__).resolve().parents[2] / "sdk"
REQUIREMENTS = SDK_DIR / "runtime-requirements.txt"
NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)


class ScriptRuntime:
    def __init__(self, root: Path) -> None:
        self.root = root
        # Tests (and developers) can point scripts at an existing interpreter instead.
        self._override = os.getenv("QV_SCRIPT_PYTHON")
        self.venv = root / "venv"
        self._marker = root / "installed.sha256"
        self._lock = threading.Lock()
        self.state = "unknown"  # missing | installing | ready | error
        self.message = ""

    @property
    def python(self) -> Path:
        if self._override:
            return Path(self._override)
        return self.venv / ("Scripts/python.exe" if os.name == "nt" else "bin/python")

    def _wanted(self) -> str:
        return hashlib.sha256(REQUIREMENTS.read_bytes()).hexdigest()

    def check(self) -> str:
        if self._override:
            self.state = "ready"
            return self.state
        with self._lock:
            if self.state != "installing":
                ok = self.python.exists() and self._marker.exists() and self._marker.read_text().strip() == self._wanted()
                self.state = "ready" if ok else ("error" if self.state == "error" else "missing")
            return self.state

    def status(self) -> dict:
        self.check()
        return {"state": self.state, "message": self.message, "path": str(self.venv)}

    def ensure(self, background: bool = True) -> None:
        """Install (or upgrade) the environment if it isn't ready."""
        if self.check() in ("ready", "installing"):
            return
        with self._lock:
            self.state, self.message = "installing", "Setting up the script environment (one-time, about a minute)…"
        if background:
            threading.Thread(target=self._install, name="script-runtime", daemon=True).start()
        else:
            self._install()

    def _install(self) -> None:
        try:
            self.root.mkdir(parents=True, exist_ok=True)
            if not self.python.exists():
                log.info("creating script runtime at %s", self.venv)
                venv.create(self.venv, with_pip=True)
            subprocess.run(
                [str(self.python), "-m", "pip", "install", "--disable-pip-version-check", "-q", "-r", str(REQUIREMENTS)],
                check=True, capture_output=True, text=True, creationflags=NO_WINDOW, timeout=900,
            )
            self._marker.write_text(self._wanted())
            with self._lock:
                self.state, self.message = "ready", ""
            log.info("script runtime ready")
        except subprocess.CalledProcessError as e:
            tail = (e.stderr or e.stdout or "").strip().splitlines()[-3:]
            self._fail("Installing script packages failed: " + " ".join(tail))
        except Exception as e:
            self._fail(f"Setting up the script environment failed: {e}")

    def _fail(self, message: str) -> None:
        log.error(message)
        with self._lock:
            self.state, self.message = "error", message

    def child_env(self) -> dict[str, str]:
        """Environment for a script process: no credentials, SDK importable."""
        keep = ("SYSTEMROOT", "WINDIR", "TEMP", "TMP", "PATH", "PATHEXT", "COMSPEC", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "LOCALAPPDATA", "APPDATA", "HOME", "LANG")
        env = {k: v for k, v in os.environ.items() if k.upper() in keep}
        env.update({"PYTHONPATH": str(SDK_DIR), "PYTHONIOENCODING": "utf-8", "PYTHONUNBUFFERED": "1", "PYTHONDONTWRITEBYTECODE": "1"})
        return env
