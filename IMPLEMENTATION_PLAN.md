# Plan Maestro de Trabajo y Arquitectura: **BankApi**

> **Estado de Ejecución:** EN PROGRESO (Persistido en el repositorio para continuidad entre agentes y sesiones).
> **Repositorio Destino:** `https://github.com/edisonroaa-code/BankApi.git`
> **Directorio de Trabajo:** `C:\Users\Usuario\Desktop\APLICATIVOS\bankApi`

---

## 1. Misión y Propósito del Producto

**BankApi** es un sistema comercial, genérico, universal y llave en mano (*turnkey*) para la **verificación de cobranzas en Caja y Área de Cobranzas**, inspirado en la ingeniería e invariantes de seguridad probadas en producción, pero **100% libre de cualquier referencia a *Classic Center***.

El objetivo comercial de **BankApi** es que, al instalarlo en cualquier empresa compradora, la puesta en marcha se limite únicamente a:
1. **Configurar los datos de la empresa y la API que el banco provea** (o las cuentas bancarias receptoras con API / aprobación manual).
2. **Crear los usuarios de la empresa** (`ADMIN`, `SUPERVISOR`, `CAJERO`, `COBRADOR`).

---

## 2. Orígenes del Código (Solo Lectura — No Modificar los Orígenes)

1. **Sistema Principal**: `C:\Users\Usuario\Desktop\APLICATIVOS\transferencias classic`
   - React 19.2 + TypeScript 5.8 + Vite 6.2 + Tailwind CSS 4.1 + Socket.IO Client 4.8 + PWA + Electron 39.
   - Backend NestJS 11 + TypeORM 0.3.28 + PostgreSQL 16 + Passport JWT + Bcrypt + ExcelJS + PDFKit + Cloudinary.
2. **Laboratorio de Conector Bancario**: `D:\APLICATIVOS\conexion a api del sistema de transferencias`
   - FastAPI + `httpx` + `PyJWT[crypto]` (`api_atlas.py`, `app.py`), integrado en `tools/bank-api-lab/` como kit de homologación y diagnóstico bancario.

> **Regla Crítica de Secretos:** Jamás copiar archivos `.env`, `.env.local`, `.env.neon`, backups SQL ni llaves privadas reales (`keys/*.pem`) desde los repositorios de origen hacia `BankApi`.

---

## 3. Arquitectura y Mejoras del Producto **BankApi**

```mermaid
flowchart TB
    subgraph ClientLayer["Capa Cliente (Web PWA / Desktop Electron)"]
        UI["UI React 19 + Tailwind v4<br/>Tema BankApi (Fintech Emerald & Deep Slate)"]
        Drafts["Persistencia Local Anti-Pérdida<br/>(IndexedDB + LocalStorage)"]
        Print["Motor de Impresión 80mm<br/>Confirmación en 2 Pasos + Marca Dinámica"]
    end

    subgraph CoreAPI["Backend BankApi (NestJS 11)"]
        Auth["Seguridad & RBAC Deny-by-Default<br/>(JWT + TokenVersion + RateLimit)"]
        Setup["Configuración Multi-Empresa<br/>(Nombre Comercial, RUC, Cuentas y Diagnóstico API)"]
        Reconcile["Motor de Conciliación & Tomas<br/>(FOR UPDATE + CHECK Constraints + Match Score)"]
        Feed["Orquestador de Feed Bancario<br/>(Sondeo Compartido 5s por Demanda + Catch-up)"]
    end

    subgraph Adapters["Capa de Adaptadores"]
        BankAdapter["Conector Bancario RS256 (4096 bits)<br/>+ Simulador Demo Comercial"]
        StorageAdapter["Almacenamiento Privado de Comprobantes<br/>(Cloudinary Autenticado / Local)"]
    end

    subgraph DataLayer["Persistencia PostgreSQL 16 (Neon / Docker)"]
        DB[("PostgreSQL<br/>Integridad Financiera + Auditoría Legible")]
    end

    UI <-->|"REST + Socket.IO"| CoreAPI
    CoreAPI --> Adapters
    CoreAPI --> DataLayer
```

### Mejoras Clave Implementadas en **BankApi**

1. **Despersonalización Total (*White-Label* / *Zero Classic Center*)**:
   - Eliminación del 100% de referencias a `Classic Center`, `transferencias-classic`, `py.classic.transferencias`, `window.classic`, `bnf_app_session_v2`, etc.
   - Nuevos identificadores de sesión y almacenamiento local: `bankapi_session_v1`, `bankapi_saved_users_v1`, `bankapi_last_user_v1`, `bankapi_company_profile_v1`.
   - Nuevo namespace IPC en Electron: `window.bankapi` (conservando alias interno por compatibilidad de pruebas si fuera necesario).
