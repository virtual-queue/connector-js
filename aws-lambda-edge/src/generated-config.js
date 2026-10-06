// Config del conector. Versionada con PLACEHOLDERS a propósito.
//
// `npm run build` NO escribe este archivo: inyecta la config real en memoria al
// bundlear, así la private_key del cliente nunca toca el árbol fuente ni puede
// filtrarse en un commit.
//
// Con estos placeholders, validateConfig falla y el conector arranca en
// fail-open: deja pasar todo y lo informa en los logs, en vez de encolar con
// datos inventados.

export const CONFIG = {
    client: "__VQ_CLIENT__",
    privateKey: "__VQ_PRIVATE_KEY__",
    adminHost: "clients.virtual-queue.com",
    settingsTtlMs: 30000,
    settingsTimeoutMs: 1500,
    verifyTimeoutMs: 2000,
    // Presupuesto total del viewer-request antes de soltar al visitante (el timeout
    // de la función es 5 s).
    deadlineMs: 4000,
    debug: false,
};
