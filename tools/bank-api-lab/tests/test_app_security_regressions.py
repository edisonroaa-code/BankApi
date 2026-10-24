"""Regresiones sintéticas del límite HTTP; no utilizan cuentas ni credenciales reales."""

import sys
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from fastapi.testclient import TestClient

ROOT_DIR = Path(__file__).resolve().parent.parent
if str(ROOT_DIR) not in sys.path:
    sys.path.insert(0, str(ROOT_DIR))

import app as app_module


@pytest.fixture
def local_client(monkeypatch):
    fake = SimpleNamespace(
        settings=SimpleNamespace(verify_response=False),
        consultar_saldo=AsyncMock(),
        consultar_alias=AsyncMock(),
        consultar_operaciones_sipap=AsyncMock(return_value={"operacionesSipap": []}),
    )
    monkeypatch.setattr(app_module, "_INTERNAL_API_KEY", None)
    previous = dict(app_module.app.dependency_overrides)
    app_module.app.dependency_overrides[app_module.get_atlas_client] = lambda: fake
    try:
        with TestClient(app_module.app, raise_server_exceptions=False) as client:
            yield client, fake
    finally:
        app_module.app.dependency_overrides.clear()
        app_module.app.dependency_overrides.update(previous)


def test_readiness_does_not_echo_settings_exception(local_client, monkeypatch):
    client, _ = local_client

    def bad_settings():
        raise ValueError("SYNTHETIC_SECRET_INVALID_CONFIGURATION")

    monkeypatch.setattr(app_module, "AtlasSettings", bad_settings)
    response = client.get("/api/ready")
    assert response.status_code == 503
    assert "SYNTHETIC_SECRET" not in response.text
    assert response.json()["status"] == "not_ready"


def test_readiness_does_not_echo_private_key_exception(local_client, monkeypatch):
    client, _ = local_client

    def bad_private_key():
        raise ValueError("SYNTHETIC_SECRET_PRIVATE_KEY")

    settings = SimpleNamespace(
        api_key="synthetic-api-key",
        account_auth_token="synthetic-auth",
        jwt_iss="synthetic-issuer",
        jwt_sub="synthetic-subject",
        verify_response=False,
        load_private_key=bad_private_key,
    )
    monkeypatch.setattr(app_module, "AtlasSettings", lambda: settings)
    response = client.get("/api/ready")
    assert response.status_code == 503
    assert "SYNTHETIC_SECRET" not in response.text


@pytest.mark.parametrize("bank_key", ["not-a-key-SYNTHETIC_SECRET", None])
def test_strict_readiness_validates_effective_bank_key(local_client, monkeypatch, bank_key):
    client, _ = local_client
    settings = SimpleNamespace(
        api_key="synthetic-api-key",
        account_auth_token="synthetic-auth",
        jwt_iss="synthetic-issuer",
        jwt_sub="synthetic-subject",
        verify_response=True,
        load_private_key=lambda: "validated-by-settings",
        load_bank_public_key=lambda: bank_key,
    )
    monkeypatch.setattr(app_module, "AtlasSettings", lambda: settings)
    response = client.get("/api/ready")
    assert response.status_code == 503
    assert "SYNTHETIC_SECRET" not in response.text
    assert response.json()["checks"]["bank_public_key"] in {"missing", "invalid"}


def test_internal_auth_does_not_parse_untrusted_host(local_client, monkeypatch):
    client, fake = local_client
    monkeypatch.setattr(app_module, "_INTERNAL_API_KEY", "synthetic-internal-key")
    response = client.get("/api/saldo/123456", headers={"Host": "["})
    assert response.status_code == 401
    assert response.headers["Cache-Control"] == "no-store, private"
    fake.consultar_saldo.assert_not_awaited()


def test_auth_exemptions_require_actual_public_paths(local_client, monkeypatch):
    client, _ = local_client
    monkeypatch.setattr(app_module, "_INTERNAL_API_KEY", "synthetic-internal-key")
    response = client.get("/docs-financial-data")
    assert response.status_code == 401


def test_health_security_headers_do_not_parse_untrusted_host(local_client):
    client, _ = local_client
    response = client.get("/api/health", headers={"Host": "["})
    assert response.status_code == 200
    assert response.headers["Cache-Control"] == "no-store, private"
    assert response.headers["X-Content-Type-Options"] == "nosniff"


def test_unexpected_error_is_sanitized_and_keeps_security_headers(local_client):
    client, fake = local_client
    fake.consultar_saldo.side_effect = ValueError("SYNTHETIC_SECRET_INTERNAL_ERROR")
    response = client.get("/api/saldo/123456")
    assert response.status_code == 500
    assert response.headers["Cache-Control"] == "no-store, private"
    assert response.headers["X-Content-Type-Options"] == "nosniff"
    assert response.headers["X-Frame-Options"] == "DENY"
    assert response.json()["code"] == "INTERNAL_ERROR"
    assert "SYNTHETIC_SECRET" not in response.text


