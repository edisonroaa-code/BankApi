"""API interna del adaptador Atlas Connect.

Expone endpoints de consulta de saldo y movimientos, validación de cuenta,
autenticación interna básica, health/readiness diferenciados y un contrato
de errores unificado.

Restricciones locales (no confirmadas con Atlas, marcadas como política interna):
  - Número de cuenta: solo dígitos, máximo 30 caracteres.
  - Cantidad: entre 1 y 500 (MEDIO-04).
  - Descripción: máximo 120 caracteres (MEDIO-04).
"""

from __future__ import annotations

import logging
import hmac
from datetime import date, datetime, timezone
from typing import Any, Literal

from fastapi import Depends, FastAPI, HTTPException, Query, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.hazmat.primitives.serialization import load_pem_public_key

from api_atlas import (
    AtlasApiError,
    AtlasClient,
    AtlasContractError,
    AtlasIntegrityError,
    AtlasSettings,
    date_to_atlas_iso,
)

logger = logging.getLogger("atlas_connect")

app = FastAPI(title="Atlas Connect Adapter", version="0.2.0")
app.mount("/static", StaticFiles(directory="static"), name="static")


# ---------------------------------------------------------------------------
# BLOQUEANTE-03: Autenticación interna básica
# ---------------------------------------------------------------------------

class InternalSecuritySettings(BaseSettings):
    """Configuración local independiente de las credenciales del banco."""

    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")
    internal_api_key: str | None = Field(default=None, alias="INTERNAL_API_KEY")


_INTERNAL_API_KEY = InternalSecuritySettings().internal_api_key

if not _INTERNAL_API_KEY:
    logger.warning(
        "INTERNAL_API_KEY no configurada. El servicio opera sin autenticación interna. "
        "Configure INTERNAL_API_KEY en .env para entornos no aislados."
    )


@app.middleware("http")
async def internal_auth_middleware(request: Request, call_next):  # type: ignore[no-untyped-def]
    """Valida X-Internal-ApiKey cuando INTERNAL_API_KEY está configurada.

    Excluye: /, /api/health, /api/ready, /static y /docs.
    """
    path = request.scope["path"]
    exempt_prefixes = ("/static/", "/docs/", "/redoc/")
    exempt_exact = {"/", "/api/health", "/api/ready", "/static", "/docs", "/openapi.json", "/redoc"}

    if path in exempt_exact or any(path.startswith(p) for p in exempt_prefixes):
        return await call_next(request)

    if _INTERNAL_API_KEY:
        provided = request.headers.get("X-Internal-ApiKey")
        if not provided or not hmac.compare_digest(provided.encode("utf-8"), _INTERNAL_API_KEY.encode("utf-8")):
            return JSONResponse(
                status_code=401,
                content={
                    "code": "UNAUTHORIZED",
                    "message": "X-Internal-ApiKey ausente o inválida.",
                },
            )

    return await call_next(request)


@app.middleware("http")
async def security_headers_middleware(request: Request, call_next):  # type: ignore[no-untyped-def]
    """Agrega cabeceras de seguridad y desactiva cache en endpoints financieros."""
    try:
        response = await call_next(request)
    except Exception as exc:
        # No serializar ni registrar str(exc): puede contener settings, tokens,
        # respuestas bancarias o datos de la solicitud.
        logger.error("Error interno en Atlas Connect: %s", type(exc).__name__)
        response = JSONResponse(
            status_code=500,
            content={"code": "INTERNAL_ERROR", "message": "No se pudo procesar la solicitud.", "details": {}},
        )
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["Referrer-Policy"] = "no-referrer"

    path = request.scope["path"]
    if response.status_code >= 500 or path.startswith("/api/"):
        response.headers["Cache-Control"] = "no-store, private"
    elif path == "/" or path.startswith("/static/"):
        # La pantalla es un cliente operativo: después de recrear la imagen no
        # debe seguir ejecutando JavaScript antiguo con configuración obsoleta.
        response.headers["Cache-Control"] = "no-cache"

    return response


