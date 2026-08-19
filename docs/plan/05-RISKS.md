# 05 — Riesgos

Ordenados por gravedad. "Gravedad" pondera daño a personas > daño al proyecto
> coste.

## Críticos

### R1 — Suplantación de investigador (F6)

El fallo posible más dañino del plan: vincular un `uid` a una persona real
equivocada. Mitigado por diseño (`02-SECURITY.md` §5): única vía automática
ORCID OAuth, páginas indexadas por iD y no por nombre, prohibida la
vinculación por coincidencia de nombre, disputa y reversión definidas, y la
insignia afirma solo lo comprobado ("ORCID verificado"). **Riesgo residual**:
cuenta ORCID comprometida, o un usuario que reclama su propio iD y luego
publica barbaridades bajo su nombre real — eso ya no es suplantación sino
reputación, y lo cubre la moderación. Además queda una suplantación *blanda*
que ORCID no impide: `displayName` y `handle` imitando a un investigador
famoso sin verificar. Mitigación: la insignia es la señal (su ausencia en un
perfil "Yann LeCun" es elocuente), y el admin puede renombrar/ocultar
perfiles; no se prometen handles reservados.

### R2 — Escritura pública + free tier = DoS barato

Con rules-only, un atacante con N cuentas Google puede: llenar de spam (lo
frena el throttle por cuenta, no entre cuentas), o **agotar la cuota diaria
del proyecto** (lecturas con scripts sobre colecciones públicas, escrituras
masivas), tirando la app entera para todos — y en el plan Spark el modo de
fallo es apagón, no factura. Sin solución completa gratis. Capas: throttle
declarativo, killswitch por colección sin deploy, bloqueo de UIDs en rules, y
la pregunta abierta de App Check. Se acepta explícitamente en pre-producción;
lo que lo haría inaceptable (usuarios reales dependiendo de la app a diario)
es también lo que justificaría pagar Blaze con alertas de presupuesto.

## Altos

### R3 — Anclaje de anotaciones (F4): por qué NO a posiciones

Obligatorio de explicar: aquí no existe "el documento". Un paper es (a) un
objeto normalizado fusionado de hasta 8 proveedores cuyo abstract difiere
entre fuentes, (b) un PDF externo que la app no aloja, con versiones (v1…vN
de arXiv, preprint vs published) que **repaginan y reescriben el texto**, y
(c) a veces un HTML de arXiv. Un ancla posicional (página+offset, XPath,
rangos de texto) se rompe con la primera versión nueva, no es computable
sin descargar y procesar el PDF (que a veces ni es accesible), y no hay
almacén propio contra el que estabilizarla. Los sistemas que lo hacen bien
(Hypothesis) anclan con fuzzy matching sobre texto extraído y aun así fallan;
construir eso aquí es un proyecto entero.

