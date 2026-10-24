"""Adaptador de integración con la API de Banco Atlas (Atlas Connect).

Implementa autenticación JWT RS-256, verificación de integridad de respuestas
y DTOs estrictos conforme a los manuales vigentes (armonización de políticas
2026, ver `actualizacion de politicas y mejoras de entorno/`):
  - API de Consulta de Saldo v0.9
  - API de Consulta de Movimientos v1.1
  - API de Transferencias v1.4
  - API de Consulta de Alias v0.1

Política de autenticación vigente (común a los 4 manuales):
  - Clave RSA de la aplicación: mínimo 4096 bits.
  - El JWT de `X-Atl-Auth` debe incluir obligatoriamente los claims
    `exp`, `jti`, `iss`, `sub`, `aud`, `iat`, además de `time` y `resource`.
"""

from __future__ import annotations

import hashlib
import hmac
import json as json_module
import logging
import math
import re
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import httpx
import jwt
from cryptography.hazmat.primitives.asymmetric import rsa as rsa_module
from cryptography.hazmat.primitives.serialization import load_pem_private_key, load_pem_public_key
from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

logger = logging.getLogger("atlas_connect")

# Audiencias del JWT por grupo de servicio (política 2026, `aud` obligatorio).
AUD_CUENTAS = "cuentas-atlas"
AUD_TRANSFERENCIAS = "transferencias-atlas"
AUD_DATOS_GENERALES = "datos-generales-atlas"


# ---------------------------------------------------------------------------
# Settings
# ---------------------------------------------------------------------------

class AtlasSettings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    base_url: str = Field(
        default="https://secure.atlas.com.py/api2-n/cuentas-atlas",
        alias="ATLAS_BASE_URL",
    )
    # --- Nuevos grupos de servicio (API de Transferencias v1.4) ---
    transferencias_base_url: str = Field(
        default="https://secure.atlas.com.py/api2-n/transferencias-atlas",
        alias="ATLAS_TRANSFERENCIAS_BASE_URL",
    )
    datos_generales_base_url: str = Field(
        default="https://secure.atlas.com.py/api2-n/datos-generales-atlas",
        alias="ATLAS_DATOS_GENERALES_BASE_URL",
    )
    api_key: str = Field(alias="ATLAS_API_KEY")
    account_auth_token: str = Field(alias="ATLAS_ACCOUNT_AUTH_TOKEN")
    private_key_path: str | None = Field(default=None, alias="ATLAS_PRIVATE_KEY_PATH")
    private_key_pem: str | None = Field(default=None, alias="ATLAS_PRIVATE_KEY_PEM")
    # Offset de los rangos de fecha de negocio (fecInicio/fecFin). NO aplica a
    # `X-Atl-Timestamp`, que los manuales exigen en UTC.
    timestamp_offset: str = Field(default="-03:00", alias="ATLAS_TIMESTAMP_OFFSET")
    timeout_seconds: float = Field(default=30, alias="ATLAS_TIMEOUT_SECONDS")
    verify_ssl: bool = Field(default=True, alias="ATLAS_VERIFY_SSL")
    jwt_user: str | None = Field(default=None, alias="ATLAS_JWT_USER")

    # --- Política 2026: claims JWT obligatorios (iss/sub/aud/exp/jti/iat) ---
    jwt_iss: str = Field(alias="ATLAS_JWT_ISS")
    jwt_sub: str = Field(alias="ATLAS_JWT_SUB")
    jwt_exp_seconds: int = Field(default=60, alias="ATLAS_JWT_EXP_SECONDS")

    # --- BLOQUEANTE-01: Verificación de respuesta del banco ---
    bank_public_key_path: str | None = Field(default=None, alias="ATLAS_BANK_PUBLIC_KEY_PATH")
    bank_public_key_pem: str | None = Field(default=None, alias="ATLAS_BANK_PUBLIC_KEY_PEM")
    # Fail closed por defecto. Preproducción debe optar explícitamente por
    # ATLAS_VERIFY_RESPONSE=false y la interfaz lo hace visible al operador.
    verify_response: bool = Field(default=True, alias="ATLAS_VERIFY_RESPONSE")

    @field_validator("base_url", "transferencias_base_url", "datos_generales_base_url")
    @classmethod
    def strip_trailing_slash(cls, value: str) -> str:
        return value.rstrip("/")

    def load_private_key(self) -> str:
        """Carga y valida la clave privada RSA (>= 4096 bits, política 2026)."""
        pem_text: str | None = None

        if self.private_key_pem:
            pem_text = self.private_key_pem.replace("\\n", "\n")
        elif self.private_key_path:
            key_path = Path(self.private_key_path)
            if key_path.exists():
                pem_text = key_path.read_text(encoding="utf-8")

        if not pem_text:
            raise RuntimeError(
                "Configure ATLAS_PRIVATE_KEY_PATH or ATLAS_PRIVATE_KEY_PEM with the RSA private key."
            )

        # --- MEDIO-02: Validar RSA-4096 al arranque (política 2026) ---
        _validate_rsa_private_key(pem_text)

        return pem_text

    def load_bank_public_key(self) -> str | None:
        """Carga la clave pública del banco para verificar respuestas.

        Retorna None si no está configurada.
        """
        if self.bank_public_key_pem:
            return self.bank_public_key_pem.replace("\\n", "\n")

        if self.bank_public_key_path:
            key_path = Path(self.bank_public_key_path)
            if key_path.exists():
                return key_path.read_text(encoding="utf-8")

        return None


# ---------------------------------------------------------------------------
# Validación criptográfica
# ---------------------------------------------------------------------------

