"""Tests para el adaptador Atlas Connect.

Cubre:
  - Generación y validación de JWT RS-256 con headers y claims obligatorios
    (política 2026: exp/jti/iss/sub/aud/iat), incluido content-hash en POST.
  - Saldo con ejemplo del manual v0.9 (incluye saldoBloqueado/saldoProtegido).
  - Movimientos detallados con ejemplo del manual v1.1 (fecha Proceso).
  - Alias (v0.1): éxito y campo obligatorio ausente.
  - Catálogos de Transferencias v1.4: entidades, documentos, motivos.
  - Registro y consulta de Operación SIPAP (v1.4).
  - Validación de cuenta y rango de fechas inválidos.
  - Error oficial 400 del banco.
  - Éxito de saldo y movimientos con detallado=true.
  - MEDIO-02: Validación RSA-4096 (política 2026), incluida clave 2048 insuficiente.
  - BLOQUEANTE-02: Campos obligatorios ausentes → ATLAS_CONTRACT_ERROR.
  - MEDIO-03: Readiness endpoint.
  - MEDIO-01: Contrato de errores unificado.
"""

import json
import sys
from pathlib import Path
from typing import Any

ROOT_DIR = Path(__file__).resolve().parent.parent
if str(ROOT_DIR) not in sys.path:
    sys.path.insert(0, str(ROOT_DIR))

import pytest
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.hazmat.primitives import serialization
import jwt
from unittest.mock import AsyncMock, patch

from api_atlas import (
    AtlasClient,
    AtlasSettings,
    AtlasApiError,
    AtlasContractError,
    _validate_rsa_private_key,
    _parse_saldo_response,
    _parse_alias_response,
    _normalize_movement,
)
from fastapi.testclient import TestClient
from app import ProductoResponse, app


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture(scope="session")
def rsa_keys():
    # Política 2026: la clave RSA de la aplicación debe ser de 4096 bits.
    private_key = rsa.generate_private_key(
        public_exponent=65537,
        key_size=4096,
    )
    pem = private_key.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    ).decode("utf-8")

    pub_pem = private_key.public_key().public_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PublicFormat.SubjectPublicKeyInfo,
    ).decode("utf-8")

    return pem, pub_pem


@pytest.fixture
def atlas_client(rsa_keys):
    pem, _ = rsa_keys
    settings = AtlasSettings(
        _env_file=None,
        ATLAS_BASE_URL="https://secure.atlas.com.py/api2-n/cuentas-atlas",
        ATLAS_TRANSFERENCIAS_BASE_URL="https://secure.atlas.com.py/api2-n/transferencias-atlas",
        ATLAS_DATOS_GENERALES_BASE_URL="https://secure.atlas.com.py/api2-n/datos-generales-atlas",
        ATLAS_API_KEY="test-api-key-123",
        ATLAS_ACCOUNT_AUTH_TOKEN="test-auth-token-xyz",
        ATLAS_PRIVATE_KEY_PEM=pem,
        ATLAS_TIMESTAMP_OFFSET="-03:00",
        ATLAS_JWT_USER="usuario_test",
        ATLAS_JWT_ISS="APPTEST",
        ATLAS_JWT_SUB="APPTEST",
        ATLAS_VERIFY_RESPONSE=False,
    )
    return AtlasClient(settings=settings)


def test_official_production_roots_are_the_defaults(rsa_keys, monkeypatch):
    """Cada API usa la raíz productiva y su familia oficial de servicio."""
    pem, _ = rsa_keys
    for name in (
        "ATLAS_BASE_URL",
        "ATLAS_TRANSFERENCIAS_BASE_URL",
        "ATLAS_DATOS_GENERALES_BASE_URL",
    ):
        monkeypatch.delenv(name, raising=False)
    settings = AtlasSettings(
        _env_file=None,
        ATLAS_API_KEY="test-api-key",
        ATLAS_ACCOUNT_AUTH_TOKEN="test-auth",
        ATLAS_PRIVATE_KEY_PEM=pem,
        ATLAS_JWT_ISS="APPTEST",
        ATLAS_JWT_SUB="APPTEST",
    )

    assert settings.base_url == "https://secure.atlas.com.py/api2-n/cuentas-atlas"
    assert settings.transferencias_base_url == (
        "https://secure.atlas.com.py/api2-n/transferencias-atlas"
    )
    assert settings.datos_generales_base_url == (
        "https://secure.atlas.com.py/api2-n/datos-generales-atlas"
    )


@pytest.mark.parametrize(
    "base_attr,resource,expected",
    [
        ("datos_generales_base_url", "/documentos", "/api2-n/datos-generales-atlas/documentos"),
        ("datos_generales_base_url", "/bancos_participante", "/api2-n/datos-generales-atlas/bancos_participante"),
        ("transferencias_base_url", "/sipap/consultar-operacion", "/api2-n/transferencias-atlas/sipap/consultar-operacion"),
        ("transferencias_base_url", "/sipap/consultar-operaciones", "/api2-n/transferencias-atlas/sipap/consultar-operaciones"),
        ("transferencias_base_url", "/sipap/registrar-operacion", "/api2-n/transferencias-atlas/sipap/registrar-operacion"),
        ("base_url", "/cuentas/123456/movimientos", "/api2-n/cuentas-atlas/cuentas/123456/movimientos"),
        ("base_url", "/cuentas/123456/saldo", "/api2-n/cuentas-atlas/cuentas/123456/saldo"),
        ("base_url", "/cuentas/123456/movimientos-detalle", "/api2-n/cuentas-atlas/cuentas/123456/movimientos-detalle"),
        ("base_url", "/cuentas/cas/obt-cta-by-alias", "/api2-n/cuentas-atlas/cuentas/cas/obt-cta-by-alias"),
        ("datos_generales_base_url", "/motivos_transferencia", "/api2-n/datos-generales-atlas/motivos_transferencia"),
    ],
)
def test_official_production_service_urls(atlas_client, base_attr, resource, expected):
    from urllib.parse import urlsplit

    full_url = f"{getattr(atlas_client.settings, base_attr)}{resource}"
    parsed = urlsplit(full_url)

    assert parsed.scheme == "https"
    assert parsed.netloc == "secure.atlas.com.py"
    assert parsed.path == expected


@pytest.fixture
def strict_atlas_client(atlas_client):
    """Mismo cliente de prueba, con el perfil productivo estricto habilitado."""
    previous = atlas_client.settings.verify_response
    atlas_client.settings.verify_response = True
    try:
        yield atlas_client
    finally:
        atlas_client.settings.verify_response = previous


@pytest.fixture(autouse=True)
def override_get_atlas_client(atlas_client):
    from app import get_atlas_client
    app.dependency_overrides[get_atlas_client] = lambda: atlas_client
    yield
    app.dependency_overrides.clear()


# ---------------------------------------------------------------------------
# Tests existentes (actualizados)
# ---------------------------------------------------------------------------

