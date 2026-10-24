# BankApi — Plataforma Empresarial de Verificación de Cobranzas y Transferencias Bancarias

<p align="center">
  <img src="public/logo.png" alt="BankApi Logo" width="110" />
</p>

**BankApi** es una solución empresarial *turnkey* (lista para instalar y operar) para la verificación en tiempo real de transferencias bancarias tanto en **Caja (`CAJERO`)** como en el **Área de Cobranzas (`COBRADOR`, `SUPERVISOR`, `ADMIN`)**.

Al desplegarla en una nueva empresa cliente, la puesta en marcha se limita únicamente a:
1. **Configurar las credenciales de la API bancaria** provistas por el banco de la empresa en el entorno del servidor (`backend/.env`).
2. **Personalizar los datos de la empresa** (Razón Social, RUC, pie de ticket térmico 80mm) y **crear los usuarios operativos** desde el **Panel de Administración**.

---

## Arquitectura del Sistema

| Capa | Stack Tecnológico | Propósito |
| :--- | :--- | :--- |
| **Frontend Web / PWA / Desktop** | React 19 + TypeScript 5.8 + Vite 6 + Tailwind CSS 4 + Electron 39 | Interfaz reactiva para Caja y Cobranzas, impresión térmica 80mm y empaquetado de escritorio Windows (Cliente / Servidor). |
| **Backend API & Tiempo Real** | NestJS 11 + TypeORM 0.3 + Socket.IO 4.8 + PostgreSQL 16 | Reglas de negocio transaccionales, RBAC estricto, auditoría inmutable, reportes Excel/PDF y sincronización por WebSockets. |
| **Conector Bancario Integrado** | `backend/src/bank/` + `tools/bank-api-lab/` (FastAPI) | Integración bancaria de solo lectura firmada con **JWT RS256 (RSA 4096-bit)**, `content-hash` SHA-256, validación de contratos y laboratorio diagnóstico. |

---

## Seguridad, Escalabilidad y Gobernabilidad Financiera

1. **Cero Doble Uso de Transferencias (`SELECT ... FOR UPDATE` + `CHECK` Constraints)**:
   - Tanto la toma en Caja (`claim`) como la conciliación de consultas (`reconcile`) bloquean la fila de la transferencia bancaria con `pessimistic_write` (`SELECT ... FOR UPDATE`) dentro de una transacción ACID.
   - Restricciones en PostgreSQL (`ck_bank_transfers_allocated`, `ck_payments_allocated`) garantizan que la suma de asignaciones jamás supere el monto de la transferencia ni el monto de la consulta.
2. **Impresión Térmica 80mm en Dos Pasos**:
   - Abrir la vista previa registra el intento (`ticketPrintAttempts`), pero el ticket o comprobante **solo se marca como impreso** (`printedAt` + `TICKET_PRINTED` en auditoría) cuando el operador confirma explícitamente en el diálogo post-impresión (`"Sí, salió impreso"`).
   - Ningún pago puede marcarse como entregado en caja sin haber confirmado previamente la impresión física del ticket.
3. **Sondeo Bancario Inteligente por Demanda (Cada 5s)**:
   - El backend consulta la API bancaria únicamente cuando existe al menos un panel de transferencias o conciliación abierto y visible (`bank-panel:open` vía Socket.IO) dentro del horario operativo (`BANK_FEED_HOURS`), más un barrido automático de recuperación (`BANK_FEED_CATCHUP_DAYS`) al abrir el primer panel del día.
4. **Gobernabilidad de Roles (`RolesGuard` Global)**:
   - `CAJERO`: Panel exclusivo de transferencias entrantes, toma de transferencias por número de factura/recibo e impresión de comprobante 80mm.
   - `COBRADOR`: Carga de consultas con adjunto (imagen/PDF), seguimiento de sus propias consultas y conciliación contra transferencias bancarias disponibles.
   - `SUPERVISOR`: Supervisión en vivo de la cola de revisión, KPIs y reportes.
   - `ADMIN`: Control total, aprobación/rechazo manual con bloqueo de colisiones bancarias, gestión de usuarios, auditoría y configuración del sistema.

---

## Guía Rápida de Instalación para Nuevas Empresas

### 1. Requisitos Previos
- **Node.js** 20+ y **npm**
- **PostgreSQL** 15/16 (local, Docker o Neon Serverless)
- *(Opcional)* **Python 3.11+** para ejecutar el laboratorio de diagnóstico bancario en `tools/bank-api-lab`

### 2. Configurar el Backend (`backend/.env`)
Copiá la plantilla `backend/.env.example` a `backend/.env` y completá las variables de la empresa y del banco:

```bash
cp backend/.env.example backend/.env
```

Variables principales:
```ini
PORT=3000
NODE_ENV=production
COMPANY_NAME="Nombre de la Empresa S.A."
JWT_SECRET=clave_secreta_aleatoria_de_64_caracteres

# Base de datos PostgreSQL
DB_HOST=localhost
DB_PORT=5433
DB_USERNAME=postgres
DB_PASSWORD=tu_password_seguro
DB_DATABASE=transferencias_db

# Conector de API Bancaria (Solo lectura)
BANK_FEED_MODE=atlas
BANK_FEED_ACCOUNT=NUMERO_DE_CUENTA_BANCARIA
BANK_FEED_HOURS=07:00-20:00
BANK_FEED_INTERVAL_SECONDS=5
BANK_FEED_CATCHUP_DAYS=4

ATLAS_BASE_URL=https://secure.atlas.com.py/api2-n/cuentas-atlas
ATLAS_API_KEY=API_KEY_PROVISTA_POR_EL_BANCO
ATLAS_ACCOUNT_AUTH_TOKEN=TOKEN_DE_CUENTA_PROVISTO_POR_EL_BANCO
ATLAS_PRIVATE_KEY_PEM="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----"
ATLAS_JWT_ISS=IDENTIFICADOR_ISS_EMPRESA
ATLAS_JWT_SUB=IDENTIFICADOR_SUB_EMPRESA
ATLAS_VERIFY_RESPONSE=false
```

### 3. Ejecutar Migraciones e Iniciar el Sistema
```bash
# Instalar dependencias
npm install
npm --prefix backend install

# Ejecutar migraciones en PostgreSQL
npm --prefix backend run migration:run

# Desarrollo (Frontend :5173 + Backend :3000)
npm run dev:all

# Compilación de Producción
npm --prefix backend run build:prod
npm run build
```

### 4. Personalización en el Panel de Administración
1. Iniciá sesión con un usuario `ADMIN`.
2. Abrí **Panel de Administración → Configuración**:
   - Configurá el **Nombre de la Empresa**, **RUC** y **Pie de Ticket 80mm** (se reflejan al instante en todos los tickets térmicos y pantallas).
   - Ejecutá **Probar Conexión Bancaria** para verificar el estado del conector bancario en vivo.
3. Abrí **Panel de Administración → Usuarios** para dar de alta a los operadores de **Caja**, **Cobradores**, **Supervisores** y **Administradores**.

---

## Verificación de Calidad y Seguridad

```bash
# Tests unitarios y de políticas de seguridad del Backend (Jest)
npm --prefix backend test -- --runInBand

# Tests de políticas de aprobación manual, impresión en dos pasos, destino bancario y salud
npm run test:manual-policy
npm run test:health
npm run test:secrets

# Verificación estricta de tipos TypeScript
npm run typecheck
```
