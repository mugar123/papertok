# 00 — Arquitectura para la red social del conocimiento

Sesión de diseño 2026-08-19. Sin código: este documento decide *dónde* vive
cada escritura nueva y diseña la pieza que falta para que exista contenido
compartido: los stubs de paper.

## Lo que ya hay, verificado en el repo

| Pieza | Estado hoy | Referencia |
| --- | --- | --- |
| Escrituras | El navegador escribe directo a Firestore; el Worker **nunca** escribe en Firestore (cero referencias a Admin SDK o REST de Firestore en `worker/`) | `worker/report-api.js` |
| Autorización | 100% declarativa en `firestore.rules`, con validación exhaustiva de forma y tamaño (ver `validPublicPaper`, agregado de interacciones) | `firestore.rules` |
| Dato público | `publicLists/{shareId}` + `publicListOwners/{shareId}`: doc público anónimo + doc de propiedad, creados en un `writeBatch` atómico, con `getAfter` cruzado en rules | `src/services/publicListService.js:206-226` |
| Auth en Worker | Extrae `Bearer` y delega en `identitytoolkit accounts:lookup` (no valida el JWT localmente); cachea 60 s por sha256 del token | `worker/firebase-auth.js:15-43` |
| Rate limiting | Durable Object `RequestQuotaLedger`: cuota atómica por sujeto y global, ya en uso para IA (10/día/usuario) y proveedores (60/min/usuario) | `worker/request-quota-ledger.js` |
| Email | Brevo/Resend con ledger de entrega, KV para suscripciones y tokens de unsubscribe, cron de digests | `worker/email-notifications.js` |
| Identidad de paper pública | `stablePaperId`: `doi:<minúsculas>` > `arxiv:<id>` > `paper.id` crudo; las URLs públicas usan base64url con prefijo `doi:`/`arxiv:` y precedencia de DOI | `src/services/publicListService.js:81-87`, `docs/PUBLIC_DISCOVERY.md` |

## Decisión 1 — Qué escrituras van directas y cuáles pasan por el Worker

Criterio: una escritura va directa a Firestore **si las rules pueden decir todo
lo que hay que decir sobre ella** (quién, forma, tamaño, ritmo mínimo). Pasa
por el Worker solo cuando necesita un secreto, un dato que el cliente no debe
ver, o una garantía que las rules no pueden expresar. Cada salto al Worker
cuesta: latencia por operación, más código con tests, y —la primera vez que el
Worker escriba Firestore— una identidad de servicio nueva (ver Decisión 2).

| Escritura | Vía | Por qué |
| --- | --- | --- |
| Perfil público, handle (F1) | **Directa** | Es el patrón `publicLists`/`publicListOwners` tal cual: doc público + doc de reserva de nombre con `getAfter`. Las rules validan todo. |
| Vínculo perfil→listas (F1) | **Directa** | El dueño edita su propio doc. |
| Follows entre usuarios (F2) | **Directa** | Un doc por arista con `followerUid == request.auth.uid` en el ID y en el campo. Nada que moderar. |
| Comentarios (F3) | **Directa, con throttle declarativo** | Ver análisis abajo. Es la decisión discutible del documento. |
| Anotaciones/explicaciones (F4) | **Directa** | Mismo régimen que comentarios. |
| Reportes de moderación (F3/F4) | **Directa** | Create-only por usuarios; solo el admin lee. |
| Acciones de admin (ocultar, borrar) | **Directa** | UID de admin cableado en rules (`isAdmin()`). Un equipo de una persona no necesita panel servidor. |
| Verificación de investigador (F6) | **Worker** | El resultado otorga confianza que un cliente no puede autoafirmarse. Requiere el secreto OAuth de ORCID y una escritura que las rules deben poder distinguir de cualquier escritura de usuario. |
| Relay de correo (F7) | **Worker** | El correo del destinatario no puede tocar el cliente jamás. Secretos de Brevo/Resend ya viven ahí. |
| Stubs de paper | **Directa** | Cache de metadatos públicos con la validación `validPublicPaper` que ya existe. Crearlos vía Worker duplicaría la normalización sin ganar nada. |

### Por qué los comentarios van directos (y cuándo dejar de hacerlo)

Lo que las rules **sí** garantizan: autor real (`authorUid == auth.uid`), forma
cerrada, texto acotado (p. ej. 4.000 chars), campos inmutables tras crear,
edición/borrado solo del autor o admin, y un **intervalo mínimo entre
comentarios** con el patrón de throttle declarativo:

```
users/{uid}/rateLimits/{action}   { lastAt: timestamp, count: int }

// En la rule del comentario:
//   getAfter(rateLimits/comments).lastAt == request.time
// En la rule del doc rateLimits:
//   request.time > resource.data.lastAt + duration.value(15, 's')
```

El cliente escribe comentario + doc de throttle en un mismo batch; sin el
segundo, la primera rule falla. Coste: 1 escritura extra y ~2 lecturas de
rules (`getAfter`/`get` se facturan como lecturas) por comentario. Es burdo
—un intervalo fijo, no una cuota diaria— pero es gratis y frena el spam
mecánico.

Lo que las rules **no** pueden garantizar: contenido (insultos, enlaces
basura), cuotas por día, ni nada semántico. Con pre-producción, pocos usuarios
y un solo admin, eso se cubre con moderación reactiva (reportes + ocultar,
`02-SECURITY.md`) en lugar de con un proxy de escritura.

**Umbral de cambio de opinión**: si aparece spam que el intervalo mínimo no
frena, o el volumen de reportes supera lo que una persona revisa en ~15
min/día, los creates de comentarios migran al Worker (validación + cuota diaria
en el `RequestQuotaLedger` existente + escritura con identidad de servicio).
El modelo de datos no cambia: solo cambia quién ejecuta el `create`, así que la
migración es barata si el doc de comentario se diseña igual desde el principio.
Las rules pasarían de "create si authed" a "create si admin/servicio".

## Decisión 2 — El Worker gana una identidad de servicio (una sola vez)

F6 y F7 comparten un requisito que hoy no existe: el Worker tiene que **leer y
escribir Firestore** (grabar una verificación, leer el email de contacto) con
una autoridad que ningún cliente tiene. Eso es una service account de Google
con acceso a Firestore, usada desde el Worker vía la API REST de Firestore
(firma JWT RS256 con WebCrypto; sin Admin SDK, que no corre en Workers).

- Se hace **una vez**, como fase propia (`04-PHASES.md`, fase 8), antes de F6.
- La service account se crea dedicada y con el mínimo rol posible sobre
  Firestore, no la default del proyecto. Su clave va en `wrangler secret`.
- Las rules distinguen las escrituras de servicio porque la REST API con
  service account **salta las rules por completo** (es acceso privilegiado).
  Consecuencia: las colecciones que solo escribe el servicio se declaran
  `allow write: if false` en rules y quedan inescribibles para todo cliente.
  Es la garantía más fuerte disponible: más simple que custom claims y
  auditable leyendo las rules.
- Riesgo asumido: un secreto más en el Worker cuyo compromiso da acceso a
  Firestore. Mitigación: rol mínimo, y las colecciones de verificación son
  reconstruibles (re-verificar) — véase `05-RISKS.md`.

Pregunta abierta (STATE.md): confirmar el flujo exacto de OAuth2
service-account desde Workers (grant `jwt-bearer` contra
`oauth2.googleapis.com/token`) y qué rol IAM mínimo permite leer/escribir solo
las colecciones necesarias (los roles de Firestore son por base de datos, no
por colección; el aislamiento por colección lo dan las rules para clientes y
la disciplina de código para el servicio).

## Decisión 3 — Stubs de paper: `papers/{paperKey}`

No almacenamos papers, pero comentarios (F3) y anotaciones (F4) necesitan un
documento del que colgarse. El stub es un **cache mínimo de metadatos
públicos**, no una copia del paper: la fuente de verdad sigue siendo los
proveedores.

### Clave canónica

El repo ya resolvió este problema dos veces y media; se adopta la solución de
las superficies públicas y se corrige su defecto (DOIs con `/` no pueden ser
IDs de documento — la familia de bug que ya mordió en `interactions`):

```
canonicalKey(paper):
  1. doi     → "doi:" + doi en minúsculas, sin prefijo https://doi.org/
  2. arxivId → "arxiv:" + id sin sufijo de versión (2401.12345, no 2401.12345v2)
  3. si no   → paper.id crudo con su prefijo de proveedor (pmid:…, ads:…)

paperKey (ID del documento) = base64url(canonicalKey)   // alfabeto [A-Za-z0-9_-]
```

- **DOI antes que arXiv**, como ya hace `getPublicPaperPath`. Casi todos los
  proveedores que traen un paper de arXiv traen también su DOI cuando existe,
  así que dos usuarios que llegan por rutas distintas convergen en la misma
  clave en el caso común.
- **Sin versión de arXiv**: un comentario pertenece al paper, no a la v2.
  (Las URLs públicas conservan la versión; la clave de stub no. Son contratos
  distintos y no hay que unificarlos.)