# ---------------------------------------------------------------------------
# MEDIO-01: Contrato de errores unificado
# ---------------------------------------------------------------------------

class AtlasErrorDetail(BaseModel):
    """Estructura unificada de errores para todos los endpoints.

    Alineada con el contrato de Atlas (code, message, type, useApiMessage)
    y extendida con details para diagnóstico interno.
    """
    code: str
    message: str
    type: str | None = None
    useApiMessage: bool | None = None
    details: dict[str, Any] = Field(default_factory=dict)


@app.exception_handler(RequestValidationError)
async def request_validation_handler(request: Request, exc: RequestValidationError) -> JSONResponse:
    """Conserva campo y tipo de fallo sin devolver input, ctx ni mensajes dinámicos."""
    return JSONResponse(
        status_code=422,
        content=AtlasErrorDetail(
            code="VALIDATION_ERROR",
            message="Los parámetros de la solicitud no son válidos.",
            details={"errors": [{"loc": list(error["loc"]), "type": error["type"]} for error in exc.errors()]},
        ).model_dump(exclude_none=True),
    )


@app.exception_handler(AtlasApiError)
async def atlas_error_handler(request: Request, exc: AtlasApiError) -> JSONResponse:
    """Handler global para errores de la capa Atlas."""
    status_code = exc.status_code if 400 <= exc.status_code < 600 else 502
    return JSONResponse(
        status_code=status_code,
        content=AtlasErrorDetail(
            code=exc.details.get("code", "ATLAS_API_ERROR"),
            message=exc.message,
            type=exc.details.get("type"),
            useApiMessage=exc.details.get("useApiMessage"),
            details={k: v for k, v in exc.details.items() if k not in ("code", "type", "useApiMessage")},
        ).model_dump(exclude_none=True),
    )


@app.exception_handler(HTTPException)
async def http_exception_handler(request: Request, exc: HTTPException) -> JSONResponse:
    """Normaliza HTTPException al contrato unificado."""
    detail = exc.detail
    if isinstance(detail, dict):
        return JSONResponse(
            status_code=exc.status_code,
            content=AtlasErrorDetail(
                code=detail.get("code", "VALIDATION_ERROR"),
                message=detail.get("message", str(exc.detail)),
                type=detail.get("type"),
                details={k: v for k, v in detail.items() if k not in ("code", "message", "type")},
            ).model_dump(exclude_none=True),
        )
    return JSONResponse(
        status_code=exc.status_code,
        content=AtlasErrorDetail(
            code="HTTP_ERROR",
            message=str(detail),
        ).model_dump(exclude_none=True),
    )


# ---------------------------------------------------------------------------
# Modelos de respuesta
# ---------------------------------------------------------------------------

class ProductoResponse(BaseModel):
    codigo: int | float
    descripcion: str
    descripcionCorta: str | None = None


class BalanceResponse(BaseModel):
    nroCuenta: str
    producto: ProductoResponse
    saldo: int | float
    saldoDisponible: int | float
    # None = el banco no informó el dato (envía null en varios de estos campos);
    # 0 afirmaría un saldo que el banco no dio.
    depositoConfirmar: int | float | None = None
    saldoBloqueado: int | float | None = None
    saldoProtegido: int | float | None = None
    saldoPromedio: int | float | None = None
    moneda: str
    infoAdicional: dict[str, Any] | None = None


class DatoResponse(BaseModel):
    codigo: str | int | None = None
    descripcion: str | None = None
    descripcionCorta: str | None = None


class AliasResponse(BaseModel):
    entidad: DatoResponse
    nroCuenta: str
    moneda: dict[str, Any]
    denominacion: str
    tipoDocumento: DatoResponse
    nroDocumento: str


class MovementResponse(BaseModel):
    monto: int | float
    numeroCuenta: str
    moneda: str
    monedaDetalle: dict[str, Any] | None = None
    concepto: str
    tipoMovimiento: str
    fechaMovimiento: str
    fechaProceso: str | None = None
    # El banco envía números en varios formatos (enteros, decimales como 388.0);
    # se aceptan tal cual para no rechazar una respuesta válida.
    nroDocumento: int | float | str | None = None
    nroTransaccionBancard: int | float | str | None = None
    infoAdicional: dict[str, Any] | None = None


