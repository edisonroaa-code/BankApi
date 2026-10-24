// ---------------------------------------------------------------------------
// Configuración
// ---------------------------------------------------------------------------

// Intervalo de refresco del buzón, en segundos.
// Valor conservador a propósito: ningún manual define límite de tasa ni política
// de 429 para consulta de movimientos, así que se toma el único intervalo que el
// banco nombra (>= 60 s, en "Recomendaciones para Implementación" del v1.4).
// Ajustar cuando Atlas confirme su política.
const REFRESH_SECONDS = 60;

// La configuración productiva usa un espacio propio. Nunca se migra la cuenta
// guardada por la pantalla de laboratorio, porque podría no estar habilitada
// para el AUTH productivo y provocar consultas involuntarias.
const STORAGE_KEY = "atlas.buzon.production.v1";
const LEGACY_STORAGE_KEYS = Object.freeze(["atlas.buzon.v1"]);

// ---------------------------------------------------------------------------
// Elementos
// ---------------------------------------------------------------------------

const form = document.querySelector("#queryForm");
const submitButton = document.querySelector("#submitButton");
const statusBadge = document.querySelector("#serviceStatus");
const tableBody = document.querySelector("#movementsTable");
const movementCount = document.querySelector("#movementCount");
const movementEndpointType = document.querySelector("#movementEndpointType");
const additionalInfoCard = document.querySelector("#additionalInfoCard");
const activeAccountBadge = document.querySelector("#activeAccount");
const autoRefreshSwitch = document.querySelector("#autoRefresh");
const countdownEl = document.querySelector("#countdown");
const refreshNowButton = document.querySelector("#refreshNow");
const newCountBadge = document.querySelector("#newCount");
const markSeenButton = document.querySelector("#markSeen");
const queryInfoEl = document.querySelector("#queryInfo");
const lastUpdateEl = document.querySelector("#lastUpdate");
const internalApiKeyField = document.querySelector("#internalApiKey");
const balanceStatus = document.querySelector("#balanceStatus");
const movementStatus = document.querySelector("#movementStatus");

const balanceFields = {
  available: document.querySelector("#availableBalance"),
  total: document.querySelector("#totalBalance"),
  currency: document.querySelector("#currency"),
  product: document.querySelector("#productBadge"),
  pendingDeposit: document.querySelector("#pendingDeposit"),
  averageBalance: document.querySelector("#averageBalance"),
  blockedBalance: document.querySelector("#blockedBalance"),
  protectedBalance: document.querySelector("#protectedBalance"),
  overdraftLimit: document.querySelector("#overdraftLimit"),
  pendingMovements: document.querySelector("#pendingMovements"),
};

// ---------------------------------------------------------------------------
// Estado
// ---------------------------------------------------------------------------

let currentMovements = [];
let seenKeys = new Set();
let newKeys = new Set();
let baselineDone = false;
let isFetching = false;
let queryActivated = false;
let queryGeneration = 0;
let secondsLeft = REFRESH_SECONDS;
let detailModal = null;
let toolModal = null;
const baseTitle = document.title;

document.addEventListener("DOMContentLoaded", () => {
  if (window.bootstrap) {
    detailModal = new bootstrap.Modal(document.querySelector("#movementDetailModal"));
    toolModal = new bootstrap.Modal(document.querySelector("#toolModal"));
  }
});

// ---------------------------------------------------------------------------
// Configuración persistida (la cuenta no se reescribe en cada consulta)
// ---------------------------------------------------------------------------

function loadConfig() {
  let saved = {};
  try {
    for (const legacyKey of LEGACY_STORAGE_KEYS) {
      localStorage.removeItem(legacyKey);
    }
    saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
  } catch (_) {
    saved = {};
  }

  document.querySelector("#accountNumber").value = saved.account || "";
  document.querySelector("#movementType").value = saved.movementType || "";
  document.querySelector("#limit").value = saved.limit || 50;
  document.querySelector("#detailedMovements").checked = saved.detailed !== false;
  document.querySelector("#includeReversed").checked = Boolean(saved.includeReversed);

  // El rango arranca en "hoy" cada vez: un buzón mira el día en curso y así no
  // queda un rango viejo guardado que oculte los movimientos de hoy.
  const today = toDateInput(new Date());
  document.querySelector("#startDate").value = today;
  document.querySelector("#endDate").value = today;

  return readForm();
}

function saveConfig(config) {
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        account: config.account,
        movementType: config.movementType,
        limit: config.limit,
        detailed: config.detailed,
        includeReversed: config.includeReversed,
      })
    );
  } catch (_) {
    // localStorage puede estar bloqueado; la pantalla sigue funcionando.
  }
}

