"""Regresiones del rango de un día: datos sintéticos, sin llamar al banco."""

from pathlib import Path
import sys
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import app as app_module


@pytest.mark.parametrize("day", ["2026-10-07", "2028-02-29", "2026-12-31"])
@pytest.mark.parametrize("path,detailed", [
    ("/api/movimientos/123456", False),
    ("/api/movimientos/123456", True),
    ("/api/movimientos-detalle/123456", True),
])
def test_same_day_queries_include_every_hour_without_a_hidden_type_filter(monkeypatch, day, path, detailed):
    client = SimpleNamespace(
        consultar_movimientos=AsyncMock(return_value=[]),
        consultar_movimientos_detallados=AsyncMock(return_value=[]),
    )
    monkeypatch.setattr(app_module, "_INTERNAL_API_KEY", None)
    monkeypatch.setattr(app_module, "_get_offset", lambda: "-03:00")
    monkeypatch.setitem(app_module.app.dependency_overrides, app_module.get_atlas_client, lambda: client)

    response = TestClient(app_module.app).get(path, params={
        "fecInicio": day, "fecFin": day, "detallado": str(detailed).lower(),
    })

    assert response.status_code == 200
    method = client.consultar_movimientos_detallados if detailed else client.consultar_movimientos
    args = method.await_args.kwargs
    assert args["fec_inicio"] == f"{day}T00:00:00-03:00"
    assert args["fec_fin"] == f"{day}T23:59:59-03:00"
    assert args["tipo_movimiento"] is None