def _validate_rsa_private_key(pem_text: str, min_key_size: int = 4096) -> None:
    """Verifica que el PEM sea una clave privada RSA con tamaño mínimo aceptable.

    Raises:
        RuntimeError: si el PEM no es RSA o tiene menos de *min_key_size* bits.
    """
    try:
        key = load_pem_private_key(pem_text.encode("utf-8"), password=None)
    except Exception as exc:
        raise RuntimeError(f"La clave privada PEM no pudo cargarse: {exc}") from exc

    if not isinstance(key, rsa_module.RSAPrivateKey):
        raise RuntimeError(
            f"Se requiere una clave RSA privada, pero se recibió {type(key).__name__}."
        )

    actual_size = key.key_size
    if actual_size < min_key_size:
        raise RuntimeError(
            f"La clave RSA tiene {actual_size} bits; el mínimo requerido por Atlas es {min_key_size}."
        )


# ---------------------------------------------------------------------------
# Errores
# ---------------------------------------------------------------------------

class AtlasApiError(Exception):
    """Error propagado desde la comunicación con Banco Atlas."""

    def __init__(
        self,
        status_code: int,
        message: str,
        details: dict[str, Any] | None = None,
    ) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.message = message
        self.details = details or {}


class AtlasContractError(AtlasApiError):
    """El banco respondió un JSON que no cumple con el contrato esperado."""

    def __init__(self, missing_field: str, context: str = "") -> None:
        detail = f"Campo inválido o ausente en respuesta de Atlas: '{missing_field}'"
        if context:
            detail += f" ({context})"
        super().__init__(502, detail, {"code": "ATLAS_CONTRACT_ERROR", "field": missing_field})


class AtlasIntegrityError(AtlasApiError):
    """La firma o hash de integridad de la respuesta de Atlas no verificó."""

    def __init__(self, reason: str) -> None:
        super().__init__(
            502,
            f"Integridad de respuesta de Atlas no verificada: {reason}",
            {"code": "ATLAS_INTEGRITY_ERROR"},
        )


class AtlasOperacionIndeterminadaError(AtlasApiError):
    """El resultado de una operación SIPAP no pudo determinarse."""

    def __init__(self, reason: str) -> None:
        super().__init__(
            502,
            f"Resultado de la operación SIPAP indeterminado: {reason}. "
            "No reversar: consultar el estado de la operación luego de al menos 60 segundos.",
            {"code": "ATLAS_OPERACION_INDETERMINADA"},
        )


# ---------------------------------------------------------------------------
# DTOs estrictos upstream — BLOQUEANTE-02
# ---------------------------------------------------------------------------

def _require_field(data: dict[str, Any], field: str, context: str = "") -> Any:
    """Extrae un campo obligatorio o lanza AtlasContractError."""
    if not isinstance(data, dict):
        raise AtlasContractError(field, context)
    value = data.get(field)
    if value is None:
        raise AtlasContractError(field, context)
    return value


def _number(value: Any, field: str, context: str, *, integer: bool = False) -> int | float:
    """Números JSON reales: nunca bool, texto, NaN o infinito.

    Los ejemplos de Atlas contienen importes decimales y códigos como 388.0.
    Se conserva el número original; no se convierte un dato inválido en dinero.
    """
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise AtlasContractError(field, context)
    if isinstance(value, float) and (not math.isfinite(value) or (integer and not value.is_integer())):
        raise AtlasContractError(field, context)
    return value


def _audit_integer(value: Any, field: str, context: str) -> int | float | str:
    """IDs de auditoría que producción también devuelve como texto integral.

    Compatibilidad limitada a cod_tra_padre/cod_transaccion (observado 2026-10-07).
    Se conserva la representación original: no afecta importes ni otros campos.
    """
    if isinstance(value, str):
        if not re.fullmatch(r"[0-9]+(?:\.0+)?", value.strip()):
            raise AtlasContractError(field, context)
        return value
    return _number(value, field, context, integer=True)


def _text(value: Any, field: str, context: str, *, nonempty: bool = False) -> str:
    if not isinstance(value, str) or (nonempty and not value.strip()):
        raise AtlasContractError(field, context)
    return value


def _account_identity(value: Any, field: str, context: str, expected: str | None = None) -> str:
    """No inventa la identidad de la cuenta ni mezcla respuestas entre cuentas."""
    if not isinstance(value, str) or not re.fullmatch(r"[0-9]+", value):
        raise AtlasContractError(field, context)
    if expected is not None and value != expected:
        raise AtlasContractError(field, context)
    return value


def _currency_iso(value: Any, field: str = "moneda", context: str = "") -> str:
    # Atlas documenta ARP: mantenerlo aunque su etiqueta difiera de ISO 4217.
    if not isinstance(value, str) or not re.fullmatch(r"[A-Z]{3}", value):
        raise AtlasContractError(field, context)
    return value


def _iso_date(value: Any, field: str, context: str, *, date_allowed: bool = False) -> str:
    """Fecha semánticamente válida con el formato ISO utilizado por Atlas."""
    if not isinstance(value, str):
        raise AtlasContractError(field, context)
    if date_allowed and re.fullmatch(r"[0-9]{4}-[0-9]{2}-[0-9]{2}", value):
        try:
            datetime.strptime(value, "%Y-%m-%d")
        except ValueError:
            raise AtlasContractError(field, context) from None
        return value
    pattern = r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]+)?(?:Z|[+-][0-9]{2}:[0-5][0-9])"
    if not re.fullmatch(pattern, value):
        raise AtlasContractError(field, context)
    try:
        datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        raise AtlasContractError(field, context) from None
    return value