function readForm() {
  return {
    account: document.querySelector("#accountNumber").value.trim(),
    startDate: document.querySelector("#startDate").value,
    endDate: document.querySelector("#endDate").value,
    movementType: document.querySelector("#movementType").value,
    limit: document.querySelector("#limit").value,
    detailed: document.querySelector("#detailedMovements").checked,
    includeReversed: document.querySelector("#includeReversed").checked,
  };
}

let config = loadConfig();

// ---------------------------------------------------------------------------
// Buzón
// ---------------------------------------------------------------------------

/** Identidad estable de un movimiento, para detectar los que son nuevos. */
function movementKey(movement) {
  return [
    movement.numeroCuenta,
    movement.fechaMovimiento,
    movement.nroDocumento ?? "",
    movement.monto,
    movement.tipoMovimiento,
    movement.nroTransaccionBancard ?? "",
    movement.infoAdicional?.cod_transaccion ?? "",
    movement.infoAdicional?.cod_tra_padre ?? "",
  ].join("|");
}

/**
 * Refresca saldo y movimientos.
 * @param {boolean} silent refresco automático: conserva los datos sólo mientras
 *   llegan las respuestas; una consulta fallida retira sus datos anteriores.
 */
async function refresh(silent) {
  if (isFetching) return;

  if (!config.account || !config.startDate || !config.endDate) {
    showToast("Configure la cuenta y el rango en Opciones → Parámetros de consulta.", "warning");
    return;
  }

  isFetching = true;
  queryActivated = false;
  const generation = ++queryGeneration;
  const requestConfig = { ...config };
  const requestInternalKey = internalApiKeyField.value.trim();
  const isCurrentQuery = () => generation === queryGeneration;
  setLoading(true);

  if (!silent) {
    clearPreviousResults();
  }
  balanceStatus.textContent = "Consultando saldo…";
  movementStatus.textContent = "Consultando movimientos…";
  queryInfoEl.textContent = "Consulta en curso";
  setStatus("info", silent ? "Actualizando…" : "Consultando…");

  const reportFailure = (label, error) => {
    queryActivated = false;
    countdownEl.textContent = "--";
    setStatus("warning", `Error en ${label.toLowerCase()}`);
    queryInfoEl.textContent = `${label} con error; la otra consulta puede estar en curso`;
    showToast(`${label}: ${friendlyErrorMessage(error)}`, "danger");
  };

  try {
    const results = await Promise.allSettled([
      fetchJson(`/api/saldo/${encodeURIComponent(requestConfig.account)}`, requestInternalKey).then((balance) => {
        if (!isCurrentQuery()) return;
        validateBalanceForDisplay(balance, requestConfig);
        renderBalance(balance);
        balanceStatus.textContent = "Saldo actualizado";
      }).catch((error) => {
        if (!isCurrentQuery()) return;
        clearBalanceResults();
        balanceStatus.textContent = "Saldo no disponible";
        reportFailure("Saldo", error);
        throw error;
      }),
      fetchJson(buildMovementsUrl(requestConfig), requestInternalKey).then((movements) => {
        if (!isCurrentQuery()) return;
        validateMovementsForDisplay(movements, requestConfig);
        currentMovements = movements.listaMovimiento;
        trackNewMovements(currentMovements);
        renderMovements(currentMovements);
        movementStatus.textContent = "Movimientos actualizados";
      }).catch((error) => {
        if (!isCurrentQuery()) return;
        renderMovementError(error);
        movementStatus.textContent = "Movimientos no disponibles";
        reportFailure("Movimientos", error);
        throw error;
      }),
    ]);
    if (!isCurrentQuery()) return;

    const balanceOk = results[0].status === "fulfilled";
    const movementsOk = results[1].status === "fulfilled";
    balanceStatus.textContent = balanceOk ? "Saldo actualizado" : "Saldo no disponible";
    movementStatus.textContent = movementsOk ? "Movimientos actualizados" : "Movimientos no disponibles";
    movementEndpointType.textContent = requestConfig.detailed
      ? "Movimientos detallados"
      : "Movimientos";

    if (!balanceOk) clearBalanceResults();
    if (!movementsOk) {
      renderMovementError(results[1].reason);
    }

    if (balanceOk && movementsOk) {
      queryActivated = true;
      setStatus("success", "Al día");
    } else {
      // Una consulta incompleta requiere un nuevo intento manual; no se insiste
      // automáticamente contra una cuenta o una clave rechazada.
      queryActivated = false;
      countdownEl.textContent = "--";
      setStatus(balanceOk || movementsOk ? "warning" : "danger", balanceOk || movementsOk ? "Consulta parcial" : "Error");
    }

    lastUpdateEl.textContent = balanceOk || movementsOk ? new Date().toLocaleTimeString("es-PY") : "--";
    queryInfoEl.textContent = balanceOk && movementsOk
      ? `Cuenta ${requestConfig.account}`
      : `${balanceOk ? "Saldo actualizado" : "Saldo con error"} · ${movementsOk ? "Movimientos actualizados" : "Movimientos con error"}`;
  } finally {
    if (isCurrentQuery()) {
      isFetching = false;
      setLoading(false);
      secondsLeft = REFRESH_SECONDS;
    }
  }
}

