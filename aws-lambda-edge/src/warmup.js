// Lectura de la config y de las reglas durante el Init del contenedor.
//
// En el Init la función tiene la CPU entera; en el handler, ~7% de una vCPU
// (128 MB). El primer pedido por internet de cada contenedor carga y compila
// código y abre la primera conexión segura: ~50-110 ms de CPU que en el handler
// se estiraban a 0,9-2 s. El módulo hace esa lectura con un await de nivel
// superior, y Lambda no da por terminado el Init hasta que se resuelve.
//
// Medido en un sitio real (2026-11-17, Madrid -> eu-west-2, 10 contenedores
// fríos por versión, medianas, Init + primer request): 2.652 ms leyendo todo en
// el handler, 832 ms leyendo el secreto y las reglas en el Init, 564 ms con la
// config horneada y las reglas en el Init.
//
// La espera tiene tope (`initBudgetMs`): si Secrets Manager o el admin tardan,
// el Init sigue sin ellos y lo que quedó en vuelo lo retoma el primer request,
// como antes. Nunca rechaza: un Init que falla deja la función rota, y el
// conector tiene que dejar pasar al visitante, no devolverle un error.

/**
 * Corre `work` con un tope de tiempo. Devuelve lo que devuelva `work`,
 * "budget" si se pasó del tope, o "error" si falló.
 */
export async function warmUp(work, { budgetMs = 1_000, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
    let timer;
    const budget = new Promise((resolve) => {
        timer = setTimer(() => resolve("budget"), budgetMs);
    });
    try {
        return await Promise.race([Promise.resolve().then(work), budget]);
    } catch {
        return "error";
    } finally {
        clearTimer(timer);
    }
}
