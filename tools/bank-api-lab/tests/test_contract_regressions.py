"""Regression tests for untrusted balance/movement responses (synthetic data only).

Contract sources: balance v0.9 details/examples and movements v1.1 details.
No bank credentials, keys or network calls are required by this suite.
"""

from pathlib import Path
import sys
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

ROOT_DIR = Path(__file__).resolve().parent.parent
if str(ROOT_DIR) not in sys.path:
    sys.path.insert(0, str(ROOT_DIR))

from api_atlas import (
    AtlasClient,
    AtlasContractError,
    _normalize_movement,
    _parse_saldo_response,
)


ACCOUNT = "123456"


def balance_payload():
    return {
        "nroCuenta": ACCOUNT,
        "producto": {"codigo": 41, "descripcion": "CUENTA CORRIENTE", "descripcionCorta": "CC"},
        "moneda": "PYG",
        "saldo": 1000,
        "saldoDisponible": 950.5,
        "saldoPromedio": None,
        "infoAdicional": {"monto_mov_pendientes": None, "monto_mov_pendiente_asincronos": -49.5},
    }


def movement_payload():
    return {
        "numeroCuenta": ACCOUNT,
        "monto": 49.5,
        "moneda": {
            "nombre": "Guaraníes", "codigo": 6900, "iso": "PYG",
            "simbolo": "Gs", "abreviatura": "GS",
        },
        "concepto": "TRANSFERENCIA DE PRUEBA",
        "tipoMovimiento": "CREDITO",
        "fechaMovimiento": "2026-09-17T07:44:08.123-03:00",
        "fecha Proceso": "2026-09-17",
        "nroDocumento": 123,
        "nroTransaccionBancard": 0,
        "infoAdicional": {
            "reversado": "N", "cod_tra_padre": 388.0,
            "cod_transaccion": 602.0, "nro_doc_remitente": "123456-7",
            "nom_remitente": "REMITENTE DE PRUEBA", "nro_cta_remitente": "654321",
            "cod_usu_reversion": None,
        },
    }


def assert_contract_error(action):
    with pytest.raises(AtlasContractError) as caught:
        action()
    assert caught.value.status_code == 502
    assert caught.value.details["code"] == "ATLAS_CONTRACT_ERROR"
    return caught.value


@pytest.mark.parametrize("factory,parser,model_name", [
    (balance_payload, lambda payload: _parse_saldo_response(payload, ACCOUNT), "BalanceResponse"),
    (movement_payload, _normalize_movement, "MovementResponse"),
])
def test_whole_optional_metadata_null_survives_parser_and_http_model(factory, parser, model_name):
    import app as app_module

    payload = factory()
    payload["infoAdicional"] = None
    parsed = parser(payload)
    assert parsed["infoAdicional"] is None
    model = getattr(app_module, model_name).model_validate(parsed)
    assert model.model_dump()["infoAdicional"] is None


@pytest.mark.parametrize("official,alias", [
    ("2026-02-30", None),
    ("2026-02-30", "2026-09-17"),
    ("2026-09-17", "2026-02-30"),
    ("2026-09-17", "2026-09-18"),
    ("2026-09-17", None),
])
def test_process_date_alias_cannot_hide_invalid_or_conflicting_official_field(official, alias):
    payload = movement_payload()
    payload["fecha Proceso"] = official
    payload["fechaProceso"] = alias
    assert_contract_error(lambda: _normalize_movement(payload))


def test_identical_process_date_aliases_are_accepted():
    payload = movement_payload()
    payload["fechaProceso"] = payload["fecha Proceso"]
    assert _normalize_movement(payload)["fechaProceso"] == payload["fecha Proceso"]


@pytest.mark.parametrize("identity", [None, "", "654321", 123456, True, {}, []])
def test_balance_never_invents_or_coerces_account_identity(identity):
    payload = balance_payload()
    payload["nroCuenta"] = identity
    assert_contract_error(lambda: _parse_saldo_response(payload, ACCOUNT))