def test_jwt_generation_and_headers(atlas_client, rsa_keys):
    from api_atlas import AUD_CUENTAS

    _, pub_pem = rsa_keys
    resource = "/cuentas/123456/saldo"
    headers = atlas_client._headers(resource, AUD_CUENTAS)

    assert headers["Accept"] == "application/json"
    assert headers["X-RshkMichi-ApiKey"] == "test-api-key-123"
    # Los manuales definen X-Atl-Timestamp en UTC y todos sus ejemplos usan +00:00.
    assert headers["X-Atl-Timestamp"].endswith("+00:00")
    # Un GET no lleva Content-Type porque no tiene cuerpo.
    assert "Content-Type" not in headers

    token = headers["X-Atl-Auth"]
    decoded = jwt.decode(token, pub_pem, algorithms=["RS256"], audience=AUD_CUENTAS)

    assert decoded["resource"] == resource
    assert decoded["auth"] == "test-auth-token-xyz"
    assert decoded["time"] == headers["X-Atl-Timestamp"]
    assert decoded["user"] == "usuario_test"
    # El banco envía content-hash vacío también en los GET.
    assert decoded["content-hash"] == ""

    # Política 2026: claims JWT obligatorios.
    assert decoded["aud"] == AUD_CUENTAS
    assert decoded["iss"] == "APPTEST"
    assert decoded["sub"] == "APPTEST"
    assert "jti" in decoded and decoded["jti"]
    assert decoded["exp"] > decoded["iat"]
    assert decoded["exp"] - decoded["iat"] == atlas_client.settings.jwt_exp_seconds


def test_jwt_content_hash_included_for_documented_post(atlas_client, rsa_keys):
    """El único POST documentado firma el SHA256 del cuerpo exacto."""
    import hashlib

    from api_atlas import AUD_TRANSFERENCIAS

    _, pub_pem = rsa_keys
    expected_hash = hashlib.sha256(b'{"monto":2}').hexdigest()
    headers = atlas_client._headers(
        "/sipap/registrar-operacion",
        AUD_TRANSFERENCIAS,
        content_hash=expected_hash,
    )
    decoded = jwt.decode(
        headers["X-Atl-Auth"],
        pub_pem,
        algorithms=["RS256"],
        audience=AUD_TRANSFERENCIAS,
    )

    assert decoded["content-hash"] == expected_hash
    assert headers["Content-Type"] == "application/json"


@pytest.mark.asyncio
async def test_consultar_saldo_pdf_example(atlas_client):
    mock_bank_response = {
        "nroCuenta": "123456",
        "producto": {
            "codigo": 41,
            "descripcion": "CUENTAS CORRIENTES",
            "descripcionCorta": "CC",
        },
        "moneda": "PYG",
        "saldo": 5000000,
        "depositoConfirmar": 0,
        "saldoDisponible": 5000000,
        "saldoPromedio": 0,
        "infoAdicional": {
            "monto_mov_pendientes": 0,
            "dias_sobregiro": 22,
            "linea_sobregiro": 30000000,
            "liquidacion_sobregiro": 150000,
        },
    }

    with patch.object(atlas_client, "_get", new_callable=AsyncMock) as mock_get:
        mock_get.return_value = mock_bank_response
        result = await atlas_client.consultar_saldo("123456")

        from api_atlas import AUD_CUENTAS

        mock_get.assert_called_once_with(atlas_client.settings.base_url, "/cuentas/123456/saldo", AUD_CUENTAS)
        assert result["nroCuenta"] == "123456"
        assert result["saldo"] == 5000000
        assert result["saldoDisponible"] == 5000000
        assert result["depositoConfirmar"] == 0
        assert result["saldoPromedio"] == 0
        assert result["producto"]["codigo"] == 41
        assert result["producto"]["descripcion"] == "CUENTAS CORRIENTES"
        assert result["infoAdicional"]["linea_sobregiro"] == 30000000


@pytest.mark.asyncio
async def test_consultar_movimientos_detallados_pdf_example(atlas_client):
    mock_bank_response = {
        "listaMovimiento": [
            {
                "monto": 20000,
                "numeroCuenta": "123456",
                "moneda": {
                    "nombre": "Guaraníes",
                    "codigo": 6900,
                    "iso": "PYG",
                    "simbolo": "Gs",
                    "abreviatura": "GS",
                },
                "concepto": "TRANSFERENCIAS ENTRE CUENTAS",
                "tipoMovimiento": "CREDITO",
                "fechaMovimiento": "2020-12-24T07:44:08-03:00",
                "nroDocumento": 106188,
                "nroTransaccionBancard": 1234567,
                "infoAdicional": {
                    "estado": "N",
                    "cod_usuario": "HOMEBAN1",
                    "usu_insercion": "HOMEBAN1",
                    "reversado": "N",
                    "cod_usu_reversion": None,
                    "cod_tra_padre": 388.0,
                    "des_tra_padre": "TRANSFERENCIAS ENTRE CUENTAS",
                    "cod_transaccion": 602.0,
                    "des_transaccion": "CREDITO EN CUENTA AHORROS",
                    "nro_doc_remitente": "987654-3",
                    "nom_remitente": "USUARIO DE PRUEBA",
                    "nro_cta_remitente": "111666",
                    "concepto": "ayuda",
                },
                "fechaProceso": "2023-06-10",
            }
        ]
    }

    with patch.object(atlas_client, "_get", new_callable=AsyncMock) as mock_get:
        mock_get.return_value = mock_bank_response
        result = await atlas_client.consultar_movimientos_detallados(
            numero_cuenta="123456",
            fec_inicio="2020-12-01T00:00:00-03:00",
            fec_fin="2020-12-25T00:00:00-03:00",
            incluye_reversa=True,
        )

        mock_get.assert_called_once()
        base_url, resource, aud, params = mock_get.call_args[0]
        assert resource == "/cuentas/123456/movimientos-detalle"
        assert params["incluyeReversa"] == "true"

        assert len(result) == 1
        mov = result[0]
        assert mov["monto"] == 20000
        assert mov["moneda"] == "PYG"
        assert mov["tipoMovimiento"] == "CREDITO"
        assert mov["nroTransaccionBancard"] == 1234567
        assert mov["infoAdicional"]["nom_remitente"] == "USUARIO DE PRUEBA"
        assert mov["infoAdicional"]["nro_doc_remitente"] == "987654-3"
        assert mov["infoAdicional"]["nro_cta_remitente"] == "111666"


def test_fastapi_endpoints_validation():
    client = TestClient(app)

    # Validación cuenta inválida — contrato unificado (MEDIO-01)
    resp = client.get("/api/saldo/cuenta-invalida")
    assert resp.status_code == 400
    body = resp.json()
    assert body["code"] == "INVALID_ACCOUNT"
    assert "message" in body

    # Validación rango de fechas inválido
    resp = client.get("/api/movimientos/123456?fecInicio=2026-06-20&fecFin=2026-06-10")
    assert resp.status_code == 400
    body = resp.json()
    assert body["code"] == "INVALID_DATE_RANGE"


from app import app, get_atlas_client