function validateBalanceForDisplay(balance, requestConfig = config) {
  if (!balance || balance.nroCuenta !== requestConfig.account ||
      !isMoneyNumber(balance.saldo) || !isMoneyNumber(balance.saldoDisponible) ||
      !isCurrencyCode(balance.moneda)) {
    throw makeUiError(502, "INVALID_RESPONSE");
  }
}

function validateMovementsForDisplay(envelope, requestConfig = config) {
  if (!envelope || !Array.isArray(envelope.listaMovimiento) || envelope.listaMovimiento.some((item) =>
    !item || item.numeroCuenta !== requestConfig.account || !isMoneyNumber(item.monto) ||
    !isCurrencyCode(item.moneda) || !movementTypeInfo(item.tipoMovimiento) ||
    !parseDisplayDate(item.fechaMovimiento))) {
    throw makeUiError(502, "INVALID_RESPONSE");
  }
}

/** Marca como nuevos los movimientos que no estaban en la lectura anterior. */
function trackNewMovements(movements) {
  const keys = movements.map(movementKey);

  if (!baselineDone) {
    // Primera lectura: es la línea de base, nada es "nuevo".
    keys.forEach((key) => seenKeys.add(key));
    baselineDone = true;
  } else {
    keys.forEach((key) => {
      if (!seenKeys.has(key)) {
        newKeys.add(key);
        seenKeys.add(key);
      }
    });
  }

  renderNewCount();
}

function renderNewCount() {
  const count = newKeys.size;
  newCountBadge.textContent = `${count} ${count === 1 ? "nuevo" : "nuevos"}`;
  newCountBadge.classList.toggle("d-none", count === 0);
  markSeenButton.classList.toggle("d-none", count === 0);
  // El contador viaja en el título para verse aunque la pestaña esté en segundo plano.
  document.title = count ? `(${count}) ${baseTitle}` : baseTitle;
}

markSeenButton.addEventListener("click", () => {
  newKeys.clear();
  renderNewCount();
  renderMovements(currentMovements);
});

// ---------------------------------------------------------------------------
// Refresco automático
// ---------------------------------------------------------------------------

window.setInterval(() => {
  if (!queryActivated || !autoRefreshSwitch.checked || !config.account) {
    countdownEl.textContent = "--";
    return;
  }

  secondsLeft -= 1;
  countdownEl.textContent = `${Math.max(secondsLeft, 0)}s`;

  if (secondsLeft <= 0) {
    secondsLeft = REFRESH_SECONDS;
    refresh(true);
  }
}, 1000);

refreshNowButton.addEventListener("click", () => form.requestSubmit());

form.addEventListener("submit", (event) => {
  event.preventDefault();
  config = readForm();

  if (!config.account) {
    showToast("Ingrese un número de cuenta.", "warning");
    return;
  }

  invalidateQuery();
  saveConfig(config);
  activeAccountBadge.textContent = displayText(`Cuenta ${config.account}`);

  // Cambió la cuenta o el filtro: se rehace la línea de base.
  seenKeys = new Set();
  newKeys = new Set();
  baselineDone = false;
  renderNewCount();

  const panel = bootstrap.Offcanvas.getInstance(document.querySelector("#filtersPanel"));
  if (panel) panel.hide();

  refresh(false);
});

if (config.account) {
  activeAccountBadge.textContent = displayText(`Cuenta ${config.account}`);
}

function invalidateQuery() {
  queryGeneration += 1;
  queryActivated = false;
  isFetching = false;
  setLoading(false);
  countdownEl.textContent = "--";
  clearPreviousResults();
  newKeys.clear();
  renderNewCount();
  balanceStatus.textContent = "Sin consultar";
  movementStatus.textContent = "Sin consultar";
  setStatus("secondary", "Configuración cambiada");
  queryInfoEl.textContent = "Pulse Aplicar y consultar";
  tableBody.innerHTML = '<tr><td colspan="7" class="text-center text-secondary py-5">La configuración cambió. Pulse Aplicar y consultar.</td></tr>';
}

internalApiKeyField.addEventListener("input", invalidateQuery);
form.addEventListener("input", (event) => {
  if (event.target !== internalApiKeyField) invalidateQuery();
});

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