class MovementsEnvelope(BaseModel):
    listaMovimiento: list[MovementResponse]


class DatosListEnvelope(BaseModel):
    listaDatos: list[DatoResponse]


class MonedaOperacion(BaseModel):
    nombre: str
    codigo: int
    iso: str | None = None
    simbolo: str | None = None
    abreviatura: str


class RegistrarOperacionSipapRequest(BaseModel):
    """Cuerpo de Registro de Operación SIPAP (API de Transferencias v1.4)."""

    nroReferencia: int | None = None
    tipTransferencia: str | None = None
    moneda: MonedaOperacion
    monto: int | float
    fechaOperacion: str
    fecha: str | None = None
    concepto: str | None = None
    codMotivo: str
    motivo: str | None = None
    codTipDocSolicitante: str
    nroDocSolicitante: str
    nomSolicitante: str
    dirSolicitante: str | None = None
    codSwiPteSolicitante: str
    nroCtaSolicitante: str
    codTipDocBeneficiario: str
    nroDocBeneficiario: str
    nomBeneficiario: str
    dirBeneficiario: str | None = None
    codSwiPteBeneficiario: str
    nroCtaBeneficiario: str

    @field_validator("fechaOperacion", "fecha")
    @classmethod
    def validate_iso_dates(cls, value: str | None) -> str | None:
        if value is not None:
            try:
                datetime.fromisoformat(value)
            except (ValueError, TypeError):
                raise ValueError("Fecha ISO8601 inválida.") from None
        return value


# ---------------------------------------------------------------------------
# Dependencia
# ---------------------------------------------------------------------------

_cached_settings: AtlasSettings | None = None


def get_atlas_client() -> AtlasClient:
    return AtlasClient()


# ---------------------------------------------------------------------------
# MEDIO-03: Health / Readiness diferenciados
# ---------------------------------------------------------------------------

@app.get("/", include_in_schema=False)
async def index() -> FileResponse:
    from pathlib import Path
    return FileResponse(Path("templates/index.html"))


@app.get("/api/health", tags=["ops"])
async def health() -> dict[str, str]:
    """Liveness: responde ok si el proceso está corriendo."""
    return {"status": "ok"}


@app.get("/api/ready", tags=["ops"])
async def readiness() -> JSONResponse:
    """Readiness: valida configuración mínima para operar.

    Verifica: API key, auth token, clave privada RSA.
    No realiza conexión al banco.
    """
    checks: dict[str, str] = {}
    all_ok = True

    try:
        settings = AtlasSettings()
        checks["api_key"] = "ok"
    except Exception:
        checks["api_key"] = "invalid_configuration"
        all_ok = False
        settings = None

    if settings:
        try:
            settings.load_private_key()
            checks["private_key"] = "ok"
        except Exception:
            checks["private_key"] = "invalid"
            all_ok = False

        checks["auth_token"] = "ok" if settings.account_auth_token else "missing"
        if not settings.account_auth_token:
            all_ok = False

        # Política 2026: iss/sub obligatorios para firmar el JWT.
        checks["jwt_iss"] = "ok" if settings.jwt_iss else "missing"
        checks["jwt_sub"] = "ok" if settings.jwt_sub else "missing"
        if not settings.jwt_iss or not settings.jwt_sub:
            all_ok = False

        checks["verify_response"] = "enabled" if settings.verify_response else "disabled"
        if settings.verify_response:
            try:
                bank_key = settings.load_bank_public_key()
                if not bank_key:
                    checks["bank_public_key"] = "missing"
                    all_ok = False
                else:
                    loaded = load_pem_public_key(bank_key.encode("utf-8"))
                    if not isinstance(loaded, rsa.RSAPublicKey):
                        raise ValueError("Banco requiere clave pública RSA.")
                    checks["bank_public_key"] = "ok"
            except Exception:
                checks["bank_public_key"] = "invalid"
                all_ok = False
        else:
            checks["bank_public_key"] = "not_required"

    status_code = 200 if all_ok else 503
    return JSONResponse(
        status_code=status_code,
        content={"status": "ready" if all_ok else "not_ready", "checks": checks},
    )


