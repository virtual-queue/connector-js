// Superficie pública del core.
//
// Nada de acá sabe de Cloudflare, AWS ni de ningún framework: recibe un request
// normalizado y devuelve una decisión. Los adaptadores (Lambda@Edge, middleware
// de Node) solo traducen formatos de entrada y salida.
//
// Esa separación es lo que permite que una corrección en el matcheo de ACLs o en
// la verificación del pase llegue a todas las integraciones a la vez, en vez de
// arreglarse en una y quedar pendiente en las otras.

export { ASSET_REGEX, globToRegex, matchRule, sortRules, findMatch } from "./acl.js";
export { verifyPass, hasValidPassFor, passCookieName, PASS_COOKIE_PREFIX } from "./pass.js";
export {
    getSettings,
    settingsUrl,
    resolveCookieLifetime,
    DEFAULT_COOKIE_LIFETIME,
    MAX_COOKIE_LIFETIME,
    _resetSettingsCache,
} from "./settings.js";
export {
    decide,
    exchangeToken,
    isBypassPath,
    matchPath,
    _resetKeyMismatch,
    queueToken,
    safeTarget,
    targetCookieName,
    TARGET_COOKIE_PREFIX,
} from "./decide.js";
export { validateConfig, buildLogger } from "./config.js";
