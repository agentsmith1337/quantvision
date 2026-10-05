"""The engine's access to the SDK's pure-Python modules (charges, ledger).

They live in sdk/quantvision so backtests (which run in the script environment) and the engine
compute charges and trades identically. The engine loads the files directly instead of importing
the `quantvision` package, which also pulls in pandas-ta and other script-only dependencies.
"""

import importlib.util
import sys
from types import ModuleType

from app.scripts.runtime import SDK_DIR


def _load(name: str) -> ModuleType:
    module_name = f"qv_sdk_{name}"
    if module_name in sys.modules:
        return sys.modules[module_name]
    spec = importlib.util.spec_from_file_location(module_name, SDK_DIR / "quantvision" / f"{name}.py")
    module = importlib.util.module_from_spec(spec)
    sys.modules[module_name] = module  # dataclasses look their module up while being created
    spec.loader.exec_module(module)
    return module


charges = _load("charges")
ledger = _load("ledger")