def test_fastapi_movimientos_detalle_and_error_handling(atlas_client):
    app.dependency_overrides[get_atlas_client] = lambda: atlas_client
    client = TestClient(app)

    # Simular error 400 devuelto por el banco según especificación oficial
    mock_error_resp = AtlasApiError(
        status_code=400,
        message="El contexto no tiene token de acceso (access_token)",
        details={
            "code": "g1011",
            "message": "El contexto no tiene token de acceso (access_token)",
            "type": "APPLICATION",
            "useApiMessage": True,
        },
    )

    with patch.object(atlas_client, "consultar_movimientos_detallados", new_callable=AsyncMock) as mock_mov:
        mock_mov.side_effect = mock_error_resp

        resp = client.get("/api/movimientos-detalle/123456?fecInicio=2026-06-01&fecFin=2026-06-15")
        assert resp.status_code == 400
        data = resp.json()
        # MEDIO-01: Contrato unificado — campos directos, no envueltos en "detail"
        assert data["code"] == "g1011"
        assert "access_token" in data["message"]
        assert data["type"] == "APPLICATION"
        assert data["useApiMessage"] is True


def test_fastapi_saldo_endpoint_success(atlas_client):
    client = TestClient(app)
    mock_payload = {
        "nroCuenta": "123456",
        "producto": {"codigo": 41, "descripcion": "CUENTAS CORRIENTES", "descripcionCorta": "CC"},
        "saldo": 5000000,
        "saldoDisponible": 5000000,
        "depositoConfirmar": 0,
        "saldoPromedio": 0,
        "moneda": "PYG",
        "infoAdicional": {"linea_sobregiro": 30000000},
    }

    with patch.object(atlas_client, "consultar_saldo", new_callable=AsyncMock) as mock_saldo:
        mock_saldo.return_value = mock_payload

        resp = client.get("/api/saldo/123456")
        assert resp.status_code == 200
        body = resp.json()
        assert body["nroCuenta"] == "123456"
        assert body["producto"]["descripcion"] == "CUENTAS CORRIENTES"
        assert body["saldo"] == 5000000
        assert body["saldoDisponible"] == 5000000


def test_fastapi_movimientos_endpoint_with_detallado(atlas_client):
    client = TestClient(app)
    mock_item = {
        "monto": 750000,
        "numeroCuenta": "123456",
        "moneda": "PYG",
        "concepto": "TRANSFERENCIA SIPAP",
        "tipoMovimiento": "CREDITO",
        "fechaMovimiento": "2026-06-17T10:00:00-03:00",
        "fechaProceso": "2026-06-17",
        "nroDocumento": 998877,
        "nroTransaccionBancard": 554433,
        "infoAdicional": {
            "nom_remitente": "JUAN PEREZ",
            "nro_doc_remitente": "1234567-8",
            "nro_cta_remitente": "999888",
            "reversado": "N",
        },
    }

    with patch.object(atlas_client, "consultar_movimientos_detallados", new_callable=AsyncMock) as mock_det:
        mock_det.return_value = [mock_item]

        resp = client.get("/api/movimientos/123456?fecInicio=2026-06-01&fecFin=2026-06-17&detallado=true&incluyeReversa=true")
        assert resp.status_code == 200
        items = resp.json()["listaMovimiento"]
        assert len(items) == 1
        assert items[0]["infoAdicional"]["nom_remitente"] == "JUAN PEREZ"
        assert items[0]["nroTransaccionBancard"] == 554433


# ---------------------------------------------------------------------------
# NUEVOS TESTS
# ---------------------------------------------------------------------------

# --- MEDIO-02: Validación RSA-4096 negativa (política 2026) ---

def test_rsa_key_too_small_raises():
    """Una clave RSA de 1024 bits debe ser rechazada al arranque."""
    small_key = rsa.generate_private_key(
        public_exponent=65537,
        key_size=1024,
    )
    small_pem = small_key.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    ).decode("utf-8")

    with pytest.raises(RuntimeError, match="1024 bits"):
        _validate_rsa_private_key(small_pem)


def test_rsa_key_2048_now_insufficient_raises():
    """Política 2026: una clave RSA de 2048 bits ya no alcanza el mínimo (4096)."""
    key_2048 = rsa.generate_private_key(
        public_exponent=65537,
        key_size=2048,
    )
    pem_2048 = key_2048.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    ).decode("utf-8")

    with pytest.raises(RuntimeError, match="4096"):
        _validate_rsa_private_key(pem_2048)


def test_rsa_key_4096_ok(rsa_keys):
    """Una clave RSA de 4096 bits debe pasar la validación (política 2026)."""
    pem, _ = rsa_keys
    # No debe lanzar excepción
    _validate_rsa_private_key(pem)


# --- BLOQUEANTE-02: Campos obligatorios ausentes ---

def test_saldo_missing_producto_raises():
    """Respuesta de saldo sin campo 'producto' debe lanzar AtlasContractError."""
    data = {
        "nroCuenta": "123456",
        "moneda": "PYG",
        "saldo": 5000000,
        "saldoDisponible": 5000000,
        # falta "producto"
    }
    with pytest.raises(AtlasContractError, match="producto"):
        _parse_saldo_response(data, "123456")


def test_saldo_missing_saldo_field_raises():
    """Respuesta de saldo sin campo 'saldo' debe lanzar AtlasContractError."""
    data = {
        "nroCuenta": "123456",
        "producto": {"codigo": 41, "descripcion": "CC", "descripcionCorta": "CC"},
        "moneda": "PYG",
        "saldoDisponible": 5000000,
        # falta "saldo"
    }
    with pytest.raises(AtlasContractError, match="saldo"):
        _parse_saldo_response(data, "123456")


def test_movement_missing_monto_raises():
    """Movimiento sin campo 'monto' debe lanzar AtlasContractError."""
    item = {
        "numeroCuenta": "123456",
        "moneda": "PYG",
        "concepto": "TEST",
        "tipoMovimiento": "D",
        "fechaMovimiento": "2026-06-01T10:00:00-03:00",
        # falta "monto"
    }
    with pytest.raises(AtlasContractError, match="monto"):
        _normalize_movement(item)


def test_movement_missing_concepto_raises():
    """Movimiento sin campo 'concepto' debe lanzar AtlasContractError."""
    item = {
        "monto": 1000,
        "numeroCuenta": "123456",
        "moneda": "PYG",
        "tipoMovimiento": "D",
        "fechaMovimiento": "2026-06-01T10:00:00-03:00",
        # falta "concepto"
    }
    with pytest.raises(AtlasContractError, match="concepto"):
        _normalize_movement(item)


# --- MEDIO-03: Readiness endpoint ---

def test_readiness_without_env():
    """El endpoint /api/ready debe reportar el estado de la configuración."""
    client = TestClient(app)
    resp = client.get("/api/ready")
    body = resp.json()
    assert "status" in body
    assert "checks" in body
    # En un entorno de test puede ser 200 o 503 dependiendo del .env
    assert resp.status_code in (200, 503)


def test_health_always_ok():
    """El endpoint /api/health siempre retorna 200."""
    client = TestClient(app)
    resp = client.get("/api/health")
    assert resp.status_code == 200
    assert resp.json()["status"] == "ok"


def test_fastapi_contract_has_only_the_documented_post_route():
    """El correo de Atlas enumera un único POST: registrar operación SIPAP."""
    post_paths = sorted(
        route.path
        for route in app.routes
        if "POST" in getattr(route, "methods", set())
    )

    assert post_paths == ["/api/transferencias/sipap/registrar-operacion"]