function buildMovementsUrl(cfg) {
  const params = new URLSearchParams({
    fecInicio: cfg.startDate,
    fecFin: cfg.endDate,
    orden: "DESC",
  });

  if (cfg.movementType) params.set("tipoMovimiento", cfg.movementType);
  if (cfg.limit) params.set("cantidad", cfg.limit);
  if (cfg.detailed) {
    params.set("detallado", "true");
    if (cfg.includeReversed) params.set("incluyeReversa", "true");
  }

  return `/api/movimientos/${encodeURIComponent(cfg.account)}?${params.toString()}`;
}

async function fetchJson(url, internalKey = internalApiKeyField.value.trim()) {
  const headers = { Accept: "application/json" };
  // La clave interna se toma sólo de este campo en memoria, nunca de storage.
  if (internalKey) headers["X-Internal-ApiKey"] = internalKey;
  let response;
  try {
    response = await fetch(url, { headers, cache: "no-store" });
  } catch (_) {
    throw makeUiError(undefined, "CONNECTION_ERROR");
  }
  const payload = await response.json().catch(() => null);

  if (!response.ok) {
    const detail = payload?.detail || payload || {};
    const code = typeof detail.code === "string" && detail.code ? detail.code : "";
    throw makeUiError(response.status, code);
  }

  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw makeUiError(502, "INVALID_RESPONSE");
  }
  return payload;
}

function makeUiError(status, code) {
  const error = new Error(friendlyErrorMessage({ status, code }));
  // Se conservan para diagnóstico y control de reintentos, nunca en el texto.
  error.status = status;
  error.code = code;
  return error;
}

function friendlyErrorMessage(error) {
  if (error.status === 401 && error.code === "UNAUTHORIZED") {
    return "El adaptador requiere una Clave interna válida. Ingrésela en Opciones → Parámetros de consulta; no use credenciales del banco.";
  }
  if (error.status === 401 || error.status === 403) return "El banco no autorizó esta consulta. Revise la cuenta o solicite asistencia.";
  if (error.code === "INVALID_ACCOUNT") return "Ingrese un número de cuenta válido.";
  if (error.code === "INVALID_DATE_RANGE") return "La fecha final debe ser igual o posterior a la fecha inicial.";
  if (error.status === 400 || error.status === 422) return "Revise la cuenta y los parámetros de la consulta.";
  if (error.status === 429) return "El servicio está ocupado. Espere un momento y vuelva a consultar.";
  if (["ATLAS_CONTRACT_ERROR", "ATLAS_INTEGRITY_ERROR", "INVALID_RESPONSE"].includes(error.code)) {
    return "No se pudieron leer los datos de la consulta. Vuelva a intentar; si continúa, solicite asistencia.";
  }
  if (error.code === "CONNECTION_ERROR") return "No se pudo conectar con el servicio. Revise la conexión y vuelva a consultar.";
  return "No se pudo completar la consulta. Vuelva a intentar más tarde.";
}

function clearBalanceResults() {
  Object.values(balanceFields).forEach((el) => {
    el.textContent = "--";
  });
  additionalInfoCard.classList.add("d-none");
}

function renderMovementError(error) {
  currentMovements = [];
  newKeys.clear();
  renderNewCount();
  movementCount.textContent = "-- registros";
  tableBody.innerHTML = `<tr><td colspan="7" class="text-center text-danger py-5">
    <strong>Error en movimientos:</strong> ${escapeHtml(friendlyErrorMessage(error))}
  </td></tr>`;
}

function clearPreviousResults() {
  clearBalanceResults();
  balanceStatus.textContent = "Consultando saldo…";
  movementStatus.textContent = "Consultando movimientos…";
  lastUpdateEl.textContent = "--";
  queryInfoEl.textContent = "--";
  tableBody.innerHTML =
    '<tr><td colspan="7" class="text-center text-secondary py-5">Consultando…</td></tr>';
  movementCount.textContent = "0 registros";
  currentMovements = [];
}

function renderBalance(balance) {
  const currency = balance.moneda || "--";
  balanceFields.available.textContent = formatMoney(balance.saldoDisponible, currency);
  balanceFields.total.textContent = formatMoney(balance.saldo, currency);
  balanceFields.currency.textContent = currency;

  if (balance.producto?.descripcion) {
    balanceFields.product.textContent = displayText(balance.producto.descripcion);
  } else {
    balanceFields.product.textContent = "Cuenta bancaria";
  }

  const info = balance.infoAdicional || {};
  balanceFields.pendingDeposit.textContent = formatMoney(balance.depositoConfirmar, currency);
  balanceFields.averageBalance.textContent = formatMoney(balance.saldoPromedio, currency);
  // null = el banco no informó el dato; formatMoney lo muestra como "--".
  balanceFields.blockedBalance.textContent = formatMoney(balance.saldoBloqueado, currency);
  balanceFields.protectedBalance.textContent = formatMoney(balance.saldoProtegido, currency);
  balanceFields.overdraftLimit.textContent = formatMoney(info.linea_sobregiro, currency);
  balanceFields.pendingMovements.textContent = formatMoney(info.monto_mov_pendientes, currency);

  additionalInfoCard.classList.remove("d-none");
}