**Alcances realistas, en orden de coste** (el plan implementa los dos
primeros):
1. **Nivel paper** — cero anclaje. Cubre el 90% del valor ("explicación de
   este paper").
2. **Cita textual** — el ancla ES la cita copiada (≤500 chars) guardada en el
   doc. Inmune a versiones: la cita se muestra como bloque citado; si el
   texto cambió, la cita sigue siendo legible por sí misma. Sin resaltado
   dentro del PDF.
3. **Etiqueta de sección** — texto libre "§3 Methods". Barato pero
   inconsistente entre versiones; se admite como campo, sin semántica.
4. *(Futuro, solo arXiv)* anclar a secciones del HTML de arXiv — el spike de
   figuras ya validó que ese HTML es utilizable; sería solo para el subconjunto
   arXiv-con-HTML y sigue sin cubrir PDFs. No entra en F4.

### R4 — Moderación unipersonal: qué carga genera cada feature

| Feature | Carga esperada | ¿Sostenible por una persona? |
| --- | --- | --- |
| Comentarios (F3) | La mayor. Crece con usuarios, no con papers | Sí con throttle+reportes+killswitch mientras los usuarios sean decenas. Umbral de migración a Worker en `00-ARCHITECTURE.md`. |
| Anotaciones (F4) | Como comentarios pero menos volumen y más largas de revisar | Sí, mismo aparato |
| Perfiles (bio, foto, handle) | Baja pero delicada (suplantación blanda, fotos) | Sí; reportable como todo lo demás |
| Relay (F7) | Baja: opt-in + 5/día/emisor. Pero cada abuso es un email en la bandeja de alguien | Sí; el opt-out de un clic descarga presión |
| Disputas ORCID (F6) | Rarísimas y caras cada una (horas, criterio) | Solo porque serán ≈0. Si hubiera una al mes, repensar |
| Aprobación de dominios edu (F6) | Un goteo: primer usuario de cada dominio nuevo | Sí, es un clic desde el digest |
| Fusión de stubs duplicados | Rara, semiautomatizable con el reporte `dup-stub` | Sí |

Lo que NO debe construirse porque su moderación no la sostiene una persona:
mensajería privada en-app (F7 es relay de email precisamente por esto),
subida de imágenes en comentarios, y hilos profundos (el diseño los limita a
un nivel).

### R5 — Split-brain de stubs

Dos claves para el mismo paper (una ruta con DOI, otra sin él) parten los
comentarios. Análisis y mitigaciones en `00-ARCHITECTURE.md` (clave sobre el
objeto ya enriquecido, consulta dual, fusión manual). Residual: papers
recién publicados sin DOI en ningún proveedor. Se acepta; la fusión repara.

## Medios

### R6 — Features sustancialmente más caras de lo que parecen

- **"Feed de actividad de seguidos" (extensión natural de F2)**: parece un
  `where in` y es un fan-out (leer actividad de M seguidos × N items, o
  mantener timelines materializados por usuario). Excluido de F2 a propósito;
  si se pide, diseñarlo como feature propia con presupuesto de lecturas.
- **Contadores en tiempo real / listeners**: `onSnapshot` sobre comentarios
  factura una lectura por doc cambiado por oyente y mantiene conexiones; el
  plan usa lecturas puntuales + refresco manual. Ponerle "en vivo" a la hoja
  de comentarios multiplica el coste sin necesidad.
- **Login ORCID completo (Vía A)**: arrastra el upgrade a Identity Platform y
  su modelo de facturación por toda la eternidad del proyecto, para
  exactamente el mismo valor que la Vía B da gratis (`03-AUTH.md`).
- **Insignias denormalizadas** (`authorVerified` en cada comentario): baratas
  de escribir, carísimas de invalidar (revocación = reescribir N docs). El
  plan resuelve la insignia en lectura.
- **Cambio de handle**: los `authorHandle` denormalizados en comentarios
  viejos quedan obsoletos. Se acepta (snapshot histórico, como cualquier
  foro); "reescribir todos mis comentarios" sería otra migración fan-out.
- **Borrado de cuenta (GDPR-ish)**: hoy borrar el árbol `users/{uid}` es
  privado y simple; con contenido público quedan comentarios huérfanos con
  handle snapshot. Hace falta (fase futura, no en F1–F7) un camino de
  borrado que anonimice (`authorUid: 'deleted'`, handle → "[eliminado]") —
  manual de admin al principio, pero debe estar escrito en la política de la
  app desde F3.

### R7 — El Worker gana llaves del reino

La service account (P10) convierte un XSS o un secreto filtrado del Worker en
acceso de escritura a Firestore saltándose las rules. Mitigación: rol mínimo,
secreto solo en `wrangler secret`, colecciones de servicio reconstruibles
(re-verificar ORCID/edu es barato), y el Worker no expone ninguna ruta que
escriba Firestore con parámetros arbitrarios del cliente (solo las tres
operaciones tipadas: verificación ORCID, verificación edu, flags de relay).

## Bajos / deuda registrada

- **R8 — Identidad de `paper.id` en colecciones privadas** (hallazgo del
  reconocimiento): `interactions` usa `paper.id` crudo como ID de doc; los
  DOIs con `/` anidan rutas, y arXiv/OpenAlex entran con y sin prefijo según
  la ruta de código. Es deuda *previa* a este plan; los stubs no la heredan
  (clave propia) ni la arreglan. Merece ficha aparte fuera del plan social.
- **R9 — Drift documental**: `docs/PUBLIC_DISCOVERY.md` dice "20 papers" por
  lista pública; las rules imponen 12. Corregir el doc cuando se toque.
- **R10 — Verificación duplicada en el Worker**: dos implementaciones
  divergentes de auth (`firebase-auth.js` vs `email-notifications.js:688`).
  Unificar en P10, que ya toca esa zona.
- **R11 — Cache de token de 60 s**: aceptable para proxies de lectura; las
  rutas nuevas de F6/F7 no lo usan (decidido en `02-SECURITY.md` §6).