# --- MEDIO-01: Contrato de errores unificado ---

def test_error_contract_has_code_and_message():
    """Todos los errores de validación deben retornar code + message sin envolver en 'detail'."""
    client = TestClient(app)

    resp = client.get("/api/saldo/abc-invalid")
    assert resp.status_code == 400
    body = resp.json()
    # Contrato unificado: code y message en raíz, no en "detail"
    assert "code" in body
    assert "message" in body
    assert "detail" not in body


def test_atlas_contract_error_endpoint(atlas_client):
    """Un AtlasContractError debe retornar 502 con code=ATLAS_CONTRACT_ERROR."""
    client = TestClient(app)

    with patch.object(atlas_client, "consultar_saldo", new_callable=AsyncMock) as mock_saldo:
        mock_saldo.side_effect = AtlasContractError("producto", "saldo")

        resp = client.get("/api/saldo/123456")
        assert resp.status_code == 502
        body = resp.json()
        assert body["code"] == "ATLAS_CONTRACT_ERROR"
        assert "producto" in body["message"]


# ---------------------------------------------------------------------------
# Política 2026 — armonización de las 4 especificaciones vigentes
# ---------------------------------------------------------------------------

# --- Saldo v0.9: nuevos campos saldoBloqueado / saldoProtegido ---

def test_saldo_v09_extra_fields_preserved():
    """El manual v0.9 agrega saldoBloqueado y saldoProtegido a la respuesta."""
    data = {
        "nroCuenta": "1262291",
        "producto": {"codigo": 31, "descripcion": "AHORROS A LA VISTA", "descripcionCorta": "AH"},
        "moneda": "PYG",
        "saldo": 90255165,
        "depositoConfirmar": 0,
        "saldoDisponible": 90256665,
        "saldoBloqueado": -20000,
        "saldoProtegido": 0,
        "saldoPromedio": 4566740261.44,
        "infoAdicional": {
            "monto_mov_pendiente_asincronos": 1500,
            "monto_mov_pendiente_infonet": 2444565356,
        },
    }
    result = _parse_saldo_response(data, "1262291")
    assert result["saldoBloqueado"] == -20000
    assert result["saldoProtegido"] == 0
    assert result["infoAdicional"]["monto_mov_pendiente_asincronos"] == 1500


def test_saldo_payload_real_del_banco(atlas_client):
    """Respuesta textual del sandbox para la cuenta 1870227 (2026-09-18).

    El banco envía saldoPromedio y varios infoAdicional en null. Declararlos como
    int|float hacía que FastAPI rechazara su propia respuesta y devolviera 500.
    """
    payload = {
        "nroCuenta": "1870227",
        "producto": {"codigo": 41, "descripcion": "CUENTAS CORRIENTES", "descripcionCorta": "CC"},
        "moneda": "PYG",
        "saldo": 0,
        "depositoConfirmar": 0,
        "saldoDisponible": 0,
        "saldoBloqueado": 0,
        "saldoProtegido": 0,
        "saldoPromedio": None,
        "infoAdicional": {
            "monto_mov_pendientes": None,
            "tipo_sobregiro": None,
            "dias_mora": 0,
            "dias_sobregiro": 0,
            "linea_sobregiro": 0,
            "monto_mov_pendiente_asincronos": 0,
            "liquidacion_sobregiro": 0,
            "monto_mov_pendiente_infonet": None,
        },
    }

    parsed = _parse_saldo_response(payload, "1870227")
    assert parsed["saldoPromedio"] is None

    client = TestClient(app)
    with patch.object(atlas_client, "consultar_saldo", new_callable=AsyncMock) as mock_saldo:
        mock_saldo.return_value = parsed
        resp = client.get("/api/saldo/1870227")

    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["saldoPromedio"] is None
    assert body["producto"]["descripcionCorta"] == "CC"


def test_producto_descripcion_corta_nula_no_rompe():
    """El banco envía descripcionCorta en null en varios objetos."""
    parsed = _parse_saldo_response(
        {
            "nroCuenta": "1870227",
            "producto": {"codigo": 41, "descripcion": "CUENTAS CORRIENTES", "descripcionCorta": None},
            "moneda": "PYG",
            "saldo": 0,
            "saldoDisponible": 0,
        },
        "1870227",
    )
    assert parsed["producto"]["descripcionCorta"] is None
    assert ProductoResponse(**parsed["producto"]).descripcionCorta is None


def test_saldo_missing_saldo_bloqueado_is_none_not_zero():
    """Ausencia no debe fallar, pero tampoco convertirse en 0: un saldo bloqueado
    no informado mostrado como cero afirmaría que no hay fondos retenidos."""
    data = {
        "nroCuenta": "123456",
        "producto": {"codigo": 41, "descripcion": "CC", "descripcionCorta": "CC"},
        "moneda": "PYG",
        "saldo": 5000000,
        "saldoDisponible": 5000000,
    }
    result = _parse_saldo_response(data, "123456")
    assert result["saldoBloqueado"] is None
    assert result["saldoProtegido"] is None


# --- Movimientos v1.1: clave "fecha Proceso" (con espacio) ---

def test_movement_accepts_fecha_proceso_with_space():
    """El manual v1.1 usa la clave literal 'fecha Proceso' en sus ejemplos."""
    item = {
        "monto": 20000,
        "numeroCuenta": "123456",
        "moneda": "PYG",
        "concepto": "TRANSFERENCIAS ENTRE CUENTAS",
        "tipoMovimiento": "DEBITO",
        "fechaMovimiento": "2020-12-24T07:44:08-03:00",
        "fecha Proceso": "2023-06-10",
    }
    result = _normalize_movement(item)
    assert result["fechaProceso"] == "2023-06-10"


# --- Alias v0.1 ---

@pytest.mark.asyncio
async def test_consultar_alias_pdf_example(atlas_client):
    mock_bank_response = {
        "entidad": {"codigo": "BNITPYPA", "descripcion": "BANCO ATLAS S.A.", "descripcionCorta": None},
        "nroCuenta": "1021841",
        "moneda": {"nombre": "Guaranies", "codigo": 6900, "iso": "PYG", "simbolo": "Gs", "abreviatura": "GS"},
        "denominacion": "PERSONA NRO 544572",
        "tipoDocumento": {"codigo": "1", "descripcion": "CEDULA DE IDENTIDAD", "descripcionCorta": None},
        "nroDocumento": "5100159",
    }

    with patch.object(atlas_client, "_get", new_callable=AsyncMock) as mock_get:
        mock_get.return_value = mock_bank_response
        result = await atlas_client.consultar_alias(tipo="CI", alias="5100159")

        from api_atlas import AUD_CUENTAS

        base_url, resource, aud, params = mock_get.call_args[0]
        assert resource == "/cuentas/cas/obt-cta-by-alias"
        assert aud == AUD_CUENTAS
        assert params == {"tipo": "CI", "alias": "5100159"}
        assert result["nroCuenta"] == "1021841"
        assert result["entidad"]["codigo"] == "BNITPYPA"
        assert result["tipoDocumento"]["descripcion"] == "CEDULA DE IDENTIDAD"