function renderMovements(movements) {
  movementCount.textContent = `${movements.length} registros`;

  if (!movements.length) {
    tableBody.innerHTML =
      '<tr><td colspan="7" class="text-center text-secondary py-5">Sin movimientos para el rango seleccionado.</td></tr>';
    return;
  }

  tableBody.innerHTML = movements
    .map((movement, index) => {
      const typeInfo = movementTypeInfo(movement.tipoMovimiento);
      const amountClass = typeInfo?.className || "text-secondary";
      const typeText = typeInfo?.label || "No informado";
      const isNew = newKeys.has(movementKey(movement));

      const info = movement.infoAdicional || {};
      const senderName = info.nom_remitente || "";
      const senderDoc = info.nro_doc_remitente ? `Doc: ${info.nro_doc_remitente}` : "";

      // MEDIO-06: reversado ausente → "No informado", no "false"
      const isReversed = info.reversado === "S";

      let conceptHtml = escapeHtml(movement.concepto || "");
      if (info.des_transaccion && info.des_transaccion !== movement.concepto) {
        conceptHtml += `<br><small class="text-muted">${escapeHtml(info.des_transaccion)}</small>`;
      }

      let senderHtml = "--";
      if (senderName) {
        senderHtml = `<span class="fw-medium text-dark">${escapeHtml(senderName)}</span>`;
        if (senderDoc) {
          senderHtml += `<br><small class="text-muted">${escapeHtml(senderDoc)}</small>`;
        }
      }

      // ALTO-01: escapeHtml aplicado a todo valor interpolado.
      let docText = escapeHtml(String(movement.nroDocumento ?? ""));
      // MEDIO-06: Bancard 0 debe mostrarse como "0", no ocultarse.
      if (movement.nroTransaccionBancard !== null && movement.nroTransaccionBancard !== undefined) {
        docText += `<br><small class="text-muted">Bancard: ${escapeHtml(String(movement.nroTransaccionBancard))}</small>`;
      }

      const rowClasses = ["mov-row"];
      if (isNew) rowClasses.push("mov-nueva");
      if (isReversed) rowClasses.push("table-warning");

      return `
      <tr class="${rowClasses.join(" ")}" data-index="${index}" tabindex="0" role="button" aria-label="Ver detalle del movimiento">
        <td class="text-center">${isNew ? '<span class="badge text-bg-success">NUEVO</span>' : ""}</td>
        <td>
          <div>${escapeHtml(formatDate(movement.fechaMovimiento))}</div>
          ${movement.fechaProceso ? `<small class="text-muted">Proc: ${escapeHtml(formatDate(movement.fechaProceso))}</small>` : ""}
        </td>
        <td>${conceptHtml}</td>
        <td>${senderHtml}</td>
        <td>${docText || "--"}</td>
        <td>
          <span class="${amountClass} fw-semibold">${typeText}</span>
          ${isReversed ? '<span class="badge text-bg-warning ms-1">Reversado</span>' : ""}
        </td>
        <td class="text-end ${amountClass} fw-semibold">${escapeHtml(formatMoney(movement.monto, movement.moneda))}</td>
      </tr>
    `;
    })
    .join("");
}

// Detalle al clicar el movimiento (delegación: evita handlers inline).
tableBody.addEventListener("click", (event) => {
  const row = event.target.closest("tr[data-index]");
  if (row) openDetailModal(Number(row.dataset.index));
});

tableBody.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" && event.key !== " ") return;
  const row = event.target.closest("tr[data-index]");
  if (row) {
    event.preventDefault();
    openDetailModal(Number(row.dataset.index));
  }
});

// Detalle de negocio: las claves y códigos de auditoría quedan en el contrato,
// pero no se presentan como datos operativos al usuario.
function openDetailModal(index) {
  const item = currentMovements[index];
  if (!item) return;

  const info = item.infoAdicional || {};

  const mainRows = [
    ["Concepto", item.concepto],
    ["Monto", formatMoney(item.monto, item.moneda)],
    ["Tipo de movimiento", movementTypeInfo(item.tipoMovimiento)?.label || "No informado"],
    ["Moneda", item.monedaDetalle?.nombre || item.moneda],
    ["Número de cuenta", item.numeroCuenta],
    ["Fecha del movimiento", formatDate(item.fechaMovimiento)],
    ["Fecha de procesamiento", item.fechaProceso ? formatDate(item.fechaProceso) : null],
    ["Documento", item.nroDocumento],
    [
      "Referencia Bancard",
      item.nroTransaccionBancard,
    ],
  ];

  const infoRows = [
    ["Remitente", info.nom_remitente],
    ["Documento del remitente", info.nro_doc_remitente],
    ["Cuenta del remitente", info.nro_cta_remitente],
    ["Descripción de la operación", info.des_transaccion],
    ["Categoría de la operación", displayText(info.des_tra_padre).trim() !== displayText(info.des_transaccion).trim() ? info.des_tra_padre : null],
    ["Concepto de la transferencia", info.concepto],
    ["Reversado", info.reversado === "S" ? "Sí" : info.reversado === "N" ? "No" : "No informado"],
  ];

  document.querySelector("#modalContent").innerHTML = renderRowsTable([...mainRows, ...infoRows]);
  if (detailModal) detailModal.show();
}

