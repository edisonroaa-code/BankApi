// Prueba aislada: levanta una API sintética y la aplicación real en puertos loopback.
// No arranca Nest/TypeORM, no lee credenciales Atlas y no escribe datos productivos.
const { fork, spawnSync } = require("node:child_process");
const path = require("node:path");

async function main() {
  const fixture = fork(path.join(__dirname, "server.cjs"), [], {
    stdio: ["ignore", "inherit", "inherit", "ipc"],
  });
  try {
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("No arrancó la API sintética")),
        30_000,
      );
      fixture.once("message", () => {
        clearTimeout(timeout);
        resolve();
      });
      fixture.once("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      fixture.once("exit", (code) => {
        clearTimeout(timeout);
        reject(new Error(`La API sintética terminó (${code})`));
      });
    });
    for (const args of [
      ["check.cjs"],
      ["modals.cjs"],
      ["api-responses.cjs", "pending"],
      ["api-responses.cjs"],
    ]) {
      const result = spawnSync(
        process.execPath,
        [path.join(__dirname, args[0]), ...args.slice(1)],
        {
          stdio: "inherit",
          timeout: 120_000,
        },
      );
      if (result.error) throw result.error;
      if (result.status !== 0)
        throw new Error(`${args.join(" ")} falló (${result.status})`);
    }
    console.log(
      "OK formularios: sondeo, respuestas, reconexión, borradores, envío y selección",
    );
  } finally {
    fixture.kill();
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
