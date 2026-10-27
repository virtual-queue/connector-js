// Matcheo de ACLs. Misma semántica que los Workers de VQueue y que
// el JS adapter: reglas ordenadas por prioridad, gana el primer match.
//
// La forma de cada regla la fija el admin (EdgeAcls.@public_fields):
//   { action, pattern, pattern_type, event_id, priority, enabled,
//     threshold, max_load, tolerance, buy_time }
// Nunca trae claves: el endpoint es público. Los cuatro últimos son los
// parámetros del lazo de activación automática (ver tc.js); una regla sin
// umbrales (o de un admin viejo que no los manda) es manual y encola siempre.

const globRegexCache = new Map();
const MAX_GLOB_CACHE = 1000;

// `.json` queda FUERA a propósito: lo usan endpoints dinámicos (/products.json,
// /cart.json) que son justamente los que hay que proteger. Debe mantenerse en
// sintonía con el ASSET_REGEX de los Workers.
export const ASSET_REGEX = /\.(css|js|mjs|png|jpe?g|gif|svg|ico|webp|avif|woff2?|ttf|eot|map)$/i;

export function globToRegex(pattern) {
    let regex = globRegexCache.get(pattern);
    if (regex) return regex;

    const escaped = pattern.replace(/[-/\\^$+?.()|[\]{}]/g, "\\$&");
    regex = new RegExp(`^${escaped.replace(/\*/g, ".*")}$`);

    if (globRegexCache.size >= MAX_GLOB_CACHE) globRegexCache.clear();
    globRegexCache.set(pattern, regex);
    return regex;
}

// Un pattern vacío no matchea nada. `startsWith("")` e `includes("")` son
// true para cualquier path, y una regla mal cargada no puede encolar el sitio
// entero por accidente: misma política que PHP y .NET.
export function matchRule(rule, path) {
    if (!rule || typeof rule.pattern !== "string" || rule.pattern === "") return false;

    switch (rule.pattern_type) {
        case "prefix":
            return path.startsWith(rule.pattern);
        case "exact":
            return rule.pattern === path;
        case "contains":
            return path.includes(rule.pattern);
        case "glob":
            return globToRegex(rule.pattern).test(path);
        default:
            return false;
    }
}

// Una regla sin `priority` numérica haría que el comparador devuelva NaN y el
// orden quede indefinido (y con él, cuál regla "gana"). Van al final con un peso
// finito en vez de romper el orden.
function priorityOf(rule) {
    return Number.isFinite(rule?.priority) ? rule.priority : Number.MAX_SAFE_INTEGER;
}

// Normaliza una vez por refresco de settings, no por request.
export function sortRules(acls) {
    if (!Array.isArray(acls)) return [];
    return acls.filter((r) => r && r.enabled).sort((a, b) => priorityOf(a) - priorityOf(b));
}

export function findMatch(sortedRules, path) {
    return sortedRules.find((rule) => matchRule(rule, path)) || null;
}

function nonNegative(value) {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? n : 0;
}

// Una regla es automática si el operador le puso un umbral de pico (threshold,
// llegadas/s) o de concurrencia (max_load). Sin ninguno, la cola está siempre
// encendida para esa regla, que es el comportamiento histórico del conector.
export function isAutomatic(rule) {
    return nonNegative(rule?.threshold) > 0 || nonNegative(rule?.max_load) > 0;
}

// Los parámetros del lazo tal como viajan al TC. `tolerance` queda en null si el
// admin no lo manda, y el sensor aplica su default.
export function loopParams(rule) {
    const raw = rule?.tolerance;
    const tolerance = raw == null || raw === "" ? NaN : Number(raw);
    return {
        threshold: nonNegative(rule?.threshold),
        maxLoad: nonNegative(rule?.max_load),
        tolerance: Number.isFinite(tolerance) ? tolerance : null,
        buyTime: nonNegative(rule?.buy_time),
    };
}