def test_alias_missing_entidad_raises():
    data = {
        "nroCuenta": "1021841",
        "moneda": {"iso": "PYG"},
        "denominacion": "PERSONA NRO 544572",
        "tipoDocumento": {"codigo": "1"},
        "nroDocumento": "5100159",
        # falta "entidad"
    }
    with pytest.raises(AtlasContractError, match="entidad"):
        _parse_alias_response(data)


def test_fastapi_alias_endpoint_success(atlas_client):
    client = TestClient(app)
    mock_payload = {
        "entidad": {"codigo": "BNITPYPA", "descripcion": "BANCO ATLAS S.A.", "descripcionCorta": None},
        "nroCuenta": "1021841",
        "moneda": {"nombre": "Guaranies", "codigo": 6900, "iso": "PYG", "simbolo": "Gs", "abreviatura": "GS"},
        "denominacion": "PERSONA NRO 544572",
        "tipoDocumento": {"codigo": "1", "descripcion": "CEDULA DE IDENTIDAD", "descripcionCorta": None},
        "nroDocumento": "5100159",
    }

    with patch.object(atlas_client, "consultar_alias", new_callable=AsyncMock) as mock_alias:
        mock_alias.return_value = mock_payload

        resp = client.get("/api/alias?tipo=CI&alias=5100159")
        assert resp.status_code == 200
        body = resp.json()
        assert body["nroCuenta"] == "1021841"
        mock_alias.assert_called_once_with(tipo="CI", alias="5100159", cod_swift=None)


# --- API de Transferencias v1.4: catálogos ---

@pytest.mark.asyncio
async def test_consultar_entidades_participantes(atlas_client):
    mock_bank_response = {
        "listaDatos": [
            {"codigo": "AMAMPYPA", "descripcion": "BANCO BASA SA", "descripcionCorta": "BASA"},
            {"codigo": "BCNAPYPA", "descripcion": "BANCO CONTINENTAL SAECA", "descripcionCorta": "CONTINENTAL"},
        ]
    }
    with patch.object(atlas_client, "_get", new_callable=AsyncMock) as mock_get:
        mock_get.return_value = mock_bank_response
        result = await atlas_client.consultar_entidades_participantes()

        from api_atlas import AUD_DATOS_GENERALES

        base_url, resource, aud = mock_get.call_args[0]
        assert base_url == atlas_client.settings.datos_generales_base_url
        assert resource == "/bancos_participante"
        assert aud == AUD_DATOS_GENERALES
        assert len(result) == 2
        assert result[0]["codigo"] == "AMAMPYPA"


@pytest.mark.asyncio
async def test_consultar_motivos_missing_lista_datos_raises(atlas_client):
    with patch.object(atlas_client, "_get", new_callable=AsyncMock) as mock_get:
        mock_get.return_value = {}
        with pytest.raises(AtlasContractError, match="listaDatos"):
            await atlas_client.consultar_motivos()


def test_fastapi_tipos_documentos_endpoint(atlas_client):
    client = TestClient(app)
    with patch.object(atlas_client, "consultar_tipos_documentos", new_callable=AsyncMock) as mock_tipos:
        mock_tipos.return_value = [{"codigo": "1", "descripcion": "CI", "descripcionCorta": "CEDULA DE IDENTIDAD"}]

        resp = client.get("/api/transferencias/tipos-documentos")
        assert resp.status_code == 200
        assert resp.json()["listaDatos"][0]["codigo"] == "1"


# --- API de Transferencias v1.4: registro SIPAP ---

@pytest.mark.asyncio
async def test_registrar_operacion_sipap_routes_documented_post(strict_atlas_client):
    operacion = {"monto": 2, "concepto": "Prueba controlada"}
    mock_bank_response = {
        "respuesta": {"estado": "OK", "mensaje": None},
        "datosOperacion": {"nroReferencia": 74, "situacion": "P", "estado": "s"},
    }

    with patch.object(strict_atlas_client, "_post", new_callable=AsyncMock) as mock_post:
        mock_post.return_value = mock_bank_response
        result = await strict_atlas_client.registrar_operacion_sipap(operacion)

    from api_atlas import AUD_TRANSFERENCIAS

    base_url, resource, aud, body = mock_post.call_args[0]
    assert base_url == strict_atlas_client.settings.transferencias_base_url
    assert resource == "/sipap/registrar-operacion"
    assert aud == AUD_TRANSFERENCIAS
    assert body == operacion
    assert result["respuesta"]["estado"] == "OK"
    assert result["datosOperacion"]["nroReferencia"] == 74
    assert result["datosOperacion"]["clasificacion"] == "INTERMEDIO"


def test_registrar_operacion_sipap_missing_respuesta_raises():
    from api_atlas import _parse_registro_sipap_response

    with pytest.raises(AtlasContractError, match="respuesta"):
        _parse_registro_sipap_response({"datosOperacion": {}})


@pytest.mark.asyncio
async def test_post_computes_sha256_of_exact_body(atlas_client, rsa_keys):
    """El JWT firma exactamente los bytes JSON enviados por HTTP."""
    import hashlib

    from api_atlas import AUD_TRANSFERENCIAS

    _, pub_pem = rsa_keys
    captured: dict[str, Any] = {}

    class _FakeResponse:
        status_code = 200
        headers: dict[str, str] = {}
        content = b"{}"

        def json(self):
            return {"respuesta": {"estado": "OK"}, "datosOperacion": {}}

    class _FakeAsyncClient:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *exc):
            return False

        async def post(self, url, headers=None, content=None):
            captured["url"] = url
            captured["content"] = content
            captured["headers"] = headers
            return _FakeResponse()

    with patch("api_atlas.httpx.AsyncClient", return_value=_FakeAsyncClient()):
        await atlas_client._post(
            atlas_client.settings.transferencias_base_url,
            "/sipap/registrar-operacion",
            AUD_TRANSFERENCIAS,
            {"monto": 2, "concepto": "Test"},
        )

    decoded = jwt.decode(
        captured["headers"]["X-Atl-Auth"],
        pub_pem,
        algorithms=["RS256"],
        audience=AUD_TRANSFERENCIAS,
    )
    assert captured["url"] == (
        f"{atlas_client.settings.transferencias_base_url}/sipap/registrar-operacion"
    )
    assert decoded["content-hash"] == hashlib.sha256(captured["content"]).hexdigest()


# ---------------------------------------------------------------------------
# BLOQUEANTE-01 — Verificación del JWT firmado por el banco
# ---------------------------------------------------------------------------

@pytest.fixture(scope="session")
def bank_keys():
    """Par de claves que simula al banco firmando su respuesta."""
    key = rsa.generate_private_key(public_exponent=65537, key_size=4096)
    priv = key.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    ).decode("utf-8")
    pub = key.public_key().public_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PublicFormat.SubjectPublicKeyInfo,
    ).decode("utf-8")
    return priv, pub


