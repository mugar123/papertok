# 01 — Modelo de datos

Restricciones citadas donde aplican:

- **1 MiB por documento** (límite duro de Firestore,
  firebase.google.com/docs/firestore/quotas). Nada de crecimiento sin cota
  dentro de un doc: seguidores, comentarios e hilos van en colecciones con
  un doc por elemento, paginadas.
- **Coste por lectura.** El free tier se mide en lecturas/día. Regla del
  proyecto tras el bug de `interactions` (`docs/INTERACTION_PROFILE.md`):
  ninguna consulta sin `limit()`, y ningún patrón cuyo coste crezca con la
  antigüedad de la cuenta. Cada colección de abajo declara su coste.
- Las llamadas `get()`/`exists()`/`getAfter()` **dentro de rules se facturan
  como lecturas**; se cuentan en el coste de cada escritura.
- `count()` de agregación se factura ~1 lectura por cada 1.000 entradas de
  índice: es la vía barata para contadores que no necesitan estar en pantalla
  en tiempo real.

Convención: `paperKey` = base64url de la clave canónica (`00-ARCHITECTURE.md`).
"Admin" = UID cableado en rules mediante `isAdmin()`.

---

## Colecciones nuevas

### `papers/{paperKey}` — stub de paper (F3/F4)

Forma completa en `00-ARCHITECTURE.md`. Resumen operativo:

| | |
| --- | --- |
| Lee | Cualquiera (incluido no autenticado: la vista pública de comentarios lo necesita) |
| Escribe | Create: cualquier usuario autenticado, validado con `validPublicPaper` ampliada. Update: solo contadores por increment ±1 en batch con el comentario/anotación, o admin. Delete: admin. |
| Patrón de acceso | `getDoc` puntual al abrir la hoja de comentarios/anotaciones. **El feed no lo lee jamás**: la insignia de "N comentarios" en la tarjeta se carga solo al abrir la hoja, no por tarjeta renderizada — N lecturas por carga de feed es exactamente la familia de bug recién arreglada. |
| Índices | Ninguno compuesto. Acceso siempre por ID. |
| Cota | Doc acotado por rules (~7 KB máx). Los contadores son ints. |

### `papers/{paperKey}/comments/{commentId}` — comentarios (F3)

```
commentId       auto-ID de Firestore
authorUid       string        == request.auth.uid al crear; inmutable
authorHandle    string ≤40    snapshot del handle al comentar (denormalizado)
text            string ≤4000
createdAt       timestamp     == request.time; inmutable
editedAt        timestamp?
status          string        'visible' | 'hidden'   (solo admin lo cambia)
replyTo         string?       commentId padre; un solo nivel, sin árboles
```

| | |
| --- | --- |
| Lee | Cualquiera, **solo con** `where('status','==','visible')` + `orderBy(createdAt desc)` + `limit(20)` y cursor. El autor y el admin pueden leer también los ocultos (rules por doc no filtran queries: la query del cliente normal lleva el `where` de status y las rules exigen que los list-reads lo lleven — o alternativa más simple: los ocultos siguen siendo legibles pero el cliente los filtra, y el borrado real es de admin; decidir en implementación, apuntado en STATE.md). |
| Escribe | Create: autenticado + throttle declarativo (batch con `users/{uid}/rateLimits/comments`) + increment de `commentCount` en el stub. Update: autor solo `text`/`editedAt`; admin solo `status`. Delete: autor o admin (con decrement). |
| Patrón de acceso | Paginación por cursor al abrir la hoja. Respuestas (`replyTo`) se cargan con la misma query y se agrupan en cliente: **un nivel de anidación**, sin subcolecciones de respuestas — hilos profundos son coste de moderación y de lecturas. |
| Índices | Compuesto de subcolección: `status asc, createdAt desc`. Collection-group sobre `comments`: `authorUid asc, createdAt desc` (pantalla "mis comentarios" y revisión de admin por autor). |
| Coste por comentario | 1 write comentario + 1 write throttle + 1 write increment (mismo batch) + ~2 lecturas de rules. Lectura de hoja: 1 (stub) + ⌈N/20⌉ páginas. |
| Cota | Un doc por comentario ⇒ el hilo crece por número de docs, nunca por tamaño de doc. |

### `papers/{paperKey}/annotations/{annotationId}` — anotaciones públicas (F4)

Igual que `comments` en régimen de acceso, con forma propia:

```
authorUid, authorHandle, createdAt, editedAt, status   — como comments
kind         string   'explanation' | 'summary' | 'context' | 'question'
text         string ≤8000                    markdown restringido + KaTeX
anchorType   string   'paper' | 'section' | 'quote'
anchorValue  string? ≤500    p.ej. "§3 Methods" o la cita textual anclada
```