# ---------------------------------------------------------------------------
# Endpoints de negocio
# ---------------------------------------------------------------------------

@app.get(
    "/api/saldo/{numero_cuenta}",
    response_model=BalanceResponse,
    responses={
        400: {"model": AtlasErrorDetail},
        401: {"model": AtlasErrorDetail},
        502: {"model": AtlasErrorDetail},
    },
)
async def saldo(
    numero_cuenta: str,
    client: AtlasClient = Depends(get_atlas_client),
) -> dict[str, Any]:
    _validate_account(numero_cuenta)
    return await client.consultar_saldo(numero_cuenta)


@app.get(
    "/api/alias",
    response_model=AliasResponse,
    responses={
        400: {"model": AtlasErrorDetail},
        401: {"model": AtlasErrorDetail},
        502: {"model": AtlasErrorDetail},
    },
)
async def alias(
    tipo: Literal["CI", "CRC", "CRP", "EMAIL", "MOBILE", "RUC"] = Query(...),
    alias: str = Query(..., min_length=1, max_length=120),
    codSwift: str | None = Query(default=None, max_length=20),
    client: AtlasClient = Depends(get_atlas_client),
) -> dict[str, Any]:
    """Consulta de datos de cuenta por alias (API de Consulta de Alias v0.1)."""
    return await client.consultar_alias(tipo=tipo, alias=alias, cod_swift=codSwift)


@app.get(
    "/api/movimientos/{numero_cuenta}",
    response_model=MovementsEnvelope,
    responses={
        400: {"model": AtlasErrorDetail},
        401: {"model": AtlasErrorDetail},
        502: {"model": AtlasErrorDetail},
    },
)
async def movimientos(
    numero_cuenta: str,
    fecInicio: date = Query(..., description="Fecha inicial en formato YYYY-MM-DD"),
    fecFin: date = Query(..., description="Fecha final en formato YYYY-MM-DD"),
    tipoMovimiento: Literal["D", "C"] | None = Query(default=None),
    # Política local (MEDIO-04): límite de cantidad no confirmado con Atlas.
    cantidad: int | None = Query(default=50, ge=1, le=500),
    # Política local (MEDIO-04): límite de longitud no confirmado con Atlas.
    descripcion: str | None = Query(default=None, max_length=120),
    orden: Literal["ASC", "DESC"] = Query(default="DESC"),
    detallado: bool = Query(default=False, description="Consultar endpoint de movimientos detallados"),
    incluyeReversa: bool = Query(default=False, description="Incluir movimientos reversados (solo detallado)"),
    client: AtlasClient = Depends(get_atlas_client),
) -> dict[str, Any]:
    _validate_account(numero_cuenta)
    _validate_date_range(fecInicio, fecFin)

    offset = _get_offset()

    if detallado:
        movements = await client.consultar_movimientos_detallados(
            numero_cuenta=numero_cuenta,
            fec_inicio=date_to_atlas_iso(fecInicio, start=True, offset=offset),
            fec_fin=date_to_atlas_iso(fecFin, start=False, offset=offset),
            tipo_movimiento=tipoMovimiento,
            cantidad=cantidad,
            descripcion=descripcion,
            incluye_reversa=incluyeReversa,
            orden=orden,
        )
    else:
        movements = await client.consultar_movimientos(
            numero_cuenta=numero_cuenta,
            fec_inicio=date_to_atlas_iso(fecInicio, start=True, offset=offset),
            fec_fin=date_to_atlas_iso(fecFin, start=False, offset=offset),
            tipo_movimiento=tipoMovimiento,
            cantidad=cantidad,
            descripcion=descripcion,
            orden=orden,
        )

    return {"listaMovimiento": movements}