def _parse_info_adicional(raw: Any, *, saldo: bool = False) -> dict[str, Any] | None:
    """Valida campos conocidos sin descartar metadata o nulls del banco."""
    if raw is None:
        return None
    if not isinstance(raw, dict):
        raise AtlasContractError("infoAdicional", "saldo" if saldo else "movimiento")
    if saldo:
        numbers = {
            "dias_sobregiro", "dias_mora", "linea_sobregiro", "liquidacion_sobregiro",
            "monto_mov_pendientes", "monto_mov_pendiente_asincronos", "monto_mov_pendiente_infonet",
        }
        texts: set[str] = set()
    else:
        numbers = {"cod_tra_padre", "cod_transaccion"}
        texts = {
            "estado", "cod_usuario", "usu_insercion", "reversado", "cod_usu_reversion",
            "des_tra_padre", "des_transaccion", "nro_doc_remitente", "nom_remitente",
            "nro_cta_remitente", "concepto",
        }
    for field in numbers:
        if raw.get(field) is not None:
            if not saldo:
                _audit_integer(raw[field], f"infoAdicional.{field}", "infoAdicional")
            else:
                _number(raw[field], f"infoAdicional.{field}", "infoAdicional", integer=field in {"dias_sobregiro", "dias_mora"})
    for field in texts:
        if raw.get(field) is not None:
            _text(raw[field], f"infoAdicional.{field}", "infoAdicional")
    if not saldo and raw.get("reversado") is not None and raw["reversado"] not in {"N", "S"}:
        raise AtlasContractError("infoAdicional.reversado", "movimiento")
    return raw


def _parse_producto(raw: Any) -> dict[str, Any]:
    """Valida y normaliza el objeto producto del saldo (v0.9 pp. 10-11)."""
    if not isinstance(raw, dict):
        raise AtlasContractError("producto", "debe ser un objeto")
    return {
        **raw,
        "codigo": _number(_require_field(raw, "codigo", "producto"), "producto.codigo", "producto", integer=True),
        "descripcion": _text(_require_field(raw, "descripcion", "producto"), "producto.descripcion", "producto", nonempty=True),
        "descripcionCorta": _text(raw["descripcionCorta"], "producto.descripcionCorta", "producto") if raw.get("descripcionCorta") is not None else None,
    }


def _parse_moneda(raw: Any) -> tuple[str, dict[str, Any] | None]:
    """Normaliza moneda: retorna (iso_string, objeto_original_o_None).

    El manual v1.1 define moneda como objeto con nombre/codigo/iso/simbolo/abreviatura.
    El adaptador expone el ISO como string y conserva el original como monedaDetalle.
    """
    if isinstance(raw, dict):
        iso = _currency_iso(_require_field(raw, "iso", "moneda"), "moneda.iso", "moneda")
        code = _number(_require_field(raw, "codigo", "moneda"), "moneda.codigo", "moneda", integer=True)
        _text(_require_field(raw, "nombre", "moneda"), "moneda.nombre", "moneda", nonempty=True)
        _text(_require_field(raw, "abreviatura", "moneda"), "moneda.abreviatura", "moneda", nonempty=True)
        if raw.get("simbolo") is not None:
            _text(raw["simbolo"], "moneda.simbolo", "moneda")
        # Código/ISO tal como se documentan en Movimientos v1.1 (tabla moneda).
        expected_iso = {6900: "PYG", 1: "USD", 62: "EUR", 9: "BRL", 10: "ARP"}.get(code)
        if expected_iso and iso != expected_iso and not (code == 10 and iso == "ARS"):
            raise AtlasContractError("moneda.iso", "moneda")
        return iso, raw
    if isinstance(raw, str):
        return _currency_iso(raw), None
    raise AtlasContractError("moneda", "esperado objeto o string ISO")


def _parse_saldo_response(data: dict[str, Any], numero_cuenta: str) -> dict[str, Any]:
    """Valida y estructura la respuesta de saldo (v0.9 pp. 10-11).

    Campos obligatorios: nroCuenta, producto, moneda, saldo, saldoDisponible.
    Campos opcionales: depositoConfirmar, saldoPromedio, saldoBloqueado,
    saldoProtegido, infoAdicional (incluye, entre otros,
    monto_mov_pendiente_asincronos y monto_mov_pendiente_infonet — v0.9).

    Los opcionales quedan en None cuando el banco no los informa (envía null en
    varios de ellos): convertirlos en 0 afirmaría un dato que el banco no dio.
    """
    nro_cuenta = _account_identity(_require_field(data, "nroCuenta", "saldo"), "nroCuenta", "saldo", numero_cuenta)
    producto = _parse_producto(_require_field(data, "producto", "saldo"))
    moneda = _currency_iso(_require_field(data, "moneda", "saldo"), "moneda", "saldo")
    saldo = _number(_require_field(data, "saldo", "saldo"), "saldo", "saldo")
    saldo_disponible = _number(_require_field(data, "saldoDisponible", "saldo"), "saldoDisponible", "saldo")
    optional_amounts = {}
    for field in ("depositoConfirmar", "saldoBloqueado", "saldoProtegido", "saldoPromedio"):
        value = data.get(field)
        optional_amounts[field] = _number(value, field, "saldo") if value is not None else None

    return {
        "nroCuenta": nro_cuenta,
        "producto": producto,
        "saldo": saldo,
        "saldoDisponible": saldo_disponible,
        **optional_amounts,
        "moneda": moneda,
        "infoAdicional": _parse_info_adicional(data.get("infoAdicional"), saldo=True),
    }