def _bank_response(bank_priv, body: bytes, aud: str = "cuentas-atlas", **overrides):
    """Respuesta del banco: JWT con los mismos claims del recibido (incluido aud)
    y content-hash del cuerpo, firmado con la clave del banco."""
    import hashlib
    import time as time_module

    now = int(time_module.time())
    claims = {
        "time": "2026-09-18T10:00:00+00:00",
        "resource": "/cuentas/123456/saldo",
        "auth": "test-auth-token-xyz",
        "content-hash": hashlib.sha256(body).hexdigest(),
        "exp": now + 60,
        "jti": "123",
        "iss": "APPTEST",
        "sub": "APPTEST",
        "aud": aud,
        "iat": now,
    }
    claims.update(overrides)

    class _Resp:
        status_code = 200
        headers = {"X-Atl-Auth": jwt.encode(claims, bank_priv, algorithm="RS256")}
        content = body

    return _Resp()


def _client_verifying(rsa_keys, bank_pub):
    pem, _ = rsa_keys
    return AtlasClient(settings=AtlasSettings(
        _env_file=None,
        ATLAS_API_KEY="k",
        ATLAS_ACCOUNT_AUTH_TOKEN="test-auth-token-xyz",
        ATLAS_PRIVATE_KEY_PEM=pem,
        ATLAS_JWT_ISS="APPTEST",
        ATLAS_JWT_SUB="APPTEST",
        ATLAS_BANK_PUBLIC_KEY_PEM=bank_pub,
        ATLAS_VERIFY_RESPONSE=True,
    ))


def test_bank_response_with_aud_claim_verifies(rsa_keys, bank_keys):
    """Regresión: el JWT del banco replica los claims enviados, por lo que incluye
    `aud`. PyJWT rechaza un token con `aud` si no se le pasa la audiencia esperada,
    lo que hacía fallar TODA respuesta con ATLAS_VERIFY_RESPONSE=true."""
    bank_priv, bank_pub = bank_keys
    client = _client_verifying(rsa_keys, bank_pub)
    body = b'{"nroCuenta":"123456","saldo":5000000}'

    # No debe lanzar excepción.
    client._verify_response_integrity(_bank_response(bank_priv, body), "cuentas-atlas")


def test_bank_response_without_aud_claim_fails_when_bound_to_request(rsa_keys, bank_keys):
    """Producción exige que la respuesta replique el `aud` de la solicitud."""
    from api_atlas import AtlasIntegrityError

    bank_priv, bank_pub = bank_keys
    client = _client_verifying(rsa_keys, bank_pub)
    body = b'{"nroCuenta":"123456"}'

    response = _bank_response(bank_priv, body)
    import jwt as jwt_lib

    claims = jwt_lib.decode(response.headers["X-Atl-Auth"], bank_pub, algorithms=["RS256"], audience="cuentas-atlas")
    claims.pop("aud")
    response.headers = {"X-Atl-Auth": jwt_lib.encode(claims, bank_priv, algorithm="RS256")}

    with pytest.raises(AtlasIntegrityError, match="aud"):
        client._verify_response_integrity(
            response,
            "cuentas-atlas",
            expected_claims={"aud": "cuentas-atlas"},
        )


def test_bank_response_unsigned_alg_none_is_rejected(rsa_keys, bank_keys):
    """Un JWT con alg=none no lleva firma y no autentica la respuesta: aceptarlo
    sería el ataque clásico de JWT. El sandbox de Atlas responde así hoy."""
    from api_atlas import AtlasIntegrityError

    _, bank_pub = bank_keys
    client = _client_verifying(rsa_keys, bank_pub)
    body = b'{"saldo":0}'

    import base64 as b64
    import hashlib as hl

    def seg(obj):
        return b64.urlsafe_b64encode(json.dumps(obj).encode()).rstrip(b"=").decode()

    sin_firma = f'{seg({"alg": "none"})}.{seg({"content-hash": hl.sha256(body).hexdigest()})}.'

    class _Resp:
        status_code = 200
        headers = {"X-Atl-Auth": sin_firma}
        content = body

    with pytest.raises(AtlasIntegrityError, match="sin firma"):
        client._verify_response_integrity(_Resp(), "cuentas-atlas")


def test_bank_response_tampered_body_fails(rsa_keys, bank_keys):
    """Cuerpo alterado tras la firma → content-hash no coincide."""
    from api_atlas import AtlasIntegrityError

    bank_priv, bank_pub = bank_keys
    client = _client_verifying(rsa_keys, bank_pub)

    response = _bank_response(bank_priv, b'{"saldo":5000000}')
    response.content = b'{"saldo":9999999}'  # alterado

    with pytest.raises(AtlasIntegrityError, match="content-hash"):
        client._verify_response_integrity(response, "cuentas-atlas")


def test_bank_response_wrong_audience_fails(rsa_keys, bank_keys):
    """Un token emitido para otro servicio no debe aceptarse."""
    from api_atlas import AtlasIntegrityError

    bank_priv, bank_pub = bank_keys
    client = _client_verifying(rsa_keys, bank_pub)
    response = _bank_response(bank_priv, b"{}", aud="transferencias-atlas")

    with pytest.raises(AtlasIntegrityError):
        client._verify_response_integrity(response, "cuentas-atlas")


def test_bank_response_foreign_signature_fails(rsa_keys, bank_keys):
    """Un token firmado con otra clave privada no debe aceptarse."""
    from api_atlas import AtlasIntegrityError

    _, bank_pub = bank_keys
    impostor = rsa.generate_private_key(public_exponent=65537, key_size=4096).private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    ).decode("utf-8")

    client = _client_verifying(rsa_keys, bank_pub)
    response = _bank_response(impostor, b"{}")

    with pytest.raises(AtlasIntegrityError):
        client._verify_response_integrity(response, "cuentas-atlas")


def test_bank_response_missing_content_hash_fails(rsa_keys, bank_keys):
    """Una respuesta 2xx firmada pero sin hash no autentica su cuerpo."""
    from api_atlas import AtlasIntegrityError

    bank_priv, bank_pub = bank_keys
    client = _client_verifying(rsa_keys, bank_pub)
    response = _bank_response(bank_priv, b"{}", **{"content-hash": None})

    with pytest.raises(AtlasIntegrityError, match="content-hash"):
        client._verify_response_integrity(response, "cuentas-atlas")


def test_preproduction_can_disable_response_integrity(rsa_keys, bank_keys):
    """El perfil explícito de preproducción puede observar respuestas no firmadas.

    Esto nunca convierte la respuesta en verificada y no debe usarse como
    configuración de producción.
    """
    pem, _ = rsa_keys
    _, bank_pub = bank_keys
    client = AtlasClient(settings=AtlasSettings(
        _env_file=None,
        ATLAS_API_KEY="k",
        ATLAS_ACCOUNT_AUTH_TOKEN="test-auth-token-xyz",
        ATLAS_PRIVATE_KEY_PEM=pem,
        ATLAS_JWT_ISS="APPTEST",
        ATLAS_JWT_SUB="APPTEST",
        ATLAS_BANK_PUBLIC_KEY_PEM=bank_pub,
        ATLAS_VERIFY_RESPONSE=False,
    ))

    class _Resp:
        status_code = 200
        headers = {"X-Atl-Auth": "jwt-de-preproduccion-no-verificable"}
        content = b'{}'

    assert client._verify_response_integrity(_Resp(), "cuentas-atlas") is False


