// Dedupe generacional: dos Sets que rotan cada windowMs.
//
// Copia de `edge_forwarder/src/dedupe.js` (el core no puede depender de un
// Worker). Cada consulta es O(1) y la memoria se libera de golpe al rotar.
//
// La ventana efectiva queda entre windowMs y 2·windowMs: alcanza porque el
// dedupe es best-effort por proceso, no una garantía de exactly-once.
export class Deduper {
    constructor(windowMs, maxKeys) {
        this.windowMs = windowMs;
        this.maxKeys = maxKeys;
        this.current = new Set();
        this.previous = new Set();
        this.rotatedAt = 0;
    }

    // true si `key` ya se vio dentro de la ventana; si no, la registra.
    seen(key, now) {
        if (!key) return false;
        // windowMs <= 0 desactiva el dedupe.
        if (this.windowMs <= 0) return false;

        if (now - this.rotatedAt >= this.windowMs) {
            // Tras más de dos ventanas sin consultas, la generación anterior ya
            // es toda vieja: se descarta en vez de seguir "viendo" claves rancias.
            // (Diferencia con el Worker: ahí el tráfico continuo rota seguido y
            // no se nota; en un contenedor Lambda que estuvo ocioso sí.)
            this.previous = now - this.rotatedAt >= 2 * this.windowMs ? new Set() : this.current;
            this.current = new Set();
            this.rotatedAt = now;
        }

        if (this.current.has(key) || this.previous.has(key)) return true;

        // Tope de memoria: pasado el límite dejamos de registrar (los excedentes
        // se cuentan como llegadas nuevas) en vez de crecer sin control.
        if (this.current.size < this.maxKeys) this.current.add(key);
        return false;
    }
}
