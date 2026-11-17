// Precarga del fetch de Node durante el Init del contenedor.
//
// Node carga su `fetch` (undici, un módulo grande) recién la primera vez que se
// usa. En un viewer-request de 128 MB eso pasaba adentro del primer request de
// cada contenedor, con ~7% de una vCPU: ~80 ms de CPU que se estiraban a ~1,4 s
// antes de que saliera un solo byte a la red. Durante el Init, Lambda le da a la
// función la CPU entera y el mismo trabajo tarda ~75 ms.
//
// Medido en un sitio real (2026-11-17, 10 contenedores fríos por versión,
// medianas): el Init pasó de 130 a 208 ms, la lectura del secreto de 2.0 a
// 0.86 s y el primer request de 2.48 a 1.34 s.
//
// Leer `globalThis.Headers` dispara la misma carga que el primer fetch(): Node
// expone Headers, Request y Response como getters perezosos sobre ese módulo.
// Si una versión de Node ya lo trae cargado, la lectura no cuesta nada.

/** Carga el fetch de Node. Devuelve si quedó disponible. */
export function preloadFetch() {
    return typeof globalThis.Headers === "function";
}
