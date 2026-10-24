"""Guardas de despliegue: versiones parcheadas y ausencia de URL financieras en logs."""

import json
from importlib.metadata import version
from pathlib import Path

from packaging.version import Version

ROOT = Path(__file__).resolve().parent.parent


def test_starlette_has_patched_range_and_host_handling():
    # GHSA-7f5h-v6xp-fcq8 y GHSA-86qp-5c8j-p5mr.
    assert Version(version("starlette")) >= Version("1.0.1")


def test_default_server_does_not_write_sensitive_access_urls():
    source = (ROOT / "Dockerfile").read_text(encoding="utf-8")
    command_line = next(line for line in source.splitlines() if line.startswith("CMD ["))
    command = json.loads(command_line.removeprefix("CMD "))
    assert "--no-access-log" in command


def test_runtime_versions_match_committed_constraints():
    lock = ROOT / "requirements.lock"
    assert lock.is_file(), "Faltan las versiones transitivas fijadas"
    for line in lock.read_text(encoding="utf-8").splitlines():
        if not line or line.startswith("#"):
            continue
        package, expected_version = line.split("==", 1)
        assert version(package) == expected_version