El anclaje es **a nivel de paper, de etiqueta de sección o de cita textual**
(la cita viaja en el propio doc). Nunca posiciones de PDF: el porqué está en
`05-RISKS.md`. Solo los usuarios con verificación de investigador (F6) ven
destacadas sus anotaciones (`authorVerified` se resuelve en cliente leyendo el
perfil del autor, no se denormaliza aquí: evita invalidación).

Índices: los mismos dos que `comments`, sobre `annotations`.

### `userProfiles/{uid}` — perfil público (F1)

Separado de `users/{uid}` (que es privado, owner-only, y carga hasta 280 KB de
foto en el bootstrap de auth — no se toca, misma razón que motivó separar el
agregado de interacciones).

```
handle        string ≤40     minúsculas, [a-z0-9_], único vía handles/
displayName   string ≤80
bio           string ≤500
photo         string? ≤60000 data-URL recomprimida (NO la de 280 KB privada)
orcid         string?        SOLO escribible por servicio/admin (F6); el
                             cliente no puede escribirse este campo
verified      bool           ídem: solo servicio/admin
allowContact  bool           opt-in de F7; default false
pinnedLists   list ≤30 de { shareId ≤32, title ≤120, emoji ≤40, paperCount int }
followerCount int?           opcional, ver patrón de contadores abajo
createdAt, updatedAt
```

| | |
| --- | --- |
| Lee | Cualquiera. |
| Escribe | Owner, con rules que **excluyen** `orcid`/`verified` de las claves que un cliente puede tocar (esos dos solo los pone el servicio, y las rules de cliente los declaran intocables comparando con `resource.data`). |
| Patrón de acceso | 1 lectura por visita de perfil. Las listas pineadas están embebidas ⇒ el perfil con sus listas cuesta **1 lectura**; abrir una lista concreta cuesta la lectura de `publicLists/{shareId}` que ya existe. |
| Índices | Ninguno. Acceso por UID (ruta `/user/{handle}` resuelve vía `handles/`). |
| Cota | ≤30 listas embebidas × ~200 B ⇒ doc ≤70 KB con foto. |

Decisión F1: **la atribución de listas es opt-in por pineo**. `publicLists`
sigue sin campo de dueño (su anonimato actual es una propiedad deliberada de
`docs/PUBLIC_DISCOVERY.md`); una lista se vuelve atribuible solo cuando su
dueño la pinea en su perfil. Sin índice nuevo, sin query por dueño, sin
cambiar docs existentes. El pineo se mantiene a mano (al despublicar una lista,
el cliente la quita del perfil en el mismo batch).

### `handles/{handle}` — unicidad de handle (F1)

Calco de `publicListOwners`:

```
uid        string   == request.auth.uid
createdAt  timestamp
```

Create: solo si `getAfter(userProfiles/{uid}).handle == handle` (batch
atómico perfil+handle, mismo patrón `getAfter` que las listas públicas).
Delete: owner (cambio de handle = delete viejo + create nuevo + update perfil
en un batch). Lee: cualquiera (resolver `/user/{handle}` → uid: 1 lectura).

### `follows/{followerUid}_{targetUid}` — seguimiento entre usuarios (F2)

**No** se mete en `users/{uid}/following`: esa subcolección es privada,
owner-only, y modela entidades externas para el feed. Seguir usuarios necesita
lectura pública en ambos sentidos (quién sigue a X, a quién sigue X), que una
subcolección privada no puede dar sin romper su contrato actual.

```
followerUid  string   == request.auth.uid; coherente con el ID del doc
targetUid    string   coherente con el ID del doc
createdAt    timestamp
```

| | |
| --- | --- |
| Lee | Cualquiera (las listas de seguidores/seguidos son públicas; si se quisiera privacidad, es un cambio de rules, no de modelo). |
| Escribe | Create/delete: solo el follower. El ID compuesto hace la arista idempotente (no hay duplicados posibles) y el unfollow es un delete por ID sin query. Update: nadie. |
| Patrón de acceso | Seguidos de X: `where('followerUid','==',X) + orderBy(createdAt desc) + limit(30)` + cursor. Seguidores de X: simétrico con `targetUid`. Contadores: `count()` de agregación al abrir el perfil (≈1 lectura cada uno con <1.000 aristas). |
| Índices | Dos compuestos: `(followerUid asc, createdAt desc)` y `(targetUid asc, createdAt desc)`. |
| Cota | Un doc por arista. Nada crece dentro de un doc. |