def _parse_alias_response(data: dict[str, Any]) -> dict[str, Any]:
    """Valida y estructura la respuesta de Consulta de Alias (v0.1 pp. 4-5).

    Campos obligatorios: entidad, nroCuenta, moneda, denominacion,
    tipoDocumento, nroDocumento.
    """
    entidad = _parse_dato(_require_field(data, "entidad", "alias"))
    moneda = _require_field(data, "moneda", "alias")
    tipo_documento = _parse_dato(_require_field(data, "tipoDocumento", "alias"))

    return {
        "entidad": entidad,
        "nroCuenta": str(_require_field(data, "nroCuenta", "alias")),
        "moneda": moneda,
        "denominacion": str(_require_field(data, "denominacion", "alias")),
        "tipoDocumento": tipo_documento,
        "nroDocumento": str(_require_field(data, "nroDocumento", "alias")),
    }


def _parse_dato(raw: Any) -> dict[str, Any]:
    """Valida el 'Objeto Dato' común (codigo/descripcion/descripcionCorta)."""
    if not isinstance(raw, dict):
        raise AtlasContractError("dato", "debe ser un objeto {codigo, descripcion, descripcionCorta}")
    return {
        "codigo": raw.get("codigo"),
        "descripcion": raw.get("descripcion"),
        "descripcionCorta": raw.get("descripcionCorta"),
    }


def _parse_lista_datos(data: dict[str, Any], context: str = "listaDatos") -> list[dict[str, Any]]:
    """Valida la envoltura `listaDatos` usada por los servicios de datos generales
    (Entidades Participantes, Tipos de Documentos, Motivos — v1.4)."""
    raw_list = data.get("listaDatos")
    if raw_list is None:
        raise AtlasContractError("listaDatos", context)
    if not isinstance(raw_list, list):
        raise AtlasApiError(502, f"Banco Atlas respondió {context} con formato inesperado.")
    return [_parse_dato(item) for item in raw_list]


def _normalize_movement(
    item: dict[str, Any], context: str = "movimiento", *, expected_account: str | None = None
) -> dict[str, Any]:
    """Valida y normaliza un movimiento individual.

    Campos obligatorios según manual v1.1: monto, numeroCuenta, moneda,
    concepto, tipoMovimiento, fechaMovimiento.
    """
    monto = _number(_require_field(item, "monto", context), "monto", context)
    numero_cuenta = _account_identity(_require_field(item, "numeroCuenta", context), "numeroCuenta", context, expected_account)
    moneda_raw = _require_field(item, "moneda", context)
    concepto = _text(_require_field(item, "concepto", context), "concepto", context)
    tipo_movimiento_raw = _text(_require_field(item, "tipoMovimiento", context), "tipoMovimiento", context)
    fecha_movimiento = _iso_date(_require_field(item, "fechaMovimiento", context), "fechaMovimiento", context)

    currency_code, currency_detail = _parse_moneda(moneda_raw)
    movement_type = tipo_movimiento_raw.upper()
    if movement_type not in {"D", "C", "DEBITO", "CREDITO"}:
        raise AtlasContractError("tipoMovimiento", context)
    process_dates = {
        field: _iso_date(item[field], field, context, date_allowed=True) if item[field] is not None else None
        for field in ("fecha Proceso", "fechaProceso") if field in item
    }
    # Ningún alias puede ocultar una fecha inválida o contradecir el campo oficial.
    if len(process_dates) == 2 and process_dates["fecha Proceso"] != process_dates["fechaProceso"]:
        raise AtlasContractError("fechaProceso", context)
    fecha_proceso = next(iter(process_dates.values()), None)
    optional_numbers = {}
    for field in ("nroDocumento", "nroTransaccionBancard"):
        value = item.get(field)
        optional_numbers[field] = _number(value, field, context, integer=True) if value is not None else None

    return {
        "monto": monto,
        "numeroCuenta": numero_cuenta,
        "moneda": currency_code,
        "monedaDetalle": currency_detail,
        "concepto": concepto,
        "tipoMovimiento": movement_type,
        "fechaMovimiento": fecha_movimiento,
        # v1.1 usa la clave literal "fecha Proceso" (con espacio) en sus ejemplos;
        # se acepta también la forma sin espacio por robustez ante el contrato real.
        "fechaProceso": fecha_proceso,
        **optional_numbers,
        "infoAdicional": _parse_info_adicional(item.get("infoAdicional")),
    }


# ---------------------------------------------------------------------------
# Cliente
# ---------------------------------------------------------------------------

