// Config del conector.
//
// Lambda@Edge NO soporta variables de entorno, así que la config se hornea en el
// bundle al empaquetar (`npm run build`), o se lee de AWS Secrets Manager.
//
// `privateKey` es el `private_key` de la compañía: el mismo secreto con el que
// VQueue firma el pase. Vive en el AWS del cliente y nunca sale de ahí.

// Los valores concretos viven en src/generated-config.js, que escribe el build.

function unreplaced(value) {
    return typeof value === "string" && value.startsWith("__VQ_") && value.endsWith("__");
}

/**
 * Valida la config horneada. Devuelve {ok, errors}.
 * Un conector mal configurado NO debe bloquear tráfico: el handler lo trata como
 * fail-open y deja pasar todo, pero deja el error en los logs.
 */
export function validateConfig(config) {
    const errors = [];

    if (!config?.client || unreplaced(config.client)) {
        errors.push("`client` sin configurar (subdominio de la compañía en VQueue)");
    }
    if (!config?.privateKey || unreplaced(config.privateKey)) {
        errors.push("`privateKey` sin configurar (private_key de la compañía)");
    }
    if (!config?.adminHost) {
        errors.push("`adminHost` sin configurar");
    }

    return { ok: errors.length === 0, errors };
}

export function buildLogger(config) {
    if (config?.debug) return console;
    return {
        log: () => { },
        warn: (...args) => console.warn(...args),
        error: (...args) => console.error(...args),
    };
}