function renderRowsTable(rows) {
  return `
    <div class="table-responsive">
      <table class="table table-sm table-bordered mb-0">
        <tbody>
          ${rows
            .filter(([, val]) => (typeof val === "string" || typeof val === "number") && val !== "")
            .map(
              ([label, val]) => `
              <tr>
                <th class="w-40 bg-light text-secondary small">${escapeHtml(label)}</th>
                <td class="small">${escapeHtml(val)}</td>
              </tr>`
            )
            .join("")}
        </tbody>
      </table>
    </div>
  `;
}

// ---------------------------------------------------------------------------
// Opciones del menú
// ---------------------------------------------------------------------------

document.querySelectorAll("[data-tool]").forEach((button) => {
  button.addEventListener("click", () => openTool(button.dataset.tool));
});

function openTool(tool) {
  const title = document.querySelector("#toolModalTitle");
  const body = document.querySelector("#toolModalBody");

  if (tool === "alias") {
    title.textContent = "Consulta de alias";
    body.innerHTML = `
      <form id="aliasForm" class="row g-2 align-items-end mb-3">
        <div class="col-12 col-sm-3">
          <label class="form-label small" for="aliasTipo">Tipo</label>
          <select id="aliasTipo" class="form-select">
            <option>CI</option><option>RUC</option><option>EMAIL</option>
            <option value="MOBILE">Celular</option><option>CRC</option><option>CRP</option>
          </select>
        </div>
        <div class="col-12 col-sm-5">
          <label class="form-label small" for="aliasValor">Alias</label>
          <input id="aliasValor" class="form-control" placeholder="Ej. 5100159" required />
        </div>
        <div class="col-12 col-sm-2">
          <label class="form-label small" for="aliasSwift">Entidad (opcional)</label>
          <input id="aliasSwift" class="form-control" placeholder="Opcional" />
        </div>
        <div class="col-12 col-sm-2 d-grid">
          <button class="btn btn-primary" type="submit">Buscar</button>
        </div>
      </form>
      <div id="toolResult"></div>
    `;
    document.querySelector("#aliasForm").addEventListener("submit", async (event) => {
      event.preventDefault();
      const params = new URLSearchParams({
        tipo: document.querySelector("#aliasTipo").value,
        alias: document.querySelector("#aliasValor").value.trim(),
      });
      const swift = document.querySelector("#aliasSwift").value.trim();
      if (swift) params.set("codSwift", swift);

      await runTool(`/api/alias?${params.toString()}`, renderAliasResult);
    });
  } else if (tool === "catalogos") {
    title.textContent = "Catálogos SIPAP";
    body.innerHTML = `
      <p class="text-muted small">
        Entidades, documentos y motivos disponibles para consulta.
      </p>
      <div class="d-flex flex-wrap gap-2 mb-3">
        <button class="btn btn-outline-primary btn-sm" data-cat="entidades-participantes">Entidades participantes</button>
        <button class="btn btn-outline-primary btn-sm" data-cat="tipos-documentos">Tipos de documento</button>
        <button class="btn btn-outline-primary btn-sm" data-cat="motivos">Motivos</button>
      </div>
      <div id="toolResult"></div>
    `;
    body.querySelectorAll("[data-cat]").forEach((catButton) => {
      catButton.addEventListener("click", () =>
        runTool(`/api/transferencias/${catButton.dataset.cat}`, (data) =>
          renderCatalog(data, catButton.textContent))
      );
    });
  } else if (tool === "sipap") {
    title.textContent = "Estado de operación SIPAP";
    body.innerHTML = `
      <form id="sipapForm" class="row g-2 align-items-end mb-3">
        <div class="col-12 col-sm-5">
          <label class="form-label small" for="sipapRef">Nro. de referencia</label>
          <input id="sipapRef" class="form-control" inputmode="numeric" placeholder="Ej. 221207432511" />
        </div>
        <div class="col-12 col-sm-5">
          <label class="form-label small" for="sipapRefInterna">Nro. referencia interna</label>
          <input id="sipapRefInterna" class="form-control" inputmode="numeric" placeholder="Ej. 5763476" />
        </div>
        <div class="col-12 col-sm-2 d-grid">
          <button class="btn btn-primary" type="submit">Consultar</button>
        </div>
      </form>
      <div id="toolResult"></div>
    `;
    document.querySelector("#sipapForm").addEventListener("submit", async (event) => {
      event.preventDefault();
      const params = new URLSearchParams();
      const ref = document.querySelector("#sipapRef").value.trim();
      const refInterna = document.querySelector("#sipapRefInterna").value.trim();
      if (ref) params.set("nroReferencia", ref);
      if (refInterna) params.set("nroRefInterna", refInterna);

      if (!ref && !refInterna) {
        showToast("Indique al menos un número de referencia.", "warning");
        return;
      }

      await runTool(
        `/api/transferencias/sipap/consultar-operacion?${params.toString()}`,
        renderSipapResult
      );
    });
  }

  if (toolModal) toolModal.show();
}

