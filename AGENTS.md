# Instrucciones Operativas y de Gobernanza para Agentes — **BankApi**

Este documento define las reglas técnicas, de seguridad, escalabilidad y gobernanza de **BankApi** (Sistema Universal de Verificación de Cobranzas en Caja y Área de Cobranzas).
Para ver el plan de transformación y el estado de las fases de implementación, consultar [`IMPLEMENTATION_PLAN.md`](./IMPLEMENTATION_PLAN.md).

---

## 1. Principio de Identidad del Producto (Zero Classic Center)

- **Nombre del Producto**: **BankApi**.
- **Prohibición de Marca Anterior**: Ningún archivo de código, interfaz, ticket de impresión, reporte PDF/Excel, manifiesto PWA, instalador Electron o documento de este repositorio debe contener referencias a *"Classic Center"* ni *"transferencias-classic"*.
- **Enfoque Comercial Multi-Empresa**: El sistema está diseñado para instalarse en cualquier empresa compradora limitándose a:
  1. Configurar los parámetros de la API bancaria provista por el banco y los datos comerciales de la empresa.
  2. Crear los usuarios operativos (`ADMIN`, `SUPERVISOR`, `CAJERO`, `COBRADOR`).

---

## 2. Arquitectura en Producción y Entorno Local

- **Frontend**: React 19 + TypeScript + Vite 6 + Tailwind CSS 4 (PWA / Static Site o Desktop con Electron).
- **Backend**: NestJS 11 + TypeORM 0.3 + PostgreSQL 16 + Socket.IO.
- **Almacenamiento de Comprobantes**: Cloudinary (`raw/authenticated` privado) en despliegues Cloud o almacenamiento local protegido en despliegues LAN/On-Premise.
- **Kit de Homologación Bancaria**: `tools/bank-api-lab/` (adaptador Python/FastAPI para pruebas de firma RS256, mTLS/TLS y contratos bancarios).

### Puertos Estándar de Desarrollo
- **Web (Vite dev)**: `5173`
- **API (NestJS)**: `3000`
- **PostgreSQL (Docker)**: `5433`

---

## 3. Reglas de Seguridad y Protección de Datos

1. **Operaciones Destructivas Prohibidas sin Autorización**:
   - No ejecutar `npm run db:reset`, `docker compose down -v`, `scripts/reset_test_data.ps1`, `TRUNCATE`, `DELETE` masivo ni `ALTER USER` en bases productivas sin respaldo verificado y autorización explícita del usuario.
2. **Protección de Esquema**:
   - No ejecutar pruebas E2E contra una base de datos productiva.
   - `DB_SYNCHRONIZE=false` es obligatorio en producción, con SSL o contra cualquier instancia administrada (como Neon). El backend se niega a iniciar si detecta `DB_SYNCHRONIZE=true` en un entorno productivo.
3. **Gestión de Secretos**:
   - Nunca escribir, versionar ni imprimir en consola contraseñas, tokens, connection strings, claves API (`ATLAS_API_KEY`, `CLOUDINARY_URL`, `JWT_SECRET`) ni llaves privadas RSA (`.pem`).
   - Todo secreto proviene exclusivamente de variables de entorno o archivos secretos montados fuera de Git.

---

## 4. Autorización y Control de Acceso (RBAC Deny-by-Default)

- **Guardias Globales**: Todo endpoint HTTP en el backend debe declarar explícitamente `@Roles(...)` o `@Public()`. Los guardias globales (`JwtAuthGuard` + `RolesGuard`) deniegan por defecto (`403 Forbidden`). El test automatizado `backend/src/auth/route-policy.spec.ts` falla si se agrega una ruta sin declaración explícita.
- **Endpoints Públicos Únicos**: Solo `POST /auth/login`, `GET /health` y `GET /health/db` son públicos.
- **No Duplicar Guardias**: No agregar `@UseGuards(AuthGuard('jwt'))` a nivel de controlador individual para no duplicar la validación del token y la consulta de versión de sesión en la base de datos.
- **Matriz de Roles**:
  - `ADMIN`: Único rol autorizado para crear, editar y eliminar usuarios, anular/liberar tomas bancarias, revisar la cola de auditoría, configurar el perfil de empresa y consultar el saldo de la cuenta bancaria a pedido (`GET /bank-feed/balance`).
  - `CAJERO`: Opera exclusivamente en el panel de **Transferencias**, tomando transferencias entrantes por ticket o cliente con datos sensibles del remitente enmascarados. No ve el saldo de la cuenta ni el panel de consultas de cobranzas.
  - `COBRADOR`: Registra consultas de cobro con comprobante y concilia únicamente sus propias consultas desde el módulo **Conciliación** (*Por conciliar* / *Mis conciliadas*) con datos completos para verificar la identidad del pagador.
  - `SUPERVISOR`: Rol de observación e inspección en modo de solo lectura con datos bancarios enmascarados. No toma transferencias, no concilia, no anula ni administra usuarios.
- **Reserva de Nombres de Usuario**: Un nombre de usuario eliminado queda reservado para preservar la trazabilidad histórica en la auditoría (`409 Conflict`).

---

## 5. Migraciones de Base de Datos

