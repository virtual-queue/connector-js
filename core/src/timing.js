// Medición por fase del camino caliente.
//
// Para qué: el conector hace como mucho tres llamadas de red por request
// (Secrets Manager en Lambda@Edge, settings, /queue/verify) y ninguna se ve
// desde afuera. Cuando una medición da 2 s y la siguiente 600 ms, sin esto no
// hay forma de saber si fue el contenedor frío, el fetch de settings o el
// canje del token.
//
// Todas las líneas salen por `logger.log`, que `buildLogger` deja en no-op
// cuando `debug` es false: en producción no se imprime nada. Los dos Date.now()
// se pagan igual y son ruido al lado de un round trip.
//
// Formato, pensado para grepear en CloudWatch / wrangler tail:
//
//   [timing] request 1961ms cpu=141ms cold
//   [timing] config 412ms cpu=30ms secret
//   [timing] settings 1483ms cpu=106ms ok
//   [timing] decide 1502ms cpu=108ms redirect
//
// `cpu=` sale solo si la plataforma registró un reloj de CPU (`setCpuClock`).
// Es el tiempo de CPU que gastó el proceso durante la fase, y separa dos causas
// que el tiempo de pared confunde: una fase que espera a la red gasta casi nada
// de CPU, y una que se queda sin CPU gasta, en proporción a su duración, lo que
// la plataforma le da. Lambda reparte la CPU según la memoria (una vCPU entera
// recién a 1.769 MB), así que a 128 MB una fase limitada por CPU marca
// cpu/pared ≈ 0,07 y una que espera a la red queda muy por debajo.

// Reloj de CPU del proceso, en ms acumulados. Lo registra la plataforma que lo
// tiene de verdad: el Worker no lo tiene, y en el SDK de Node el proceso es el
// servidor del cliente, cuya CPU no es nuestra.
let cpuClock = null;

/**
 * Registra el reloj de CPU que usan las fases (null lo apaga). Recibe una
 * función que devuelve los ms de CPU que el proceso lleva gastados.
 */
export function setCpuClock(clock) {
    cpuClock = typeof clock === "function" ? clock : null;
}

function readCpu() {
    if (!cpuClock) return null;
    try {
        const value = cpuClock();
        return Number.isFinite(value) ? value : null;
    } catch {
        return null;
    }
}

export function logPhase(logger, name, ms, outcome, cpuMs) {
    const cpu = Number.isFinite(cpuMs) ? ` cpu=${Math.round(cpuMs)}ms` : "";
    logger?.log?.(`[timing] ${name} ${Math.round(ms)}ms${cpu}${outcome ? ` ${outcome}` : ""}`);
}

/**
 * Arranca el reloj de una fase. Devuelve la función que la cierra:
 *
 *   const done = phase(logger, "settings");
 *   ...
 *   done("ok");
 *
 * El logger se resuelve al cerrar, no al arrancar: en Lambda@Edge el logger
 * definitivo recién se conoce cuando llegó la config (el secreto puede traer
 * `debug`), y para entonces la fase ya empezó.
 */
export function phase(logger, name, now = Date.now) {
    const t0 = now();
    const c0 = readCpu();
    return (outcome, lateLogger) => {
        const c1 = c0 === null ? null : readCpu();
        const cpu = c1 === null ? null : c1 - c0;
        logPhase(lateLogger ?? logger, name, now() - t0, outcome, cpu);
    };
}
