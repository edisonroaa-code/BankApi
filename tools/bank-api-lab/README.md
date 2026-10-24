# BankApi Connect — Kit de Homologación y Diagnóstico Bancario

Adaptador web aislado (FastAPI + `httpx` + `PyJWT[crypto]`) incluido en **BankApi** para homologar credenciales bancarias, validar firmas JWT RS256 (4096 bits) y auditar contratos de APIs bancarias (Saldo, Movimientos Detallados, Alias y SIPAP) antes de activar una cuenta en el backend principal.

## Contratos Soportados

- **API de Consulta de Saldo v0.9** (`GET /api/saldo/{cuenta}`)
- **API de Consulta de Movimientos v1.1** (`GET /api/movimientos/{cuenta}` y `/api/movimientos-detalle/{cuenta}`)
- **API de Transferencias SIPAP v1.4** (Catálogos y consulta de estado de operaciones)
- **API de Consulta de Alias v0.1** (`GET /api/alias`)

## Configuración Rápida

1. Copiar `.env.example` como `.env` (nunca versionar `.env`).
2. Configurar las URLs provistas por el banco (`ATLAS_BASE_URL`, `ATLAS_TRANSFERENCIAS_BASE_URL`, `ATLAS_DATOS_GENERALES_BASE_URL`).
3. Configurar `ATLAS_API_KEY`, `ATLAS_ACCOUNT_AUTH_TOKEN`, `ATLAS_JWT_ISS` y `ATLAS_JWT_SUB`.
4. Colocar la clave privada RSA de 4096 bits en `keys/` (directorio ignorado por Git) y apuntar `ATLAS_PRIVATE_KEY_PATH`.
5. Opcionalmente definir `INTERNAL_API_KEY` para proteger los endpoints locales con cabecera `X-Internal-ApiKey`.

## Ejecución Local

```powershell
python -m venv .venv
.venv\Scripts\Activate.ps1
pip install -r requirements.txt -c requirements.lock
uvicorn app:app --host 127.0.0.1 --port 48880 --reload --no-access-log
```

Abrir `http://localhost:48880`.

## Ejecución de Pruebas del Conector

```powershell
pip install -r requirements-dev.txt -c requirements.lock
python -m pytest tests/ -v --ignore=tests/test_deployment_regressions.py
node --test tests/test_frontend_regressions.js
```
