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
//   [timing] request 1961ms cold
//   [timing] config 412ms secret
//   [timing] settings 1483ms ok
//   [timing] decide 1502ms redirect

export function logPhase(logger, name, ms, outcome) {
    logger?.log?.(`[timing] ${name} ${Math.round(ms)}ms${outcome ? ` ${outcome}` : ""}`);
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
    return (outcome, lateLogger) => logPhase(lateLogger ?? logger, name, now() - t0, outcome);
}