class AtlasClient:
    def __init__(self, settings: AtlasSettings | None = None) -> None:
        self.settings = settings or AtlasSettings()
        self._private_key = self.settings.load_private_key()
        self._bank_public_key = self.settings.load_bank_public_key()

        if self.settings.verify_response and not self._bank_public_key:
            raise RuntimeError(
                "ATLAS_VERIFY_RESPONSE está activado pero no se configuró "
                "la clave pública del banco (ATLAS_BANK_PUBLIC_KEY_PATH o ATLAS_BANK_PUBLIC_KEY_PEM)."
            )

        if not self._bank_public_key:
            logger.warning(
                "Clave pública del banco no configurada. "
                "Las respuestas de Atlas NO se verificarán criptográficamente. "
                "Configure ATLAS_BANK_PUBLIC_KEY_PATH o ATLAS_BANK_PUBLIC_KEY_PEM para producción."
            )

    def _timestamp(self) -> str:
        """Timestamp de `X-Atl-Timestamp` en UTC (ISO8601).

        Los manuales lo definen como "la fecha y hora del request en UTC" y todos
        sus ejemplos vigentes usan `+00:00`. `timestamp_offset` rige únicamente
        para los rangos de fecha de negocio (fecInicio/fecFin).
        """
        return datetime.now(timezone.utc).isoformat(timespec="seconds")

    def _jwt_for_resource(
        self,
        resource: str,
        timestamp: str,
        aud: str,
        *,
        content_hash: str = "",
    ) -> str:
        """Genera el JWT de `X-Atl-Auth` con los claims obligatorios (política 2026):
        time, resource, exp, jti, iss, sub, aud, iat; más auth/user y content-hash.

        `content-hash` se envía vacío en GET y con el SHA256 del cuerpo exacto
        en el único POST documentado (`/sipap/registrar-operacion`).
        """
        now = int(datetime.now(timezone.utc).timestamp())
        payload: dict[str, Any] = {
            "time": timestamp,
            "resource": resource,
            "auth": self.settings.account_auth_token,
            "content-hash": content_hash,
            "exp": now + self.settings.jwt_exp_seconds,
            "jti": str(uuid.uuid4()),
            "iss": self.settings.jwt_iss,
            "sub": self.settings.jwt_sub,
            "aud": aud,
            "iat": now,
        }

        if self.settings.jwt_user:
            payload["user"] = self.settings.jwt_user

        return jwt.encode(payload, self._private_key, algorithm="RS256")

    def _headers(self, resource: str, aud: str, *, content_hash: str | None = None) -> dict[str, str]:
        """Cabeceras Atlas. `content_hash=None` indica petición GET sin cuerpo."""
        timestamp = self._timestamp()
        headers = {
            "Accept": "application/json",
            "X-RshkMichi-ApiKey": self.settings.api_key,
            "X-Atl-Timestamp": timestamp,
            "X-Atl-Auth": self._jwt_for_resource(resource, timestamp, aud, content_hash=content_hash or ""),
        }
        if content_hash is not None:
            headers["Content-Type"] = "application/json"
        return headers

    # --- BLOQUEANTE-01: Verificación de respuesta ---

    def _verify_response_integrity(
        self,
        response: httpx.Response,
        aud: str,
        *,
        expected_resource: str | None = None,
        expected_timestamp: str | None = None,
        expected_auth: str | None = None,
        expected_claims: dict[str, Any] | None = None,
    ) -> bool:
        """Verifica X-Atl-Auth del banco y content-hash SHA256.

        El banco responde "un JWT con los mismos valores del JWT recibido", por lo
        que el token trae el claim `aud`: hay que pasar la audiencia esperada al
        decodificar o PyJWT rechaza el token con InvalidAudienceError.

        Cuando se proveen los claims de la solicitud, la respuesta queda ligada
        a esa solicitud concreta. Los manuales indican que el banco replica los
        claims recibidos y sólo cambia `content-hash` y la firma.

        Retorna True únicamente cuando firma, claims y cuerpo fueron verificados.
        Si la verificación está desactivada, puede retornar False para preservar
        compatibilidad de laboratorio; producción usa `verify_response=True`.
        """
        if not self.settings.verify_response:
            logger.warning(
                "Verificación criptográfica de respuestas Atlas desactivada "
                "(perfil de preproducción)."
            )
            return False

        if not self._bank_public_key:
            raise AtlasIntegrityError("Clave pública del banco no disponible.")

        response_jwt = response.headers.get("X-Atl-Auth")
        if not response_jwt:
            raise AtlasIntegrityError("Cabecera X-Atl-Auth ausente en respuesta.")

        # Un token con `alg: none` no lleva firma: aceptarlo sería el ataque
        # clásico de JWT. El content-hash tampoco autentica, porque quien pueda
        # alterar el cuerpo puede recalcularlo y reemitir el token.
        try:
            alg = str(jwt.get_unverified_header(response_jwt).get("alg", "")).lower()
        except jwt.PyJWTError as exc:
            raise AtlasIntegrityError(f"Cabecera de JWT ilegible: {exc}") from exc

        if alg == "none":
            mensaje = "el banco respondió un JWT sin firma (alg: none); la respuesta no queda autenticada."
            raise AtlasIntegrityError(mensaje)

        try:
            # La audiencia se valida aparte: el banco no siempre incluye `aud`
            # en su respuesta, y PyJWT falla tanto si sobra como si falta.
            decoded = jwt.decode(
                response_jwt,
                self._bank_public_key,
                algorithms=["RS256"],
                options={"verify_aud": False},
            )
        except jwt.PyJWTError as exc:
            raise AtlasIntegrityError(f"JWT de respuesta inválido: {exc}") from exc

        aud_recibida = decoded.get("aud")
        if aud_recibida is not None and aud_recibida != aud:
            raise AtlasIntegrityError("El claim aud no coincide con la solicitud.")

        claims_esperados = dict(expected_claims or {})
        if expected_resource is not None:
            claims_esperados["resource"] = expected_resource
        if expected_timestamp is not None:
            claims_esperados["time"] = expected_timestamp
        if expected_auth is not None:
            claims_esperados["auth"] = expected_auth

        # `content-hash` es la única diferencia esperada entre el JWT de request
        # y el de response. No se comparan ni registran valores sensibles.
        for claim, expected_value in claims_esperados.items():
            if claim == "content-hash":
                continue
            actual_value = decoded.get(claim)
            if isinstance(expected_value, str) and isinstance(actual_value, str):
                matches = hmac.compare_digest(actual_value, expected_value)
            else:
                matches = actual_value == expected_value
            if not matches:
                raise AtlasIntegrityError(f"El claim {claim} no coincide con la solicitud.")

        # Verificar content-hash SHA256
        expected_hash = decoded.get("content-hash")
        if not isinstance(expected_hash, str) or not expected_hash:
            raise AtlasIntegrityError("El JWT de respuesta no contiene content-hash.")

        actual_hash = hashlib.sha256(response.content).hexdigest()
        if not hmac.compare_digest(actual_hash, expected_hash):
            raise AtlasIntegrityError("content-hash no coincide con el cuerpo recibido.")

        return True

    @staticmethod
    def _request_claims(headers: dict[str, str]) -> dict[str, Any]:
        """Extrae claims del JWT recién generado por este cliente.

        No verifica aquí la firma porque el token acaba de ser construido por el
        propio proceso. El resultado sólo se usa como contexto esperado para
        enlazar criptográficamente la respuesta del banco con esa solicitud.
        """
        return jwt.decode(
            headers["X-Atl-Auth"],
            options={
                "verify_signature": False,
                "verify_aud": False,
                "verify_exp": False,
                "verify_iat": False,
            },
        )

    async def _get(
        self,
        base_url: str,
        resource: str,
        aud: str,
        params: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        url = f"{base_url}{resource}"
        request_headers = self._headers(resource, aud)
        request_claims = self._request_claims(request_headers)
        async with httpx.AsyncClient(
            timeout=self.settings.timeout_seconds,
            verify=self.settings.verify_ssl,
        ) as client:
            try:
                response = await client.get(url, headers=request_headers, params=params)
            except httpx.HTTPError as exc:
                logger.warning("Error de transporte al consultar Atlas: %s", type(exc).__name__)
                raise AtlasApiError(502, "No se pudo conectar con Banco Atlas.") from exc

        if not 200 <= response.status_code < 300:
            integrity_verified = False
            if response.headers.get("X-Atl-Auth"):
                integrity_verified = self._verify_response_integrity(
                    response,
                    aud,
                    expected_claims=request_claims,
                )
            raise self._error_from_response(response, trusted=integrity_verified)

        # Una respuesta exitosa sólo se procesa si queda autenticada y ligada
        # a esta solicitud concreta — fail closed en producción.
        self._verify_response_integrity(
            response,
            aud,
            expected_claims=request_claims,
        )

        try:
            data = response.json()
        except ValueError as exc:
            raise AtlasApiError(502, "Banco Atlas respondió con JSON inválido.") from exc

        if not isinstance(data, dict):
            raise AtlasApiError(502, "Banco Atlas respondió con un formato inesperado.")

        return data

    async def _post(
        self,
        base_url: str,
        resource: str,
        aud: str,
        json_body: dict[str, Any],
    ) -> dict[str, Any]:
        """POST con firma del SHA256 de los bytes exactos enviados."""
        body_bytes = json_module.dumps(json_body, ensure_ascii=False).encode("utf-8")
        content_hash = hashlib.sha256(body_bytes).hexdigest()
        url = f"{base_url}{resource}"
        request_headers = self._headers(resource, aud, content_hash=content_hash)
        request_claims = self._request_claims(request_headers)

        async with httpx.AsyncClient(
            timeout=self.settings.timeout_seconds,
            verify=self.settings.verify_ssl,
        ) as client:
            try:
                response = await client.post(url, headers=request_headers, content=body_bytes)
            except httpx.HTTPError as exc:
                logger.warning("Error de transporte al consultar Atlas: %s", type(exc).__name__)
                raise AtlasApiError(502, "No se pudo conectar con Banco Atlas.") from exc

        if not 200 <= response.status_code < 300:
            integrity_verified = False
            if response.headers.get("X-Atl-Auth"):
                integrity_verified = self._verify_response_integrity(
                    response,
                    aud,
                    expected_claims=request_claims,
                )
            raise self._error_from_response(response, trusted=integrity_verified)

        self._verify_response_integrity(response, aud, expected_claims=request_claims)

        try:
            data = response.json()
        except ValueError as exc:
            raise AtlasApiError(502, "Banco Atlas respondió con JSON inválido.") from exc

        if not isinstance(data, dict):
            raise AtlasApiError(502, "Banco Atlas respondió con un formato inesperado.")

        return data

    def _error_from_response(
        self,
        response: httpx.Response,
        *,
        trusted: bool = False,
    ) -> AtlasApiError:
        """Convierte un rechazo upstream sin filtrar cuerpo ni detalles técnicos.

        Atlas puede omitir la firma en rechazos de gateway. En ese caso se
        conserva el status y código como diagnóstico, pero nunca se muestra el
        mensaje no autenticado. `useApiMessage` sólo se honra si la respuesta
        fue verificada con la clave pública del banco.
        """
        public_status = response.status_code if 400 <= response.status_code < 600 else 502
        message = f"Banco Atlas rechazó la solicitud ({response.status_code})."
        details: dict[str, Any] = {
            "upstreamStatus": response.status_code,
            "upstreamIntegrityVerified": trusted,
        }

        try:
            parsed = response.json()
        except ValueError:
            parsed = None

        if isinstance(parsed, dict):
            code = parsed.get("code")
            error_type = parsed.get("type")
            use_api_message = parsed.get("useApiMessage")

            if isinstance(code, str) and code:
                details["code"] = code[:64]
            if isinstance(error_type, str) and error_type:
                details["type"] = error_type[:64]
            if isinstance(use_api_message, bool):
                details["useApiMessage"] = use_api_message

            upstream_message = parsed.get("message")
            if trusted and use_api_message is True and isinstance(upstream_message, str):
                message = upstream_message[:500]

        return AtlasApiError(public_status, message, details)

    # --- Consultas ---

    async def consultar_saldo(self, numero_cuenta: str) -> dict[str, Any]:
        resource = f"/cuentas/{numero_cuenta}/saldo"
        data = await self._get(self.settings.base_url, resource, AUD_CUENTAS)
        return _parse_saldo_response(data, numero_cuenta)

    async def consultar_alias(
        self,
        tipo: str,
        alias: str,
        cod_swift: str | None = None,
    ) -> dict[str, Any]:
        """Consulta de datos por Alias (v0.1). tipo: CI/CRC/CRP/EMAIL/MOBILE/RUC."""
        resource = "/cuentas/cas/obt-cta-by-alias"
        params: dict[str, Any] = {"tipo": tipo, "alias": alias}
        if cod_swift:
            params["codSwift"] = cod_swift

        data = await self._get(self.settings.base_url, resource, AUD_CUENTAS, params)
        return _parse_alias_response(data)

    async def consultar_movimientos(
        self,
        numero_cuenta: str,
        fec_inicio: str,
        fec_fin: str,
        tipo_movimiento: str | None = None,
        cantidad: int | None = None,
        descripcion: str | None = None,
        orden: str | None = "DESC",
    ) -> list[dict[str, Any]]:
        resource = f"/cuentas/{numero_cuenta}/movimientos"
        params: dict[str, Any] = {
            "fecInicio": fec_inicio,
            "fecFin": fec_fin,
        }

        if tipo_movimiento:
            params["tipoMovimiento"] = tipo_movimiento
        if cantidad:
            params["cantidad"] = cantidad
        if descripcion:
            params["descripcion"] = descripcion
        if orden:
            params["orden"] = orden

        data = await self._get(self.settings.base_url, resource, AUD_CUENTAS, params)
        return _parse_movements_list(data, numero_cuenta)

    async def consultar_movimientos_detallados(
        self,
        numero_cuenta: str,
        fec_inicio: str,
        fec_fin: str,
        tipo_movimiento: str | None = None,
        cantidad: int | None = None,
        descripcion: str | None = None,
        incluye_reversa: bool | None = False,
        orden: str | None = "DESC",
    ) -> list[dict[str, Any]]:
        resource = f"/cuentas/{numero_cuenta}/movimientos-detalle"
        params: dict[str, Any] = {
            "fecInicio": fec_inicio,
            "fecFin": fec_fin,
        }

        if tipo_movimiento:
            params["tipoMovimiento"] = tipo_movimiento
        if cantidad:
            params["cantidad"] = cantidad
        if descripcion:
            params["descripcion"] = descripcion
        if incluye_reversa is not None:
            params["incluyeReversa"] = "true" if incluye_reversa else "false"
        if orden:
            params["orden"] = orden

        data = await self._get(self.settings.base_url, resource, AUD_CUENTAS, params)
        return _parse_movements_list(data, numero_cuenta)

    # --- API de Transferencias v1.4: datos generales (catálogos) ---

    async def consultar_entidades_participantes(self) -> list[dict[str, Any]]:
        """Entidades participantes del SIPAP (bancos)."""
        data = await self._get(self.settings.datos_generales_base_url, "/bancos_participante", AUD_DATOS_GENERALES)
        return _parse_lista_datos(data, "entidades participantes")

    async def consultar_tipos_documentos(self) -> list[dict[str, Any]]:
        """Tipos de documento válidos para solicitante/beneficiario SIPAP."""
        data = await self._get(self.settings.datos_generales_base_url, "/documentos", AUD_DATOS_GENERALES)
        return _parse_lista_datos(data, "tipos de documentos")

    async def consultar_motivos(self) -> list[dict[str, Any]]:
        """Motivos válidos para una transferencia SIPAP."""
        data = await self._get(
            self.settings.datos_generales_base_url, "/motivos_transferencia", AUD_DATOS_GENERALES
        )
        return _parse_lista_datos(data, "motivos")

    async def registrar_operacion_sipap(self, operacion: dict[str, Any]) -> dict[str, Any]:
        """Registra una operación SIPAP; queda bloqueada en preproducción relajada."""
        if not self.settings.verify_response:
            raise AtlasApiError(
                503,
                "El registro SIPAP está deshabilitado en modo preproducción de solo lectura.",
                {"code": "PREPRODUCTION_READ_ONLY"},
            )

        try:
            data = await self._post(
                self.settings.transferencias_base_url,
                "/sipap/registrar-operacion",
                AUD_TRANSFERENCIAS,
                operacion,
            )
            return _parse_registro_sipap_response(data)
        except AtlasApiError as exc:
            if _es_resultado_indeterminado(exc):
                raise AtlasOperacionIndeterminadaError(exc.message) from exc
            raise

    async def consultar_operacion_sipap(
        self,
        nro_referencia: int | None = None,
        nro_ref_interna: int | None = None,
    ) -> dict[str, Any]:
        """Consulta una operación SIPAP por nro. de referencia y/o referencia interna.

        Agrega `clasificacion` (OK/ERROR/INTERMEDIO/INDETERMINADO) según la matriz
        situación/estado del manual v1.4.
        """
        params: dict[str, Any] = {}
        if nro_referencia is not None:
            params["nroReferencia"] = nro_referencia
        if nro_ref_interna is not None:
            params["nroRefInterna"] = nro_ref_interna

        data = await self._get(
            self.settings.transferencias_base_url, "/sipap/consultar-operacion", AUD_TRANSFERENCIAS, params
        )
        return _con_clasificacion(data)

    async def consultar_operaciones_sipap(
        self,
        fecha_desde: str | None = None,
        fecha_hasta: str | None = None,
        cod_swi_beneficiario: str | None = None,
        cod_swi_solicitante: str | None = None,
        estado: str | None = None,
        nro_referencia: int | None = None,
    ) -> dict[str, Any]:
        """Consulta una o varias operaciones SIPAP con filtros opcionales."""
        params: dict[str, Any] = {}
        if fecha_desde:
            params["fechaDesde"] = fecha_desde
        if fecha_hasta:
            params["fechaHasta"] = fecha_hasta
        if cod_swi_beneficiario:
            params["codSwiBeneficiario"] = cod_swi_beneficiario
        if cod_swi_solicitante:
            params["codSwiSolicitante"] = cod_swi_solicitante
        if estado:
            params["estado"] = estado
        if nro_referencia is not None:
            params["nroReferencia"] = nro_referencia

        data = await self._get(
            self.settings.transferencias_base_url, "/sipap/consultar-operaciones", AUD_TRANSFERENCIAS, params
        )
        return _parse_operaciones_sipap_response(data)


# Matriz situación/estado para transferencias salientes (v1.4, "Recomendaciones
# para Implementación"). Cualquier combinación no listada es indeterminada.
_SITUACION_ESTADO: dict[tuple[str, str], str] = {
    ("L", "A"): "OK",
    ("Z", "E"): "ERROR",
    ("P", "E"): "ERROR",
    ("C", "C"): "ERROR",
    ("Z", "Z"): "ERROR",
    ("P", "A"): "ERROR",
    ("P", "S"): "INTERMEDIO",
    ("V", "S"): "INDETERMINADO",
}


def clasificar_operacion_sipap(situacion: Any, estado: Any) -> str:
    """Clasifica una transferencia saliente según la matriz del manual v1.4.

    - `OK`: estado final exitoso, aceptar.
    - `ERROR`: estado final de rechazo, corresponde reversar el débito.
    - `INTERMEDIO` / `INDETERMINADO`: volver a consultar el estado luego de al
      menos 60 segundos; no reversar.
    """
    clave = (str(situacion or "").strip().upper(), str(estado or "").strip().upper())
    return _SITUACION_ESTADO.get(clave, "INDETERMINADO")


def _con_clasificacion(operacion: Any) -> Any:
    """Agrega `clasificacion` a un objeto Operacion Sipap."""
    if not isinstance(operacion, dict):
        return operacion
    return {
        **operacion,
        "clasificacion": clasificar_operacion_sipap(operacion.get("situacion"), operacion.get("estado")),
    }


def _es_resultado_indeterminado(exc: AtlasApiError) -> bool:
    """HTTP >= 500, g1000 o INTERNAL no permiten afirmar que el registro falló."""
    if exc.status_code >= 500:
        return True
    return exc.details.get("code") == "g1000" or exc.details.get("type") == "INTERNAL"


def _parse_registro_sipap_response(data: dict[str, Any]) -> dict[str, Any]:
    """Valida la respuesta del único servicio de registro SIPAP."""
    respuesta = _require_field(data, "respuesta", "registrar-operacion")
    if not isinstance(respuesta, dict) or not respuesta.get("estado"):
        raise AtlasContractError("respuesta.estado", "registrar-operacion")

    datos_operacion = _require_field(data, "datosOperacion", "registrar-operacion")
    if not isinstance(datos_operacion, dict):
        raise AtlasContractError("datosOperacion", "debe ser un objeto Operacion Sipap")

    return {"respuesta": respuesta, "datosOperacion": _con_clasificacion(datos_operacion)}


def _parse_operaciones_sipap_response(data: dict[str, Any]) -> dict[str, Any]:
    """Valida la envoltura de Consulta de Operaciones SIPAP (v1.4 pp. 27-29)."""
    raw_list = _require_field(data, "operacionesSipap", "consultar-operaciones")
    if not isinstance(raw_list, list):
        raise AtlasApiError(502, "Banco Atlas respondió operacionesSipap con formato inesperado.")

    return {
        "totalRegistros": data.get("totalRegistros", len(raw_list)),
        "paginaActual": data.get("paginaActual", 1),
        "totalPaginas": data.get("totalPaginas", 1),
        "operacionesSipap": [_con_clasificacion(item) for item in raw_list],
    }


def _parse_movements_list(data: dict[str, Any], numero_cuenta: str | None = None) -> list[dict[str, Any]]:
    """Valida y normaliza la lista de movimientos de la respuesta de Atlas."""
    raw_list = _require_field(data, "listaMovimiento", "respuesta de movimientos")
    if not isinstance(raw_list, list):
        raise AtlasContractError("listaMovimiento", "respuesta de movimientos")

    results: list[dict[str, Any]] = []
    for idx, item in enumerate(raw_list):
        if not isinstance(item, dict):
            raise AtlasContractError("listaMovimiento", f"movimiento[{idx}]")
        results.append(_normalize_movement(item, context=f"movimiento[{idx}]", expected_account=numero_cuenta))

    return results


# ---------------------------------------------------------------------------
# Helpers de fecha/hora — MEDIO-05
# ---------------------------------------------------------------------------

def date_to_atlas_iso(value: Any, *, start: bool, offset: str = "-03:00") -> str:
    """Convierte una fecha a formato ISO 8601 con zona horaria configurable.

    Parámetros:
        value: objeto date.
        start: True para inicio del día (00:00:00), False para fin (23:59:59).
        offset: zona horaria en formato ±HH:MM (por defecto -03:00 Paraguay).
    """
    from datetime import date, time

    if isinstance(value, date) and not isinstance(value, datetime):
        clock = time.min if start else time.max.replace(microsecond=0)
        return datetime.combine(value, clock).isoformat() + offset
    return str(value)


def _parse_offset(value: str) -> timezone:
    normalized = value.strip()
    if normalized.upper() in {"Z", "UTC", "+00:00", "-00:00"}:
        return timezone.utc

    sign = 1
    if normalized.startswith("-"):
        sign = -1
        normalized = normalized[1:]
    elif normalized.startswith("+"):
        normalized = normalized[1:]

    try:
        hours_text, minutes_text = normalized.split(":", 1)
        delta = timedelta(hours=int(hours_text), minutes=int(minutes_text))
    except ValueError as exc:
        raise RuntimeError("ATLAS_TIMESTAMP_OFFSET must use format -03:00, +00:00, or UTC.") from exc

    return timezone(sign * delta)