- base64url es válido como ID de Firestore (sin `/`), reversible, y es el
  mismo encoding que ya usan las URLs `/public/paper/<key>`. El límite de
  1.500 bytes de un ID de documento no se alcanza (DOIs reales < 300 chars).
- El campo `canonicalKey` se guarda también dentro del doc en claro, para
  poder leerlo sin decodificar y para consultas.

### Campos, creador, momento

```
papers/{paperKey}
  canonicalKey  string            "doi:10.1234/abc" | "arxiv:2401.12345"
  title         string  ≤500
  authors       list    ≤20×160   solo nombres
  year          int?
  category      string? ≤120
  abstract      string? ≤1500     truncado; es un cache, no el texto
  doi           string? ≤300
  arxivId       string? ≤100
  openUrl       string? ≤2000     https
  createdAt     timestamp
  createdBy     string            uid; solo auditoría
  commentCount  int               contador mantenido por increment
  annotationCount int             ídem
```

- **Quién lo crea**: el primer usuario autenticado que ejecuta una acción
  pública sobre el paper (comentar, anotar), en el mismo `writeBatch` que esa
  primera acción. Nadie crea stubs por navegar: cero escrituras nuevas en el
  camino caliente del feed.
- **Validación**: la función de rules es `validPublicPaper` ya existente, con
  ajustes menores (el techo de abstract, `canonicalKey` coherente con
  `doi`/`arxivId` presentes). El precedente de validación está escrito y
  probado.
- **Inmutable tras crear** salvo los contadores (increment de ±1 validado en
  rules) y el admin. Un cache que cualquiera puede reescribir es un vector de
  defacement: el título del stub es lo que ven todos los lectores de
  comentarios. Si el metadato cacheado queda obsoleto (título corregido en el
  proveedor), lo repara el admin o una migración; no un usuario cualquiera.

### El caso de las dos rutas y el split-brain

Dos usuarios comentan el mismo paper llegado por rutas distintas:

- **Caso común**: ambos objetos Paper traen DOI (o ninguno lo trae y ambos
  traen arXiv ID) → misma `canonicalKey`, mismo stub. El segundo `create`
  falla porque el doc existe; el cliente lo trata como éxito (create-if-missing
  con fallback a lectura) y cuelga su comentario del stub existente.
- **Caso divergente**: la ruta A trae solo arXiv ID y la ruta B trae el DOI
  del mismo paper → dos stubs, comentarios partidos. Es inherente a no tener
  base de papers propia; ninguna heurística del cliente lo cierra del todo.
  Mitigaciones, por orden:
  1. El cliente calcula la clave con el objeto Paper **ya deduplicado y
     enriquecido** por `PaperBuilder.merge` (el enriquecimiento OpenAlex suele
     añadir el DOI al objeto de arXiv), lo que encoge la ventana al caso
     "paper tan nuevo que aún no tiene DOI en ningún proveedor".
  2. Al abrir la vista de comentarios con un objeto que tiene ambos IDs, el
     cliente consulta las dos claves (2 lecturas) y muestra la unión; si
     ambas existen, lo señala al admin (report automático de tipo `dup-stub`).
  3. La fusión es una operación de admin documentada (mover subcolección de
     comentarios al stub canónico, dejar en el perdedor `mergedInto:
     <paperKey>`), no un mecanismo automático. Con el volumen esperado, es
     un caso raro que no justifica infraestructura.

### Qué NO es el stub

- No es una base de papers navegable ni el inicio de "publicar papers propios"
  (fuera de alcance por decisión previa). No hay listado global de stubs, no
  hay búsqueda sobre stubs, y el feed nunca los lee: el feed sigue siendo
  100% en vivo de proveedores.
- No des-duplica retroactivamente `interactions` ni `savedPapers`, que siguen
  con sus IDs actuales. Arreglar la identidad de esas colecciones privadas es
  otro proyecto (está apuntado en `05-RISKS.md` como deuda relacionada, y el
  bug de DOIs con `/` en `interactions` merece ficha propia fuera de este
  plan).

## Resumen del flujo de una escritura social

```
Comentario:  cliente ──writeBatch──▶ papers/{key} (si falta) + comments/{id}
                                     + rateLimits/comments + increment count
Verificación:cliente ──▶ Worker (/verify/orcid) ──REST+SA──▶ researcherVerifications
Correo F7:   cliente ──▶ Worker (/relay/contact) ──▶ Brevo/Resend (email jamás al cliente)
```
