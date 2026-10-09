// Matcheo de ACLs. Misma semántica que los Workers de VQueue y que
// el JS adapter: reglas ordenadas por prioridad, gana el primer match.
//
// La forma de cada regla la fija el admin (EdgeAcls.@public_fields):
//   { action, pattern, pattern_type, event_id, priority, enabled }
// Nunca trae claves ni umbrales: el endpoint es público.

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
