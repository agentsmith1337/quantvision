from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException
from fastapi.concurrency import run_in_threadpool
from pydantic import BaseModel, Field

from app.scripts import service
from app.scripts.runtime import SDK_DIR
from app.scripts.store import ScriptError, check_syntax, script_defaults
from app.security import require_session

router = APIRouter(prefix="/api", dependencies=[Depends(require_session)])

REFERENCE = SDK_DIR / "sdk_reference.md"


def _err(e: Exception) -> HTTPException:
    if isinstance(e, FileNotFoundError):
        return HTTPException(404, f"No script named {e.args[0] if e.args else ''}")
    return HTTPException(400, str(e))


# --- scripts ------------------------------------------------------------------------------


@router.get("/scripts")
def list_scripts() -> list[dict]:
    return service.store.list()


@router.get("/scripts/reference")
def reference() -> dict:
    return {"markdown": Path(REFERENCE).read_text(encoding="utf-8")}


@router.get("/scripts/runtime")
def runtime_status() -> dict:
    return service.runtime.status()


@router.post("/scripts/runtime/install")
def install_runtime() -> dict:
    service.runtime.ensure()
    return service.runtime.status()


@router.get("/scripts/{name}")
def get_script(name: str) -> dict:
    try:
        content = service.store.read(name)
    except (ScriptError, FileNotFoundError) as e:
        raise _err(e) from e
    return {"name": name, "content": content, "defaults": script_defaults(content), "syntax_error": check_syntax(content, name)}


class ScriptBody(BaseModel):
    content: str = Field(max_length=256 * 1024)


@router.put("/scripts/{name}")
def save_script(name: str, body: ScriptBody) -> dict:
    try:
        service.store.write(name, body.content)
    except ScriptError as e:
        raise _err(e) from e
    return {"name": name, "defaults": script_defaults(body.content), "syntax_error": check_syntax(body.content, name)}


class RenameBody(BaseModel):
    new_name: str


@router.post("/scripts/{name}/rename")
def rename_script(name: str, body: RenameBody) -> dict:
    try:
        service.store.rename(name, body.new_name)
    except (ScriptError, FileNotFoundError) as e:
        raise _err(e) from e
    return {"name": body.new_name}


@router.delete("/scripts/{name}")
def delete_script(name: str) -> dict:
    if any(r.info.script == name for r in service.runs.active()):
        raise HTTPException(409, "Stop the script's running instance first")
    try:
        service.store.delete(name)
    except (ScriptError, FileNotFoundError) as e:
        raise _err(e) from e
    return {"deleted": name}


# --- runs -----------------------------------------------------------------------------------


class RunRequest(BaseModel):
    script: str
    symbols: list[str] = Field(min_length=1, max_length=20)
    interval: str = "5m"


@router.get("/runs")
def list_runs() -> list[dict]:
    return service.runs.list()


@router.post("/runs")
async def start_run(body: RunRequest) -> dict:
    try:
        info = await run_in_threadpool(service.runs.start, body.script, body.symbols, body.interval)
    except (ScriptError, FileNotFoundError) as e:
        raise _err(e) from e
    return info.to_dict()


@router.post("/runs/{run_id}/stop")
def stop_run(run_id: str) -> dict:
    try:
        service.runs.stop(run_id)
    except KeyError as e:
        raise HTTPException(404, "No such run") from e
    return {"stopping": run_id}


@router.get("/runs/{run_id}/logs")
def run_logs(run_id: str, after: int = 0) -> list[dict]:
    try:
        return service.runs.logs(run_id, after)
    except KeyError as e:
        raise HTTPException(404, "No such run") from e


@router.post("/kill-switch")
async def kill_switch() -> dict:
    """Stop every running script and cancel every open order."""
    return await run_in_threadpool(service.runs.kill_switch)