@app.get(
    "/api/movimientos-detalle/{numero_cuenta}",
    response_model=MovementsEnvelope,
    responses={
        400: {"model": AtlasErrorDetail},
        401: {"model": AtlasErrorDetail},
        502: {"model": AtlasErrorDetail},
    },
)
async def movimientos_detalle(
    numero_cuenta: str,
    fecInicio: date = Query(..., description="Fecha inicial en formato YYYY-MM-DD"),
    fecFin: date = Query(..., description="Fecha final en formato YYYY-MM-DD"),
    tipoMovimiento: Literal["D", "C"] | None = Query(default=None),
    cantidad: int | None = Query(default=50, ge=1, le=500),
    descripcion: str | None = Query(default=None, max_length=120),
    orden: Literal["ASC", "DESC"] = Query(default="DESC"),
    incluyeReversa: bool = Query(default=False, description="Incluir movimientos reversados"),
    client: AtlasClient = Depends(get_atlas_client),
) -> dict[str, Any]:
    _validate_account(numero_cuenta)
    _validate_date_range(fecInicio, fecFin)

    offset = _get_offset()

    movements = await client.consultar_movimientos_detallados(
        numero_cuenta=numero_cuenta,
        fec_inicio=date_to_atlas_iso(fecInicio, start=True, offset=offset),
        fec_fin=date_to_atlas_iso(fecFin, start=False, offset=offset),
        tipo_movimiento=tipoMovimiento,
        cantidad=cantidad,
        descripcion=descripcion,
        incluye_reversa=incluyeReversa,
        orden=orden,
    )

    return {"listaMovimiento": movements}


# ---------------------------------------------------------------------------
# API de Transferencias v1.4: catálogos (datos generales)
# ---------------------------------------------------------------------------

@app.get("/api/transferencias/entidades-participantes", response_model=DatosListEnvelope, tags=["transferencias"])
async def entidades_participantes(client: AtlasClient = Depends(get_atlas_client)) -> dict[str, Any]:
    return {"listaDatos": await client.consultar_entidades_participantes()}


@app.get("/api/transferencias/tipos-documentos", response_model=DatosListEnvelope, tags=["transferencias"])
async def tipos_documentos(client: AtlasClient = Depends(get_atlas_client)) -> dict[str, Any]:
    return {"listaDatos": await client.consultar_tipos_documentos()}


@app.get("/api/transferencias/motivos", response_model=DatosListEnvelope, tags=["transferencias"])
async def motivos(client: AtlasClient = Depends(get_atlas_client)) -> dict[str, Any]:
    return {"listaDatos": await client.consultar_motivos()}


@app.post(
    "/api/transferencias/sipap/registrar-operacion",
    tags=["transferencias"],
    responses={
        400: {"model": AtlasErrorDetail},
        401: {"model": AtlasErrorDetail},
        502: {"model": AtlasErrorDetail},
        503: {"model": AtlasErrorDetail},
    },
)
async def registrar_operacion_sipap(
    operacion: RegistrarOperacionSipapRequest,
    client: AtlasClient = Depends(get_atlas_client),
) -> dict[str, Any]:
    """Registra una transferencia SIPAP sólo cuando el perfil productivo está cerrado."""
    if not client.settings.verify_response:
        raise HTTPException(
            status_code=503,
            detail={
                "code": "PREPRODUCTION_READ_ONLY",
                "message": "El registro SIPAP está deshabilitado en modo preproducción.",
            },
        )
    if not _INTERNAL_API_KEY:
        raise HTTPException(
            status_code=503,
            detail={
                "code": "INTERNAL_AUTH_REQUIRED",
                "message": "El registro SIPAP requiere INTERNAL_API_KEY configurada.",
            },
        )
    return await client.registrar_operacion_sipap(operacion.model_dump(exclude_none=True))