def test_balance_missing_account_does_not_fall_back_to_requested_account():
    payload = balance_payload()
    payload.pop("nroCuenta")
    assert_contract_error(lambda: _parse_saldo_response(payload, ACCOUNT))


@pytest.mark.parametrize("field", ["saldo", "saldoDisponible", "depositoConfirmar", "saldoBloqueado", "saldoProtegido", "saldoPromedio"])
@pytest.mark.parametrize("invalid", [True, "10.5", float("nan"), float("inf"), {}, []])
def test_balance_rejects_non_numeric_or_nonfinite_amounts(field, invalid):
    payload = balance_payload()
    payload[field] = invalid
    assert_contract_error(lambda: _parse_saldo_response(payload, ACCOUNT))


@pytest.mark.parametrize("invalid", [False, "100", float("nan"), float("-inf"), {}])
def test_balance_validates_documented_info_amounts(invalid):
    payload = balance_payload()
    payload["infoAdicional"]["monto_mov_pendiente_infonet"] = invalid
    assert_contract_error(lambda: _parse_saldo_response(payload, ACCOUNT))


@pytest.mark.parametrize("invalid", [[], False, "not an object"])
def test_balance_rejects_malformed_info_object(invalid):
    payload = balance_payload()
    payload["infoAdicional"] = invalid
    assert_contract_error(lambda: _parse_saldo_response(payload, ACCOUNT))


@pytest.mark.parametrize("field,invalid", [("codigo", True), ("codigo", "41"), ("codigo", 41.5), ("descripcion", {}), ("descripcion", ""), ("descripcionCorta", [])])
def test_balance_rejects_malformed_product_fields(field, invalid):
    payload = balance_payload()
    payload["producto"][field] = invalid
    assert_contract_error(lambda: _parse_saldo_response(payload, ACCOUNT))


@pytest.mark.parametrize("invalid", [False, "", "pyg", "PYG-invalid", [], {"iso": "PYG"}])
def test_balance_currency_must_be_an_iso_format_string(invalid):
    payload = balance_payload()
    payload["moneda"] = invalid
    assert_contract_error(lambda: _parse_saldo_response(payload, ACCOUNT))


def test_balance_keeps_manual_decimals_negative_amounts_arp_and_null_metadata():
    payload = balance_payload()
    payload["moneda"] = "ARP"  # Explicitly documented by Atlas, despite ISO naming.
    payload["saldoPromedio"] = 4566740261.44
    payload["saldoBloqueado"] = -20000
    payload["producto"]["descripcionCorta"] = None
    payload["infoAdicional"]["extraAudit"] = {"note": "synthetic"}
    parsed = _parse_saldo_response(payload, ACCOUNT)
    assert parsed["saldoPromedio"] == 4566740261.44
    assert parsed["saldoBloqueado"] == -20000
    assert parsed["saldoProtegido"] is None
    assert parsed["depositoConfirmar"] is None
    assert parsed["moneda"] == "ARP"
    assert parsed["producto"]["descripcionCorta"] is None
    assert parsed["infoAdicional"] == payload["infoAdicional"]


@pytest.mark.parametrize("invalid", [True, "49.5", float("nan"), float("inf"), {}, []])
def test_movement_rejects_non_numeric_or_nonfinite_amount(invalid):
    payload = movement_payload()
    payload["monto"] = invalid
    assert_contract_error(lambda: _normalize_movement(payload))


@pytest.mark.parametrize("invalid", [None, "", True, 123456, {}, []])
def test_movement_requires_string_account_identity(invalid):
    payload = movement_payload()
    payload["numeroCuenta"] = invalid
    assert_contract_error(lambda: _normalize_movement(payload))


@pytest.mark.parametrize("invalid", ["X", "", True, {}, []])
def test_movement_rejects_undocumented_movement_type(invalid):
    payload = movement_payload()
    payload["tipoMovimiento"] = invalid
    assert_contract_error(lambda: _normalize_movement(payload))