def test_unexpected_public_endpoint_error_is_also_no_store(local_client, monkeypatch):
    client, _ = local_client

    def broken_openapi():
        raise RuntimeError("SYNTHETIC_SECRET_PUBLIC_ERROR")

    monkeypatch.setattr(app_module.app, "openapi", broken_openapi)
    response = client.get("/openapi.json")
    assert response.status_code == 500
    assert response.headers["Cache-Control"] == "no-store, private"
    assert response.json()["code"] == "INTERNAL_ERROR"
    assert "SYNTHETIC_SECRET" not in response.text


def test_request_validation_contract_never_echoes_input(local_client):
    client, _ = local_client
    response = client.get(
        "/api/alias",
        params={"tipo": "SYNTHETIC_SECRET_INVALID_ALIAS_TYPE", "alias": "sample"},
    )
    assert response.status_code == 422
    assert "SYNTHETIC_SECRET" not in response.text
    assert response.json()["code"] == "VALIDATION_ERROR"
    assert response.headers["Cache-Control"] == "no-store, private"


@pytest.mark.parametrize(
    "params",
    [
        {"fechaDesde": "SYNTHETIC_SECRET_BAD_DATE"},
        {"fechaHasta": "2026-02-30"},
        {"fechaDesde": "2026-10-03", "fechaHasta": "2026-10-02"},
        {"fechaDesde": "2026-10-03T12:00:00-03:00", "fechaHasta": "2026-10-03T11:00:00-03:00"},
    ],
)
def test_sipap_invalid_dates_are_rejected_locally(local_client, params):
    client, fake = local_client
    response = client.get("/api/transferencias/sipap/consultar-operaciones", params=params)
    assert response.status_code == 400
    assert response.json()["code"] in {"INVALID_DATE", "INVALID_DATE_RANGE"}
    assert "SYNTHETIC_SECRET" not in response.text
    fake.consultar_operaciones_sipap.assert_not_awaited()


@pytest.mark.parametrize(
    "params",
    [
        {},
        {"fechaDesde": "2026-10-02"},
        {"fechaDesde": "2026-10-02", "fechaHasta": "2026-10-03"},
        {"fechaDesde": "2026-10-03T11:00:00-03:00", "fechaHasta": "2026-10-03T15:00:00Z"},
    ],
)
def test_sipap_valid_dates_remain_unchanged(local_client, params):
    client, fake = local_client
    response = client.get("/api/transferencias/sipap/consultar-operaciones", params=params)
    assert response.status_code == 200
    actual = fake.consultar_operaciones_sipap.call_args.kwargs
    assert actual["fecha_desde"] == params.get("fechaDesde")
    assert actual["fecha_hasta"] == params.get("fechaHasta")


def test_internal_settings_reads_dotenv_without_atlas_credentials(tmp_path, monkeypatch):
    monkeypatch.delenv("INTERNAL_API_KEY", raising=False)
    local_env = tmp_path / ".env"
    local_env.write_text("INTERNAL_API_KEY=synthetic-local-key\n", encoding="utf-8")
    settings = app_module.InternalSecuritySettings(_env_file=local_env)
    assert settings.internal_api_key == "synthetic-local-key"


def test_internal_settings_environment_overrides_dotenv(tmp_path, monkeypatch):
    local_env = tmp_path / ".env"
    local_env.write_text("INTERNAL_API_KEY=synthetic-local-key\n", encoding="utf-8")
    monkeypatch.setenv("INTERNAL_API_KEY", "synthetic-environment-key")
    settings = app_module.InternalSecuritySettings(_env_file=local_env)
    assert settings.internal_api_key == "synthetic-environment-key"


@pytest.mark.parametrize("field", ["fechaOperacion", "fecha"])
def test_sipap_registration_date_validation_does_not_echo_input(local_client, field):
    client, _ = local_client
    body = {
        "moneda": {"nombre": "Guaraníes", "codigo": 6900, "abreviatura": "GS"},
        "monto": 1,
        "fechaOperacion": "2026-10-03T12:00:00-03:00",
        "codMotivo": "0",
        "codTipDocSolicitante": "1",
        "nroDocSolicitante": "123456",
        "nomSolicitante": "SYNTHETIC",
        "codSwiPteSolicitante": "SYNTHETIC",
        "nroCtaSolicitante": "123456",
        "codTipDocBeneficiario": "1",
        "nroDocBeneficiario": "123456",
        "nomBeneficiario": "SYNTHETIC",
        "codSwiPteBeneficiario": "SYNTHETIC",
        "nroCtaBeneficiario": "123456",
    }
    body[field] = "SYNTHETIC_SECRET_BAD_DATE"
    response = client.post("/api/transferencias/sipap/registrar-operacion", json=body)
    assert response.status_code == 422
    assert response.json()["code"] == "VALIDATION_ERROR"
    assert "SYNTHETIC_SECRET" not in response.text