def test_response_integrity_defaults_to_strict(rsa_keys):
    """Omitir la variable no debe relajar accidentalmente una futura producción."""
    pem, _ = rsa_keys
    settings = AtlasSettings(
        _env_file=None,
        ATLAS_API_KEY="k",
        ATLAS_ACCOUNT_AUTH_TOKEN="auth",
        ATLAS_PRIVATE_KEY_PEM=pem,
        ATLAS_JWT_ISS="APPTEST",
        ATLAS_JWT_SUB="APPTEST",
    )

    assert settings.verify_response is True


@pytest.mark.asyncio
async def test_strict_get_rejects_unsigned_success(rsa_keys, bank_keys):
    """Relajar errores 401 no puede relajar una respuesta financiera exitosa."""
    _, bank_pub = bank_keys
    client = _client_verifying(rsa_keys, bank_pub)

    class _Resp:
        status_code = 200
        headers: dict[str, str] = {}
        content = b'{"ok":true}'

        def json(self):
            return {"ok": True}

    class _Http:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *exc):
            return False

        async def get(self, url, headers=None, params=None):
            return _Resp()

    from api_atlas import AtlasIntegrityError

    with patch("api_atlas.httpx.AsyncClient", return_value=_Http()):
        with pytest.raises(AtlasIntegrityError, match="X-Atl-Auth"):
            await client._get(client.settings.base_url, "/cuentas/123456/saldo", "cuentas-atlas")


@pytest.mark.asyncio
async def test_relaxed_get_accepts_unsigned_success(atlas_client):
    """El perfil pedido para preproducción permite observar el JSON 2xx."""
    class _Resp:
        status_code = 200
        headers: dict[str, str] = {}
        content = b'{"ok":true}'

        def json(self):
            return {"ok": True}

    class _Http:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *exc):
            return False

        async def get(self, url, headers=None, params=None):
            return _Resp()

    with patch("api_atlas.httpx.AsyncClient", return_value=_Http()):
        result = await atlas_client._get(
            atlas_client.settings.base_url,
            "/cuentas/123456/saldo",
            "cuentas-atlas",
        )

    assert result == {"ok": True}


@pytest.mark.asyncio
async def test_preproduction_cannot_register_sipap(atlas_client):
    """Las consultas se relajan, pero nunca el servicio que mueve dinero."""
    with patch.object(atlas_client, "_post", new_callable=AsyncMock) as mock_post:
        with pytest.raises(AtlasApiError) as exc_info:
            await atlas_client.registrar_operacion_sipap({"monto": 1})

    assert exc_info.value.status_code == 503
    assert exc_info.value.details["code"] == "PREPRODUCTION_READ_ONLY"
    mock_post.assert_not_awaited()


@pytest.mark.asyncio
async def test_strict_profile_can_parse_registrar_operacion(rsa_keys, bank_keys):
    """El cliente conserva el servicio documentado para una futura habilitación."""
    _, bank_pub = bank_keys
    client = _client_verifying(rsa_keys, bank_pub)
    payload = {
        "respuesta": {"estado": "OK"},
        "datosOperacion": {"nroReferencia": 74, "situacion": "P", "estado": "s"},
    }

    with patch.object(client, "_post", new_callable=AsyncMock) as mock_post:
        mock_post.return_value = payload
        result = await client.registrar_operacion_sipap({"monto": 2})

    assert result["datosOperacion"]["clasificacion"] == "INTERMEDIO"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "error",
    [
        AtlasApiError(502, "No se pudo conectar con Banco Atlas."),
        AtlasApiError(500, "Error interno", {"code": "g1000", "type": "INTERNAL"}),
        AtlasApiError(400, "Error interno", {"code": "g1000", "type": "APPLICATION"}),
        AtlasContractError("datosOperacion", "registrar-operacion"),
    ],
)
async def test_registrar_operacion_timeout_es_indeterminado(strict_atlas_client, error):
    """Un fallo técnico no autoriza a afirmar que el POST no fue procesado."""
    from api_atlas import AtlasOperacionIndeterminadaError

    with patch.object(strict_atlas_client, "_post", new_callable=AsyncMock) as mock_post:
        mock_post.side_effect = error

        with pytest.raises(AtlasOperacionIndeterminadaError) as exc_info:
            await strict_atlas_client.registrar_operacion_sipap({"monto": 2})

    assert exc_info.value.details["code"] == "ATLAS_OPERACION_INDETERMINADA"
    assert "No reversar" in exc_info.value.message


@pytest.mark.asyncio
async def test_registrar_operacion_error_de_negocio_se_propaga(strict_atlas_client):
    """Un rechazo 4xx de negocio sí es final y no se reclasifica."""
    from api_atlas import AtlasOperacionIndeterminadaError

    rechazo = AtlasApiError(
        400,
        "Operación rechazada.",
        {"code": "cm1200", "type": "APPLICATION", "useApiMessage": True},
    )

    with patch.object(strict_atlas_client, "_post", new_callable=AsyncMock) as mock_post:
        mock_post.side_effect = rechazo

        with pytest.raises(AtlasApiError) as exc_info:
            await strict_atlas_client.registrar_operacion_sipap({"monto": 2})

    assert not isinstance(exc_info.value, AtlasOperacionIndeterminadaError)
    assert exc_info.value.details["code"] == "cm1200"


def test_registrar_operacion_requiere_internal_api_key(strict_atlas_client):
    """El único endpoint que mueve dinero nunca queda abierto por defecto."""
    import app as app_module

    client = TestClient(app)
    body = {
        "moneda": {"nombre": "Guaraníes", "codigo": 6900, "abreviatura": "GS"},
        "monto": 2,
        "fechaOperacion": "2026-09-10T12:00:00-03:00",
        "codMotivo": "0",
        "codTipDocSolicitante": "1",
        "nroDocSolicitante": "1172044",
        "nomSolicitante": "TEST",
        "codSwiPteSolicitante": "BNITPYPAXXX",
        "nroCtaSolicitante": "1637515",
        "codTipDocBeneficiario": "1",
        "nroDocBeneficiario": "3330452",
        "nomBeneficiario": "TEST",
        "codSwiPteBeneficiario": "BNITPYPAXXX",
        "nroCtaBeneficiario": "1637515",
    }

    original = app_module._INTERNAL_API_KEY
    try:
        app_module._INTERNAL_API_KEY = None
        resp = client.post("/api/transferencias/sipap/registrar-operacion", json=body)
    finally:
        app_module._INTERNAL_API_KEY = original

    assert resp.status_code == 503
    assert resp.json()["code"] == "INTERNAL_AUTH_REQUIRED"