- El esquema evoluciona únicamente mediante migraciones versionadas en `backend/src/migrations`.
- La CLI (`backend/src/database/data-source.ts`) lee variables de entorno del proceso para evitar conectarse accidentalmente a un entorno equivocado.
- Comandos desde `backend/`:
  - `npm run migration:show`
  - `npm run migration:run`
  - `npm run migration:generate -- src/migrations/<Nombre>`
  - En producción compilada: `npm run migration:run:prod`
- Nunca habilitar `migrationsRun: true` en el arranque automático de la API.

---

## 6. Feed Bancario, Conciliación e Integridad Financiera

1. **Lectura Estricta**:
   - El conector bancario es **estrictamente de solo lectura** (consulta de movimientos detallados y consulta de saldo a pedido del `ADMIN`). Nunca implementar ni invocar endpoints de débito o transferencia saliente (`registrar-operacion`).
   - `BANK_FEED_MODE=mock` está bloqueado por código cuando `NODE_ENV=production`. Una configuración inválida deja el feed en estado `SIN_CONFIGURAR` sin derribar la API.
2. **Sondeo Compartido por Demanda (5 segundos)**:
   - El sondeo automático corre cada 5 segundos únicamente dentro del horario operativo (`BANK_FEED_HOURS`) y solo cuando existe al menos un panel de **Transferencias** o **Conciliación** abierto y visible (sala Socket.IO `bank-feed:demand`).
   - El botón **Actualizar** (`POST /bank-feed/refresh`) ejecuta una única consulta compartida en el servidor con enfriamiento global de 5 segundos (`REFRESH_COOLDOWN_MS`), espera la respuesta del banco y notifica a todas las pantallas conectadas.
   - Al abrir el primer panel del día, el sistema rescata automáticamente los movimientos ingresados fuera de horario o durante fines de semana/feriados (`BANK_FEED_CATCHUP_DAYS`, 4 días por defecto). Con la base de transferencias vacía, inicia desde las `00:00` del día actual para evitar reimportar transferencias ya cobradas antes de la puesta en marcha.
3. **Garantías Contra el Doble Uso (Anti-Double-Spend)**:
   - Las restricciones `CHECK` en PostgreSQL (`ck_bank_transfers_allocated` en `bank_transfers` y `ck_payments_allocated` en `payments`) garantizan que la suma de las tomas activas jamás supere el monto de la transferencia ni el monto declarado en la consulta.
   - Toda toma o conciliación bloquea la fila con `SELECT ... FOR UPDATE` dentro de una transacción y exige clave de idempotencia (`idempotencyKey`).
4. **Cuentas Receptoras (Con API vs. Aprobación Manual)**:
   - Toda consulta declara explícitamente la cuenta receptora (`isAtlasAccount = true` para cuenta verificada por API bancaria; `false` para cuenta de verificación manual).
   - Una consulta asociada a una cuenta con API (`true`) **solo** puede confirmarse conciliándola con un movimiento bancario real; una consulta manual (`false`) sigue el flujo de revisión manual del administrador.
5. **Motor de Coincidencias Multicriterio (`bank-match.ts`)**:
   - El monto por sí solo nunca identifica un depósito. El motor evalúa referencia bancaria, código/referencia en el concepto, cuenta remitente conocida por historial no ambiguo, cobertura de palabras del nombre del remitente, banco de origen, moneda y cercanía temporal, recorriendo la ventana en lotes con cursor por UUID.
6. **Protección de Formularios y Borradores**:
   - El sondeo y los eventos en tiempo real nunca cierran modales abiertos ni borran lo que el operador está tipeando.
   - El formulario de nueva consulta del cobrador persiste automáticamente su borrador en el dispositivo (`services/consulta-draft.ts`: campos en `localStorage` y archivo de comprobante en `IndexedDB` por 24 h).
7. **Impresión Térmica de 80 mm en Dos Pasos**:
   - Abrir el diálogo de impresión (`POST .../print-preview`) solo audita la apertura.
   - El contador de impresiones (`printCount`) y la marca `printedAt` se registran únicamente cuando el operador confirma **"Sí, salió impreso"** (`POST .../print`) desde el diálogo único en `App.tsx`, notificando a todas las vistas mediante `services/print-events.ts`.

---

## 7. Healthcheck y Consumo de Base de Datos Serverless (Neon)

- `GET /health` es *liveness* puro y **no consulta PostgreSQL**. Debe ser el único endpoint conectado al monitor de plataforma (Render / Docker healthcheck).
- `GET /health/db` es *readiness* manual de diagnóstico y ejecuta un `SELECT 1`. Nunca conectarlo a un cron o monitor periódico para no impedir la suspensión por inactividad (*scale-to-zero*) en bases serverless.

---

## 8. Verificación Mínima Obligatoria Antes de Entregar o Publicar

1. **Tipado Frontend**: `npm run typecheck`
2. **Suite de Pruebas Backend**: `npm --prefix backend test -- --runInBand`
3. **Controles de Políticas y Contratos Frontend**:
   - `npm run test:manual-policy`
   - `npm run test:health`
   - `npm run test:pwa`
   - `npm run test:secrets`
4. **Compilaciones de Producción**:
   - `npm --prefix backend run build:prod`
   - `npm run build`
5. **Auditoría de Marca y Secretos**:
   - Cero ocurrencias de `"Classic Center"` en código fuente, vistas, tickets y reportes.
   - Cero archivos `.env` o llaves privadas `.pem` en `git status`.