Contadores en el perfil: **empezar con `count()` bajo demanda**, sin
denormalizar. Umbral para cambiar: si un perfil supera ~10.000 seguidores
(10 lecturas por visita), pasar a `followerCount` mantenido por increment
cross-user validado en rules (`getAfter` de la arista). A la escala del
proyecto, ese umbral queda lejos; el campo opcional ya está reservado.

"Feed de seguidos" (actividad): fuera del alcance de F2 (F2 = grafo +
contadores + lista). La actividad pública de un usuario ya es consultable
por las collection-group queries de `comments`/`annotations` por `authorUid`
y por sus `pinnedLists`; un timeline agregado sería un fan-out caro y se
pospone deliberadamente (`05-RISKS.md`).

### `reports/{reportId}` — moderación (F3/F4, ver 02-SECURITY)

```
reportId     auto-ID
reporterUid  string    == request.auth.uid
targetPath   string ≤500   ruta del doc reportado
targetAuthorUid string
reason       string    'spam' | 'abuse' | 'other' | 'dup-stub'
note         string? ≤500
status       string    'open' | 'resolved' | 'dismissed'   (solo admin)
createdAt    timestamp
```

Create: autenticado, `status == 'open'`, con throttle (`rateLimits/reports`).
Lee/update/delete: **solo admin**. Índice compuesto: `status asc, createdAt asc`
(cola FIFO de revisión). Coste: la cola del admin es
`where status=='open' limit(50)`.

### `researcherVerifications/{uid}` y `researcherClaims/{orcidId}` (F6)

Escritura **exclusiva de la identidad de servicio** (cliente: `write: false`;
detalle del flujo en `02-SECURITY.md` y `03-AUTH.md`).

```
researcherVerifications/{uid}
  method      'orcid' | 'edu-email' | 'manual'
  orcid       string?      con checksum válido
  eduDomain   string?
  status      'verified' | 'revoked'
  verifiedAt, revokedAt?, notes (admin)

researcherClaims/{orcidId}          — unicidad: un ORCID, un uid
  uid         string
  status      'active' | 'disputed' | 'revoked'
  createdAt
```

Lee: `researcherVerifications` el propio usuario y admin;
`researcherClaims` cualquiera (resolver página de investigador → uid).
El flag público visible es `userProfiles.verified`, que el servicio actualiza
en la misma operación. Coste: cero en caminos calientes; solo se toca al
verificar.

### `users/{uid}/rateLimits/{action}` — throttle declarativo

```
lastAt   timestamp   == request.time al escribir
count    int         acumulado informativo
```

Owner-only. Acciones: `comments`, `annotations`, `reports`, `stubs`.
Patrón de uso en `00-ARCHITECTURE.md`. Sin índices.

---

## Cambios a colecciones existentes

| Colección | Cambio | Justificación |
| --- | --- | --- |
| `users/{uid}` | **Ninguno.** | El perfil público vive aparte; el doc privado no gana campos. |
| `users/{uid}/following` | **Ninguno.** No se añade `type: 'user'`. | Ver `follows/` arriba. |
| `publicLists`, `publicListOwners` | **Ninguno** en forma. | La atribución va por pineo en el perfil. Única mejora opcional futura: subir el cap de 12 papers, que es ortogonal a este plan. |
| `users/{uid}/interactions` | **Ninguno** en este plan. | La identidad inconsistente de `paper.id` (DOIs con `/`, prefijos dispares — hallazgo del reconocimiento) es deuda real pero previa a lo social; se registra como riesgo/deuda en `05-RISKS.md` y no se mezcla. |
| `firestore.rules` | Se añaden los bloques de todas las colecciones nuevas + `isAdmin()`. | Boceto en `02-SECURITY.md`. |

## F7 no añade colecciones

El correo del destinatario ya vive en Firebase Auth; el Worker con identidad
de servicio lo obtiene por `accounts:lookup` administrativo en el momento de
enviar y no lo persiste en ningún sitio legible. El opt-in es
`userProfiles.allowContact`; el throttling vive en el `RequestQuotaLedger`
(Durable Object) que ya existe. Diseño completo en `02-SECURITY.md`.

## Resumen de coste de los caminos calientes

| Camino | Lecturas |
| --- | --- |
| Carga de feed | **Sin cambio: 1** (agregado de interacciones). Nada social se lee en el feed. |
| Abrir hoja de comentarios | 1 stub + 1 página de 20 (+1 si clave dual, caso raro) |
| Publicar comentario | 3 writes en batch + ~2 lecturas de rules |
| Perfil público | 1 perfil (+1 si se llega por handle) + 2 `count()` |
| Página de lista pública | Sin cambio: 1 |
| Seguir / dejar de seguir | 1 write / 1 delete |