@pytest.mark.parametrize("invalid", ["", "not a date", "2026-02-30T10:00:00-03:00", "2026-09-17", "2026-09-17T10:00:00", True, {}])
def test_movement_requires_a_real_iso_datetime_with_offset(invalid):
    payload = movement_payload()
    payload["fechaMovimiento"] = invalid
    assert_contract_error(lambda: _normalize_movement(payload))


@pytest.mark.parametrize("invalid", ["2026-02-30", "n/a", False, {}])
def test_optional_process_date_is_validated_when_present(invalid):
    payload = movement_payload()
    payload["fecha Proceso"] = invalid
    assert_contract_error(lambda: _normalize_movement(payload))


@pytest.mark.parametrize("field,invalid", [("iso", True), ("iso", "pyg"), ("iso", "invalid"), ("codigo", False), ("codigo", "6900"), ("nombre", {}), ("abreviatura", [])])
def test_movement_currency_object_is_coherent(field, invalid):
    payload = movement_payload()
    payload["moneda"][field] = invalid
    assert_contract_error(lambda: _normalize_movement(payload))


def test_movement_rejects_incomplete_currency_object():
    payload = movement_payload()
    payload["moneda"] = {"iso": "PYG"}
    assert_contract_error(lambda: _normalize_movement(payload))


def test_movement_rejects_conflicting_documented_currency_code_and_iso():
    payload = movement_payload()
    payload["moneda"]["iso"] = "USD"
    assert_contract_error(lambda: _normalize_movement(payload))


@pytest.mark.parametrize("invalid", [True, {}, []])
def test_movement_does_not_stringify_a_malformed_concept(invalid):
    payload = movement_payload()
    payload["concepto"] = invalid
    assert_contract_error(lambda: _normalize_movement(payload))


@pytest.mark.parametrize("invalid", [[], False, "not an object"])
def test_movement_rejects_malformed_info_object(invalid):
    payload = movement_payload()
    payload["infoAdicional"] = invalid
    assert_contract_error(lambda: _normalize_movement(payload))


@pytest.mark.parametrize("field,invalid", [("cod_tra_padre", True), ("cod_transaccion", float("nan")), ("cod_transaccion", "not-an-integer"), ("nom_remitente", {}), ("reversado", False), ("reversado", "INVALID")])
def test_movement_validates_documented_info_fields(field, invalid):
    payload = movement_payload()
    payload["infoAdicional"][field] = invalid
    assert_contract_error(lambda: _normalize_movement(payload))


@pytest.mark.parametrize("parent_code,transaction_code", [
    ("388", "602"),
    ("388.0", "602.0"),
    (" 388.000 ", "\t602.0\n"),
    (388.0, "602"),
    ("388", 602.0),
    (None, "602"),
    ("388", None),
])
def test_movement_accepts_integral_audit_code_strings_without_rewriting_metadata(parent_code, transaction_code):
    payload = movement_payload()
    payload["infoAdicional"]["cod_tra_padre"] = parent_code
    payload["infoAdicional"]["cod_transaccion"] = transaction_code
    original_info = dict(payload["infoAdicional"])

    parsed = _normalize_movement(payload)

    assert parsed["infoAdicional"] == original_info
    assert parsed["infoAdicional"]["cod_tra_padre"] == parent_code
    assert parsed["infoAdicional"]["cod_transaccion"] == transaction_code


@pytest.mark.parametrize("field", ["cod_tra_padre", "cod_transaccion"])
@pytest.mark.parametrize("invalid", [
    True, False, float("nan"), float("inf"), float("-inf"), 388.5,
    "", " ", "not-an-integer", "NaN", "Inf", "388.5", "3e2", "-388", "٣٨٨", {}, [],
])
def test_movement_audit_code_compatibility_does_not_accept_invalid_values(field, invalid):
    payload = movement_payload()
    payload["infoAdicional"][field] = invalid
    assert_contract_error(lambda: _normalize_movement(payload))