2. **Nueva Identidad Visual y Paleta de Colores (**BankApi**)**:
   - **Logo Oficial BankApi**: Nuevo isotipo y logotipo (escudo financiero + pulso de verificación bancaria) generado en `public/logo.png`, `public/favicon.png`, `public/icons/icon-192.png`, `public/icons/icon-512.png`, `resources/icon.png` y `resources/splash.png`.
   - **Paleta Fintech Emerald & Deep Slate**: Navegación en `#0b1120` / `slate-950` con acentos corporativos `emerald-600` (`#059669`) y `teal-600` (`#0d9488`).
3. **Configuración Comercial Multi-Empresa y Cuentas Receptoras Genéricas**:
   - **Perfil de Empresa Configurable**: Nombre de la empresa instalada, subtítulo/RUC y pie de ticket configurables desde el panel de Administración y reflejados automáticamente en:
     - Barra de navegación y pantalla de inicio de sesión.
     - Tickets térmicos de 80 mm (`PrintableTicket` y `BankTransferReceipt`).
     - Reportes exportables en PDF y Excel (`ReportsService`).
   - **Cuentas Receptoras Genéricas**: En lugar de acoplar la UI exclusivamente a *"Atlas vs. BNF"*, las etiquetas operativas se parametrizan (`Cuenta con Verificación API` vs `Cuenta de Verificación Manual`, permitiendo mostrar el nombre del banco configurado por la empresa cliente), manteniendo intacta la columna `isAtlasAccount` en PostgreSQL para preservar compatibilidad con las 6 migraciones versionadas y las 383 pruebas del backend.
4. **Panel de Puesta en Marcha y Diagnóstico Bancario en Admin**:
   - Vista integrada en el panel de `ADMIN` para personalizar los datos comerciales de la empresa, verificar el estado del conector bancario (`EN_VIVO`, `EN_ESPERA`, `SIN_CONFIGURAR`, etc.), consultar la guía rápida de variables de la API del banco y administrar los usuarios de la empresa.

---

## 4. Checklist de Fases para Agentes (Estado de Avance)

- [x] **Fase 0: Documentación en Repositorio y Git Local**
  - [x] Crear `IMPLEMENTATION_PLAN.md` en la raíz del repositorio.
  - [x] Crear `AGENTS.md` adaptado a **BankApi** con todas las reglas de seguridad, gobernanza, escalabilidad y pruebas.
  - [x] Inicializar repositorio Git local y remoto `origin` (`https://github.com/edisonroaa-code/BankApi.git`).
- [ ] **Fase 1: Clonado Base y Limpieza Estructural**
  - [ ] Clonar código fuente limpio del sistema principal (`frontend`, `backend`, `electron`, `scripts`, `public`, `resources`).
  - [ ] Clonar código fuente limpio del laboratorio bancario en `tools/bank-api-lab/`.
  - [ ] Configurar `.gitignore` unificado para evitar subir secretos, `node_modules`, `.venv`, `uploads` o artefactos de compilación.
- [ ] **Fase 2: Rebranding a BankApi, Nuevo Logo y Despersonalización**
  - [ ] Generar nuevos recursos gráficos de **BankApi** (`logo.png`, `favicon.png`, `icon-192.png`, `icon-512.png`, `resources/icon.png`, `resources/splash.png`).
  - [ ] Actualizar `package.json`, `backend/package.json`, `index.html`, `vite.config.ts`, `index.css`, `render.yaml`, `docker-compose.yml`.
  - [ ] Reemplazar referencias a `Classic Center`, `window.classic`, `bnf_app_session_v2` en vistas, componentes, servicios, scripts y Electron.
- [ ] **Fase 3: Parametrización Comercial Multi-Empresa**
  - [ ] Crear servicio de perfil de empresa (`services/company-profile.ts`) y soporte en backend/reportes para que tickets de 80 mm y reportes PDF/Excel usen el nombre de la empresa configurada (por defecto `"BankApi"`).
  - [ ] Generalizar etiquetas de cuentas receptoras en `services/payment-destination.ts` y vistas asociadas.
  - [ ] Agregar pestaña **Configuración** en `AdminDashboard.tsx` para configurar la empresa instalada y diagnosticar la conexión bancaria.
- [ ] **Fase 4: Verificación Integral, Pruebas, Compilación y Push**
  - [ ] Ejecutar `npm run typecheck`.
  - [ ] Ejecutar suite completa de Backend (`npm --prefix backend test -- --runInBand`).
  - [ ] Ejecutar suites de políticas de Frontend (`npm run test:manual-policy`, `npm run test:health`, `npm run test:pwa`, `npm run test:secrets`).
  - [ ] Compilar producción (`npm --prefix backend run build:prod` y `npm run build`).
  - [ ] Verificar con búsqueda automatizada que no existan ocurrencias de `"Classic Center"` ni secretos en el árbol de Git.
  - [ ] Realizar commits estructurados y `git push -u origin main`.