function renderAliasResult(data) {
  return renderRowsTable([
    ["Número de cuenta", data.nroCuenta],
    ["Denominación", data.denominacion],
    ["Entidad", data.entidad?.descripcion || data.entidad?.descripcionCorta || "No informada"],
    ["Tipo de documento", data.tipoDocumento?.descripcion || data.tipoDocumento?.descripcionCorta],
    ["Documento", data.nroDocumento],
    ["Moneda", data.moneda?.nombre || data.moneda?.iso || "No informada"],
  ]);
}

function renderCatalog(data, label) {
  if (!Array.isArray(data.listaDatos)) throw makeUiError(502, "INVALID_RESPONSE");
  const rows = data.listaDatos.map((item) => {
    const descriptions = [item.descripcion, item.descripcionCorta]
      .filter((value) => typeof value === "string")
      .map((value) => displayText(value).trim())
      .filter(Boolean);
    return [label, [...new Set(descriptions)].join(" · ") || "Descripción no informada"];
  });
  return rows.length ? renderRowsTable(rows) : '<p class="text-muted mb-0">Sin datos.</p>';
}

function renderSipapResult(data) {
  return renderClasificacion(data) + renderRowsTable([
    ["Referencia de la operación", data.nroReferencia],
    ["Referencia de seguimiento", data.nroRefInterna],
    ["Referencia externa", data.nroRefExterna],
    ["Número de operación", data.nroOperacion],
    ["Fecha de la operación", data.fechaOperacion ? formatDate(data.fechaOperacion) : null],
    ["Concepto", data.concepto],
    ["Motivo", data.motivo],
    ["Detalle del rechazo", data.tipRechazo],
    ["Monto", data.monto !== undefined && data.monto !== null ? formatOperationMoney(data.monto, data.moneda) : null],
    ["Moneda", typeof data.moneda === "string" ? data.moneda : data.moneda?.nombre || data.moneda?.iso],
    ["Solicitante", data.nomSolicitante],
    ["Documento del solicitante", data.nroDocSolicitante],
    ["Cuenta del solicitante", data.nroCtaSolicitante],
    ["Beneficiario", data.nomBeneficiario],
    ["Documento del beneficiario", data.nroDocBeneficiario],
    ["Cuenta del beneficiario", data.nroCtaBeneficiario],
  ]);
}

async function runTool(url, render) {
  const host = document.querySelector("#toolResult");
  host.innerHTML = '<p class="text-muted mb-0">Consultando…</p>';
  try {
    const data = await fetchJson(url);
    host.innerHTML = render(data);
  } catch (error) {
    host.innerHTML = `<div class="alert alert-danger mb-0">${escapeHtml(friendlyErrorMessage(error))}</div>`;
  }
}

/** Traduce la clasificación situación/estado del manual v1.4 a una acción. */
function renderClasificacion(data) {
  const map = {
    OK: ["success", "Aprobada", "La operación se completó correctamente."],
    ERROR: ["danger", "Rechazada", "La operación fue rechazada."],
    INTERMEDIO: ["warning", "Pendiente", "La operación sigue en proceso. No reverse la operación. Espere al menos 60 segundos antes de volver a consultar."],
    INDETERMINADO: ["warning", "Por confirmar", "El banco todavía no confirmó el resultado. No reverse la operación. Espere al menos 60 segundos antes de volver a consultar."],
  };
  const [tone, label, text] = map[data.clasificacion] || ["warning", "Resultado no confirmado", "No reverse la operación. Espere al menos 60 segundos antes de volver a consultar."];
  return `<div class="alert alert-${tone}"><strong>${escapeHtml(label)}</strong> — ${escapeHtml(text)}</div>`;
}