@app.get(
    "/api/transferencias/sipap/consultar-operacion",
    tags=["transferencias"],
    responses={
        400: {"model": AtlasErrorDetail},
        401: {"model": AtlasErrorDetail},
        502: {"model": AtlasErrorDetail},
    },
)
async def consultar_operacion_sipap(
    nroReferencia: int | None = Query(default=None),
    nroRefInterna: int | None = Query(default=None),
    client: AtlasClient = Depends(get_atlas_client),
) -> dict[str, Any]:
    return await client.consultar_operacion_sipap(nro_referencia=nroReferencia, nro_ref_interna=nroRefInterna)


@app.get(
    "/api/transferencias/sipap/consultar-operaciones",
    tags=["transferencias"],
    responses={
        400: {"model": AtlasErrorDetail},
        401: {"model": AtlasErrorDetail},
        502: {"model": AtlasErrorDetail},
    },
)
async def consultar_operaciones_sipap(
    fechaDesde: str | None = Query(default=None),
    fechaHasta: str | None = Query(default=None),
    codSwiBeneficiario: str | None = Query(default=None),
    codSwiSolicitante: str | None = Query(default=None),
    estado: Literal["A", "C", "E", "S", "V", "X", "Z"] | None = Query(default=None),
    nroReferencia: int | None = Query(default=None),
    client: AtlasClient = Depends(get_atlas_client),
) -> dict[str, Any]:
    _validate_sipap_date_range(fechaDesde, fechaHasta)
    return await client.consultar_operaciones_sipap(
        fecha_desde=fechaDesde,
        fecha_hasta=fechaHasta,
        cod_swi_beneficiario=codSwiBeneficiario,
        cod_swi_solicitante=codSwiSolicitante,
        estado=estado,
        nro_referencia=nroReferencia,
    )


# ---------------------------------------------------------------------------
# Validadores
# ---------------------------------------------------------------------------

def _validate_account(numero_cuenta: str) -> None:
    """Valida formato de cuenta (política local — MEDIO-04).

    Restricción local: solo dígitos, máximo 30 caracteres.
    No confirmado con Atlas; puede requerir ajuste.
    """
    if not numero_cuenta.isdigit() or len(numero_cuenta) > 30:
        raise HTTPException(
            status_code=400,
            detail={"code": "INVALID_ACCOUNT", "message": "Número de cuenta inválido."},
        )


def _validate_date_range(fec_inicio: date, fec_fin: date) -> None:
    if fec_fin < fec_inicio:
        raise HTTPException(
            status_code=400,
            detail={"code": "INVALID_DATE_RANGE", "message": "Fecha fin no puede ser menor a fecha inicio."},
        )


def _parse_sipap_date(value: str | None) -> datetime | None:
    """Acepta fechas ISO8601 reales sin modificar los valores enviados a Atlas."""
    if value is None:
        return None
    try:
        parsed = datetime.fromisoformat(value)
    except (ValueError, TypeError):
        raise HTTPException(
            status_code=400,
            detail={"code": "INVALID_DATE", "message": "Las fechas deben tener formato ISO8601 válido."},
        ) from None
    return parsed


def _validate_sipap_date_range(fecha_desde: str | None, fecha_hasta: str | None) -> None:
    start = _parse_sipap_date(fecha_desde)
    end = _parse_sipap_date(fecha_hasta)
    if start is None or end is None:
        return
    # Fechas sin hora/zona conservan su significado de calendario. Sólo se
    # comparan como instantes UTC cuando ambas especifican una zona horaria.
    if start.tzinfo is not None and end.tzinfo is not None:
        start, end = start.astimezone(timezone.utc), end.astimezone(timezone.utc)
    else:
        start, end = start.replace(tzinfo=None), end.replace(tzinfo=None)
    if end < start:
        raise HTTPException(
            status_code=400,
            detail={"code": "INVALID_DATE_RANGE", "message": "Fecha fin no puede ser menor a fecha inicio."},
        )


def _get_offset() -> str:
    """Obtiene el offset de zona horaria de la configuración (MEDIO-05)."""
    try:
        settings = AtlasSettings()
        return settings.timestamp_offset
    except Exception:
        return "-03:00"
