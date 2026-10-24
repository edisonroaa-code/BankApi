const http = require("node:http"),
  fs = require("node:fs"),
  path = require("node:path"),
  { execFileSync } = require("node:child_process");
const output = path.resolve(__dirname, "../.runtime/formularios-browser");
fs.mkdirSync(output, { recursive: true });
const root = path.resolve(__dirname, "../..");
const { Server } = require(path.join(root, "backend/node_modules/socket.io"));
const user = {
  id: "fixture-a",
  username: "prueba-a",
  name: "Usuario de prueba A",
  role: "COBRADOR",
};
const now = () => new Date().toISOString();
const payment = {
  id: "fixture-payment",
  amount: 150000,
  currency: "PYG",
  clientCode: "ENVIADA-1",
  clientName: "Cliente sintético",
  paymentRef: "REF-ENVIADA",
  sourceBank: "BANCO PRUEBA",
  isAtlasAccount: true,
  status: "PENDIENTE_VERIFICACION",
  createdAt: now(),
  createdById: user.id,
  createdBy: user,
};
const transfer = {
  id: "fixture-transfer",
  source: "MOCK",
  amount: 150000,
  currency: "PYG",
  allocatedAmount: 0,
  availableAmount: 150000,
  status: "DISPONIBLE",
  movementAt: now(),
  bankDocNumber: "SIMULADO-1",
  senderName: "Remitente sintético",
  senderAccount: "***",
  senderDoc: "***",
  senderBankName: "Banco simulado",
  claims: [],
};
const state = {
  drop: false,
  failSend: false,
  health: true,
  change: 0,
  postCount: 0,
  bankReads: 0,
  paymentReads: 0,
  paymentDetailReads: 0,
  ticks: 0,
};
const status = () => ({
  mode: "mock",
  state: "EN_VIVO",
  lastSuccessAt: now(),
  lastPollAt: now(),
  serverTime: now(),
  intervalSeconds: 5,
  refreshCooldownSeconds: 5,
  changeCount: state.change,
  verified: false,
  hours: "00:00-23:59",
});
let realtime;
const api = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost"),
    p = url.pathname;
  const send = (data, code = 200) => {
    res.writeHead(code, { "Content-Type": "application/json" });
    res.end(JSON.stringify(data));
  };
  if (p === "/__control") {
    if (req.method === "POST") {
      let b = "";
      for await (const c of req) b += c;
      const c = JSON.parse(b || "{}");
      Object.assign(state, c);
      if (c.transferPatch) Object.assign(transfer, c.transferPatch);
      if (c.approval) {
        payment.status = "CONFIRMADO_MANUAL";
        realtime.emit("payments:changed", {
          type: "PAYMENT_CONFIRMED_MANUAL",
          paymentId: payment.id,
          targetUserId: user.id,
          ts: now(),
        });
      }
      if (c.drop !== undefined) {
        state.change++;
        realtime.emit("bank-feed:status", status());
      }
      if (c.taken) {
        Object.assign(transfer, {
          status: "TOMADA",
          availableAmount: 0,
          allocatedAmount: 150000,
        });
        realtime.emit("bank-transfers:updated", transfer);
      }
      if (c.reconnect) {
        for (const s of realtime.sockets.values()) s.conn.close();
      }
    }
    return send(state);
  }
  if (p === "/health")
    return send(
      { status: state.health ? "ok" : "error" },
      state.health ? 200 : 503,
    );
  if (p === "/payments/paged") {
    state.paymentReads++;
    return send({
      items: [payment],
      total: 1,
      page: 1,
      pageSize: 50,
      totalPages: 1,
    });
  }
  if (p === "/payments/kpis")
    return send({
      monthIncomingAmount: 0,
      monthRejectedAmount: 0,
      monthTotalAmount: 0,
      collectors: [],
      managers: [],
      counts: {},
    });
  if (p === "/bank-feed/status") return send(status());
  if (p === "/bank-feed/refresh")
    return send({ accepted: true, status: status() });
  if (p === "/bank-transfers/page") {
    state.bankReads++;
    const rows = state.drop ? [] : [transfer];
    return send({
      items: rows,
      total: rows.length,
      page: 1,
      pageSize: 25,
      totalPages: 1,
      counts: {
        DISPONIBLES: rows.length,
        TOMADAS: 0,
        REVISAR: 0,
        TODAS: rows.length,
      },
      pendingOtherMonths: [],
    });
  }
  if (
    p === "/bank-transfers/claims/mine" ||
    p === "/bank-transfers/claims/review"
  )
    return send([]);
  if (p === "/bank-transfers/matches")
    return send([
      {
        ...transfer,
        match: { strength: "FUERTE", evidence: ["MONTO"], score: 100 },
      },
    ]);
  if (p === "/bank-transfers/fixture-transfer/candidate-payments")
    return send([
      {
        ...payment,
        match: { strength: "FUERTE", evidence: ["MONTO"], score: 100 },
      },
    ]);
  if (p === "/bank-transfers/fixture-transfer") return send(transfer);
  if (p === "/payments" && req.method === "POST") {
    for await (const c of req) {
    }
    state.postCount++;
    await new Promise((r) => setTimeout(r, state.postDelayMs || 0));
    return send(
      state.failSend
        ? { message: "Fallo sintético de red" }
        : { ...payment, id: "fixture-sent-" + state.postCount },
      state.failSend ? 503 : 201,
    );
  }
  if (p === "/payments/fixture-payment" && req.method === "GET") {
    state.paymentDetailReads++;
    return send(payment);
  }
  if (p.startsWith("/payments/") && req.method === "GET") return send([]);
  if (p === "/auth/login") return send({ access_token: "fixture-only", user });
  if (req.method !== "GET")
    return send({ message: "Operación no habilitada en la prueba" }, 409);
  return send([]);
});
(async () => {
  await new Promise((r) => api.listen(0, "127.0.0.1", r));
  const apiOrigin = "http://127.0.0.1:" + api.address().port;
  const io = new Server(api, { cors: { origin: true } });
  realtime = io.of("/realtime");
  realtime.on("connection", (s) => s.emit("bank-feed:status", status()));
  const timer = setInterval(() => {
    state.ticks++;
    realtime.emit("bank-feed:status", status());
    realtime.emit("payments:changed", {
      type: "PAYMENT_UPDATED",
      paymentId: payment.id,
      targetUserId: user.id,
      ts: now(),
    });
  }, 5000);
  const { createServer } = await import("vite");
  const servers = [];
  const compareBaseline = process.env.FORMS_COMPARE_BASELINE === "1";
  for (const baseline of compareBaseline ? [true, false] : [false]) {
    const fixtures = {
      name: "synthetic-fixture",
      enforce: "pre",
      transformIndexHtml(html) {
        const session = { access_token: "fixture-only", user };
        return html
          .replace(
            "<head>",
            `<head><script>if(!localStorage.getItem('bankapi_session_v1'))localStorage.setItem('bankapi_session_v1',${JSON.stringify(JSON.stringify(session))});</script>`,
          )
          .replace(
            /<body\b[^>]*>/,
            (body) =>
              body +
              '<div style="background:#fef3c7;padding:4px;text-align:center">PRUEBA AISLADA — DATOS SINTÉTICOS</div>',
          );
      },
    };
    const vite = await createServer({
      root,
      plugins: [fixtures],
      define: { "import.meta.env.VITE_API_URL": JSON.stringify("/api") },
      server: {
        // Un archivo editado durante la prueba no debe provocar una recarga de desarrollo.
        watch: null,
        port: 0,
        host: "127.0.0.1",
        strictPort: false,
        proxy: {
          "/api": {
            target: apiOrigin,
            changeOrigin: true,
            rewrite: (p) => p.replace(/^\/api/, ""),
          },
          "/socket.io": { target: apiOrigin, ws: true },
        },
      },
    });
    // El merge de la configuración local puede conservar opciones watch del proyecto.
    // Cerrar el watcher explícitamente también evita recargas por editar este informe.
    await vite.watcher.close();
    await vite.listen();
    servers.push(vite);
  }
  const report = {
    api: apiOrigin,
    baseline: compareBaseline
      ? "http://127.0.0.1:" + servers[0].httpServer.address().port
      : undefined,
    candidate: "http://127.0.0.1:" + servers.at(-1).httpServer.address().port,
    pid: process.pid,
  };
  fs.writeFileSync(path.join(output, "runtime.json"), JSON.stringify(report));
  console.log(JSON.stringify(report));
  if (process.send) process.send(report);
  const stop = async () => {
    clearInterval(timer);
    for (const s of servers) await s.close();
    await io.close();
    api.close();
    process.exit();
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