// ---------------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------------

function movementTypeInfo(value) {
  const normalized = typeof value === "string" ? value.trim().toUpperCase() : "";
  if (["D", "DEBITO", "DÉBITO"].includes(normalized)) return { label: "Débito", className: "text-danger" };
  if (["C", "CREDITO", "CRÉDITO"].includes(normalized)) return { label: "Crédito", className: "text-success" };
  return null;
}

function isMoneyNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

const currencyCodes = typeof Intl.supportedValuesOf === "function"
  ? new Set(Intl.supportedValuesOf("currency")) : null;

function isCurrencyCode(currency) {
  return typeof currency === "string" && /^[A-Z]{3}$/.test(currency) &&
    (!currencyCodes || currencyCodes.has(currency));
}

function formatMoney(value, currency) {
  if (value === null || value === undefined || value === "") return "--";
  if (!isMoneyNumber(value) || !isCurrencyCode(currency)) return "Dato inválido";

  return new Intl.NumberFormat("es-PY", {
    style: "currency",
    currency,
    maximumFractionDigits: currency === "PYG" ? 0 : 2,
  }).format(value);
}

function formatOperationMoney(value, currency) {
  if (value === null || value === undefined) return "--";
  if (!isMoneyNumber(value)) return "Dato inválido";
  if (typeof currency === "string") return formatMoney(value, currency);
  if (!currency || typeof currency !== "object" ||
      typeof currency.nombre !== "string" || !displayText(currency.nombre).trim() ||
      typeof currency.abreviatura !== "string" || !displayText(currency.abreviatura).trim() ||
      !Number.isInteger(currency.codigo)) return "Dato inválido";
  // Listado de Monedas de Transferencias v1.4: ISO es opcional. Sólo se infiere
  // para las parejas código/abreviatura documentadas por el banco.
  const abbreviation = currency.abreviatura.trim().toUpperCase();
  const documented = currency.codigo === 6900 ? { abbreviation: "GS", iso: "PYG" }
    : currency.codigo === 1 ? { abbreviation: "USD", iso: "USD" } : null;
  if (documented && abbreviation !== documented.abbreviation) return "Dato inválido";
  if (currency.iso !== undefined && currency.iso !== null) {
    if (documented && currency.iso !== documented.iso) return "Dato inválido";
    return formatMoney(value, currency.iso);
  }
  if (documented) return formatMoney(value, documented.iso);

  // Para otra moneda bien formada se conserva el importe y el nombre recibido;
  // no se inventa una moneda ni una cantidad de decimales que no fue informada.
  const amount = new Intl.NumberFormat("es-PY", { maximumSignificantDigits: 21 }).format(value);
  return `${amount} ${displayText(currency.nombre).trim()}`;
}

function parseDisplayDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))?$/.test(value)) return null;
  const calendarDate = new Date(`${value.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(calendarDate.getTime()) || calendarDate.toISOString().slice(0, 10) !== value.slice(0, 10)) return null;
  // Una fecha sin hora se interpreta como día local, sin desplazarla a ayer.
  const date = new Date(value.length === 10 ? `${value}T00:00:00` : value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatDate(value) {
  if (value === null || value === undefined || value === "") return "";
  const date = parseDisplayDate(value);
  if (!date) return "Dato inválido";
  return new Intl.DateTimeFormat("es-PY", { dateStyle: "short", timeStyle: "short" }).format(date);
}

function setStatus(tone, text) {
  statusBadge.className = `badge text-bg-${tone}`;
  statusBadge.textContent = text;
}

function setLoading(isLoading) {
  submitButton.disabled = isLoading;
  refreshNowButton.disabled = isLoading;
  refreshNowButton.textContent = isLoading ? "Actualizando…" : "Actualizar";
}

function showToast(message, type) {
  const host = document.querySelector("#alertHost");
  const wrapper = document.createElement("div");
  wrapper.className = `alert alert-${type} shadow-sm`;
  wrapper.setAttribute("role", "alert");
  wrapper.textContent = displayText(message);
  host.appendChild(wrapper);
  window.setTimeout(() => wrapper.remove(), 5500);
}

// MEDIO-05: formato local seguro para no desplazar el día cerca de medianoche.
function toDateInput(value) {
  const y = value.getFullYear();
  const m = String(value.getMonth() + 1).padStart(2, "0");
  const d = String(value.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function displayText(value) {
  if (value === null || value === undefined) return "";
  if (typeof value !== "string" && typeof value !== "number") return "No informado";
  // Limpieza exclusiva de presentación. No decodifica ni reescribe el payload.
  return String(value)
    .replace(/[\t\n\r\u2028\u2029]/g, " ")
    .replace(/[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g, "");
}

function escapeHtml(value) {
  return displayText(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