def test_monto_entero_no_se_convierte_en_float():
    """Serializar 2 como 2.0 cambiaría el cuerpo y el content-hash firmado."""
    from app import RegistrarOperacionSipapRequest

    modelo = RegistrarOperacionSipapRequest(
        moneda={"nombre": "Guaraníes", "codigo": 6900, "abreviatura": "GS"},
        monto=2,
        fechaOperacion="2026-09-10T12:00:00-03:00",
        codMotivo="0",
        codTipDocSolicitante="1",
        nroDocSolicitante="1172044",
        nomSolicitante="TEST",
        codSwiPteSolicitante="BNITPYPAXXX",
        nroCtaSolicitante="1637515",
        codTipDocBeneficiario="1",
        nroDocBeneficiario="3330452",
        nomBeneficiario="TEST",
        codSwiPteBeneficiario="BNITPYPAXXX",
        nroCtaBeneficiario="1637515",
    )

    assert isinstance(modelo.monto, int)


@pytest.mark.parametrize(
    "claim,overrides",
    [
        ("resource", {"resource": "/cuentas/otra/saldo"}),
        ("time", {"time": "2026-09-18T10:00:01+00:00"}),
        ("auth", {"auth": "otro-auth"}),
    ],
)
def test_bank_response_must_match_request_claims(rsa_keys, bank_keys, claim, overrides):
    """La firma sola no basta: la respuesta debe estar ligada a esta solicitud."""
    from api_atlas import AtlasIntegrityError

    bank_priv, bank_pub = bank_keys
    client = _client_verifying(rsa_keys, bank_pub)
    response = _bank_response(bank_priv, b"{}", **overrides)

    with pytest.raises(AtlasIntegrityError, match=claim):
        client._verify_response_integrity(
            response,
            "cuentas-atlas",
            expected_resource="/cuentas/123456/saldo",
            expected_timestamp="2026-09-18T10:00:00+00:00",
            expected_auth="test-auth-token-xyz",
        )


@pytest.mark.asyncio
async def test_unsigned_401_is_not_masked_as_integrity_error(rsa_keys, bank_keys):
    """Los rechazos de Atlas pueden omitir X-Atl-Auth.

    Deben conservar status/código para diagnóstico, sin convertirlos en un 502
    ni mostrar el mensaje upstream cuando useApiMessage=false.
    """
    bank_priv, bank_pub = bank_keys
    del bank_priv
    client = _client_verifying(rsa_keys, bank_pub)

    class _FakeResponse:
        status_code = 401
        headers: dict[str, str] = {}
        content = json.dumps(
            {
                "code": "cm1057",
                "message": "mensaje upstream que no debe mostrarse",
                "type": "SECURITY",
                "useApiMessage": False,
            }
        ).encode("utf-8")
        text = content.decode("utf-8")

        def json(self):
            return json.loads(self.content)

    class _FakeAsyncClient:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *exc):
            return False

        async def get(self, url, headers=None, params=None):
            return _FakeResponse()

    with patch("api_atlas.httpx.AsyncClient", return_value=_FakeAsyncClient()):
        with pytest.raises(AtlasApiError) as exc_info:
            await client._get(
                client.settings.base_url,
                "/cuentas/123456/saldo",
                "cuentas-atlas",
            )

    error = exc_info.value
    assert error.status_code == 401
    assert error.details["code"] == "cm1057"
    assert error.details["type"] == "SECURITY"
    assert error.details["useApiMessage"] is False
    assert error.details["upstreamIntegrityVerified"] is False
    assert "mensaje upstream" not in error.message
    assert "401" in error.message


def test_frontend_discards_legacy_sandbox_account_and_requires_manual_start():
    """El mismo origen no debe reusar una cuenta de laboratorio en producción."""
    source = (ROOT_DIR / "static" / "app.js").read_text(encoding="utf-8")

    assert 'const STORAGE_KEY = "atlas.buzon.production.v1";' in source
    assert 'const LEGACY_STORAGE_KEYS = Object.freeze(["atlas.buzon.v1"]);' in source
    assert "localStorage.removeItem(legacyKey)" in source
    assert "let queryActivated = false;" in source
    assert "!queryActivated" in source


def test_frontend_assets_are_revalidated_after_docker_rebuild():
    """Una imagen nueva no debe seguir ejecutando JavaScript viejo del navegador."""
    client = TestClient(app)

    root = client.get("/")
    script = client.get("/static/app.js")
    ready = client.get("/api/ready")

    assert root.status_code == 200
    assert '/static/app.js?v=' in root.text
    assert root.headers["cache-control"] == "no-cache"
    assert script.status_code == 200
    assert script.headers["cache-control"] == "no-cache"
    assert ready.headers["cache-control"] == "no-store, private"


def test_frontend_mode_banner_removed_without_changing_readiness_contract(atlas_client):
    """Cambio solicitado de presentación; no habilita verificación ni producción."""
    client = TestClient(app)
    root = client.get("/")
    assert "preproductionNotice" not in root.text
    assert "Modo preproducción" not in root.text
    with patch("app.AtlasSettings", return_value=atlas_client.settings):
        ready = client.get("/api/ready")
    assert ready.json()["checks"]["verify_response"] == "disabled"


def test_frontend_keeps_error_code_internal_for_diagnostics():
    """El operador pidió mensajes legibles; el diagnóstico conserva código/status."""
    source = (ROOT_DIR / "static" / "app.js").read_text(encoding="utf-8")

    assert "detail.code" in source
    assert "error.code = code" in source
    assert "error.status =" in source
    assert "[${code}]" not in source


def test_frontend_does_not_poll_after_an_initial_4xx():
    """Guardia estática complementaria a las regresiones de comportamiento Node."""
    source = (ROOT_DIR / "static" / "app.js").read_text(encoding="utf-8")
    failure_handler = source.split("const reportFailure =", 1)[1].split("try {", 1)[0]
    assert "queryActivated = false;" in failure_handler
    assert 'countdownEl.textContent = "--";' in failure_handler
    assert "if (balanceOk && movementsOk)" in source
    assert "if (!isCurrentQuery()) return;" in source


# ---------------------------------------------------------------------------
# v1.4 — "Recomendaciones para Implementación": indeterminación y matriz
# ---------------------------------------------------------------------------

@pytest.mark.parametrize(
    "situacion,estado,esperado",
    [
        ("L", "A", "OK"),
        ("Z", "E", "ERROR"),
        ("P", "E", "ERROR"),
        ("C", "C", "ERROR"),
        ("Z", "Z", "ERROR"),
        ("P", "A", "ERROR"),
        ("P", "S", "INTERMEDIO"),
        ("V", "S", "INDETERMINADO"),
        ("P", "s", "INTERMEDIO"),          # el manual devuelve "s" en minúscula
        ("X", "Q", "INDETERMINADO"),       # cualquier otra combinación
        (None, None, "INDETERMINADO"),
    ],
)
def test_matriz_situacion_estado(situacion, estado, esperado):
    from api_atlas import clasificar_operacion_sipap

    assert clasificar_operacion_sipap(situacion, estado) == esperado


@pytest.mark.asyncio
async def test_consultar_operacion_agrega_clasificacion(atlas_client):
    with patch.object(atlas_client, "_get", new_callable=AsyncMock) as mock_get:
        mock_get.return_value = {"nroReferencia": 221207432511, "situacion": "L", "estado": "A"}
        result = await atlas_client.consultar_operacion_sipap(nro_referencia=221207432511)

        assert result["clasificacion"] == "OK"