def test_detailed_movements_http_200_uses_real_client_parser_for_string_audit_codes(monkeypatch):
    import app as app_module
    from fastapi.testclient import TestClient

    payload = movement_payload()
    payload["infoAdicional"]["cod_tra_padre"] = "388"
    payload["infoAdicional"]["cod_transaccion"] = "602.0"
    # Stub only bank transport: real client method, account binding and parser run.
    atlas_client = object.__new__(AtlasClient)
    atlas_client.settings = SimpleNamespace(base_url="https://example.invalid/cuentas-atlas")
    atlas_client._get = AsyncMock(return_value={"listaMovimiento": [payload]})
    monkeypatch.setattr(app_module, "_INTERNAL_API_KEY", None)
    monkeypatch.setattr(app_module, "_get_offset", lambda: "-03:00")
    previous_overrides = dict(app_module.app.dependency_overrides)
    app_module.app.dependency_overrides[app_module.get_atlas_client] = lambda: atlas_client
    try:
        with TestClient(app_module.app) as client:
            response = client.get(
                f"/api/movimientos-detalle/{ACCOUNT}",
                params={"fecInicio": "2026-09-17", "fecFin": "2026-09-17"},
            )
    finally:
        app_module.app.dependency_overrides.clear()
        app_module.app.dependency_overrides.update(previous_overrides)

    assert response.status_code == 200
    movements = response.json()["listaMovimiento"]
    assert len(movements) == 1
    assert movements[0]["monto"] == payload["monto"]
    assert movements[0]["infoAdicional"] == payload["infoAdicional"]


@pytest.mark.parametrize("field", ["nroDocumento", "nroTransaccionBancard"])
@pytest.mark.parametrize("invalid", [True, float("inf"), "123", {}])
def test_optional_movement_identifiers_cannot_coerce_bad_numbers(field, invalid):
    payload = movement_payload()
    payload[field] = invalid
    assert_contract_error(lambda: _normalize_movement(payload))


@pytest.mark.parametrize("movement_type", ["D", "C", "DEBITO", "CREDITO"])
def test_movement_accepts_documented_types_and_preserves_metadata(movement_type):
    payload = movement_payload()
    payload["tipoMovimiento"] = movement_type
    payload["moneda"]["iso"] = "ARP"
    payload["moneda"]["codigo"] = 10
    payload["moneda"]["abreviatura"] = "ARP"
    payload["moneda"]["extraAudit"] = "synthetic"
    payload["infoAdicional"]["extraAudit"] = {"note": "synthetic"}
    parsed = _normalize_movement(payload)
    assert parsed["tipoMovimiento"] == movement_type
    assert parsed["moneda"] == "ARP"
    assert parsed["fechaProceso"] == "2026-09-17"
    assert parsed["nroTransaccionBancard"] == 0
    assert parsed["infoAdicional"] == payload["infoAdicional"]
    assert parsed["monedaDetalle"] == payload["moneda"]


@pytest.mark.asyncio
@pytest.mark.parametrize("method_name", ["consultar_movimientos", "consultar_movimientos_detallados"])
async def test_client_never_accepts_a_movement_for_a_different_account(method_name):
    # The transport alone is replaced; the public method and parser execute fully.
    client = object.__new__(AtlasClient)
    client.settings = SimpleNamespace(base_url="https://example.invalid/cuentas-atlas")
    payload = movement_payload()
    payload["numeroCuenta"] = "654321"
    client._get = AsyncMock(return_value={"listaMovimiento": [payload]})
    with pytest.raises(AtlasContractError) as caught:
        await getattr(client, method_name)(ACCOUNT, "2026-09-17T00:00:00-03:00", "2026-09-17T23:59:59-03:00")
    assert caught.value.status_code == 502
    assert "654321" not in str(caught.value)
    assert ACCOUNT not in str(caught.value)


def test_contract_errors_never_echo_untrusted_values():
    payload = balance_payload()
    payload["saldo"] = {"secret": "DO-NOT-ECHO-SYNTHETIC"}
    error = assert_contract_error(lambda: _parse_saldo_response(payload, ACCOUNT))
    assert "DO-NOT-ECHO-SYNTHETIC" not in str(error)
    assert "DO-NOT-ECHO-SYNTHETIC" not in repr(error.details)
