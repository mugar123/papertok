# 06 — F12: Las listas llevan nombre

**Estado: APROBADO (2026-08-21) con tres decisiones tomadas. P22+P23
IMPLEMENTADAS el mismo día (rules v1 + Worker + app + migración), todo verde y
SIN desplegar ni commitear — ver "Estado de implementación" al final.** Al cerrarse la fase, esto se pliega en `04-PHASES.md` y las
secciones de impacto del final se aplican a `01-DATA-MODEL.md` y
`02-SECURITY.md`. Las decisiones:

1. **Atribución solo en dirección perfil → listas.** Sin `ownerUid` en
   `publicLists` y sin "por @handle" en la página de la lista. La forma del
   documento público no cambia en nada; P15 no se renegocia y no queda ningún
   residuo de identidad que explicar. (El primer borrador proponía el
   backlink; descartado a propósito.)
2. **Atribuido por defecto en publicaciones nuevas.**
3. **Las guardadas son privadas en esta fase.** Y el contador de guardados no
   se hace.

Tres cambios de producto y una decisión de sincronización:

1. **Publicar = público y visible en tu perfil.** Invierte la decisión de F1
   (`publicLists` anónimo, atribución opt-in por pineo).
2. **Fijar = destacar, no publicar.** Máximo **3** (hoy 6).
3. **Guardar listas de otras personas.**
4. **La copia pública sigue a la lista privada al editar** (hoy es una foto
   congelada con botón manual de actualizar).

---

## Por qué 1 y 2 son UNA remodelación, no dos cambios

Hoy la atribución y el render del perfil son la misma cosa: la tarjeta fijada
(`pinnedLists` en `userProfiles/{uid}`), un array denormalizado que el cliente
escribe y las rules validan con `ownsPinnedShare()` — un `get()` por entrada,
seis entradas desenrolladas, y el presupuesto de 1000 expresiones agotado
(P16: "seis es techo y tope a la vez").

Si publicar atribuye, la atribución deja de vivir en un documento que escribe
el cliente: **la escribe el Worker, que ya es quien publica** (F11). Y en
cuanto la tarjeta la escribe el Worker, las rules no tienen que validarla —
`allow write: if false` cuesta cero expresiones. El pin queda reducido a lo
único que de verdad es suyo: **un orden**, tres share ids como mucho, sin
`get()` y sin tarjeta. Consecuencias en cadena:

- **El presupuesto de expresiones se recupera**, no se gasta. Fuera
  `validPinnedList`, `validPinnedLists`, `ownsPinnedShare`: se liberan 6
  `get()` y cientos de expresiones del camino de guardado de perfil. Esto
  deshace el "la siguiente cláusula baja el tope a 5" que bloqueaba a P17.
- **La familia de bugs del pin huérfano desaparece.** Un share id rancio en el
  orden de pines no valida nada y no bloquea nada: el render es
  `proyección ∩ pines`, y lo que no está en la proyección no se pinta.
- **`refreshPinnedCard` del Worker queda superseded** (commits `4c2f46a`,
  `2a0b0c6`): la tarjeta pasa a mantenerse **en el mismo commit** que publica
  o actualiza, sin carrera con el cliente, porque el documento que la aloja
  solo lo escribe el Worker. La maquinaria de preconditions y reintentos se
  queda solo durante la ventana de migración.

## El modelo de datos

### `profileLists/{uid}` — el escaparate de listas (nuevo, solo Worker)

Un documento por usuario con las tarjetas de sus listas publicadas **y
atribuidas**:

```
lists      list ≤30 de { shareId ≤32, title ≤120, emoji? ≤40,
                         paperCount int, publishedAt timestamp }
updatedAt  timestamp
```

| | |
| --- | --- |
| Lee | `get`: el dueño, o cualquiera **si el perfil es público** — la rule hace `get(userProfiles/{uid})` y aplica `profileIsPublic` (+1 lectura facturada por apertura de pestaña; la rama del dueño cortocircuita antes del `get`). `list: false`. |
| Escribe | **Nadie desde cliente** (`write: false`). Solo el Worker, en el mismo commit que publica/actualiza/despublica/atribuye. |
| Patrón de acceso | 1 `getDoc` al abrir la pestaña Listas de un perfil. El perfil en sí no cambia de coste. |
| Cota | ≤30 tarjetas × ~250 B ≈ 8 KB. El tope de 30 listas publicadas-atribuidas por cuenta lo impone el Worker (`PROFILE_LISTS_FULL`), no las rules. |

**La existencia de la tarjeta ES el interruptor por lista** (la lección de
P17): una lista publicada con "mostrar en mi perfil" apagado simplemente no
está en la proyección. No hay flag que pueda discrepar del artefacto.

Por qué no un campo en `userProfiles/{uid}`: ese documento lo escribe el
cliente con merge, así que cualquier campo nuevo pasa por `hasOnly` y por el
presupuesto — exactamente lo que este diseño existe para no pagar. Por qué no
`profileShowcase/` de P17: aquellas estanterías las escribe el cliente y sus
rules las validan; esta la escribe el Worker y sus rules la vetan. Mezclar dos
regímenes de escritura en una colección es pedirse un bug de rules.

Por qué la puerta de lectura es un `get()` y no `!existsAfter` en el perfil
(el patrón de P16/P17): la proyección la escribe el Worker, y volverse privado
es una escritura de cliente — el cliente no puede llevarse en su batch un
documento que no puede escribir. Con el `get()` en la lectura, volverse
privado no necesita tocar la proyección para esconderla, y volver a público la
revela sin reconstruir nada. Cero expresiones nuevas en la escritura del
perfil, en las dos ramas.

### `publicLists/{shareId}` — sin cambios (decisión 1)

La atribución va **solo** en dirección perfil → listas. El documento público
no gana `ownerUid` ni ningún otro campo, `PublicListPage` no cambia, y la
promesa de P15 queda intacta: la lista compartida por enlace sigue siendo
anónima, y volverse privado esconde la atribución entera — el escaparate es
ilegible tras la puerta del `get()`, igual que hoy lo son los pines dentro del
documento del perfil. Cero residuo de identidad en documentos públicos.

### `pinnedShareIds` sustituye a `pinnedLists` en `userProfiles/{uid}`

```
pinnedShareIds   list ≤3 de string ^[a-f0-9]{32}$
```

- Validación en rules: tope 3, tres comprobaciones de formato desenrolladas.
  **Sin `get()`, sin tarjeta, sin `ownsPinnedShare`**: fijar un share id ajeno
  o muerto es inofensivo porque el render es `proyección ∩ pines` — lo que no
  está en TU proyección no se pinta, así que no hay atribución falsificable.
- El orden del array es el orden de los destacados; el resto de la proyección
  va debajo, por `publishedAt` desc.
- `pinnedLists`, `showPinnedLists` y `users/{uid}/profileStash/pinnedLists` se
  retiran tras la migración (ver Migración). El trabajo de "ocultar mis
  listas" pasa al interruptor por lista ("mostrar en mi perfil"), que es más
  fino y no necesita stash: la fuente (lista privada + copia pública) nunca se
  va de casa.

### `users/{uid}/savedLists/{shareId}` — listas guardadas de otros (nuevo)

**Referencia, no copia.** Una copia congelaría el contenido y duplicaría hasta
~550 KB por guardado; la referencia cuesta ~200 B y la lectura en vivo ya
existe (el `get` público de `publicLists/{shareId}`).

```
title        string ≤120     tarjeta congelada al guardar, solo para render
emoji        string? ≤40
paperCount   int 0..50
savedAt      timestamp == request.time
```

| | |
| --- | --- |
| Lee/escribe | Solo el dueño del árbol (owner-only, como `savedPapers`). El id del doc es el shareId: guardar dos veces es idempotente, quitar es un delete por id. |
| Privacidad | **Privado en esta fase.** No aparece en el perfil público. "Guardar en mi perfil" = pestaña/sección visible para MÍ (vista de dueño), como los Guardados de papers. Republicarla en tu perfil público sería re-compartir contenido ajeno con su propia matriz de problemas (tarjeta muerta al despublicar el dueño, atribución de terceros) y no se hace aquí. |
| Rules | Forma y tamaños; `savedAt == request.time`. **No** se valida que el shareId exista (costaría un `get()`; guardar un id muerto es autolesión). Crecimiento del propio árbol sin tope de rules: el mismo trato que `savedPapers` e `interactions`, lecturas siempre acotadas. |
| Render | La tarjeta congelada pinta la fila sin lecturas; abrirla lee la versión viva. Si el dueño despublicó, el `get` da ausencia ⇒ estado "Esta lista ya no está disponible" + botón para quitar la guardada. Título rancio posible hasta abrirla; al abrir, refresco barato de la tarjeta (1 write propio, opcional). |

**Contador de guardados: NO, recomendado.** Si el dueño viera "N personas la
han guardado", el número tendría que salir de algún sitio: (a) un contador
denormalizado en `publicLists` — el cliente no puede escribirlo (Worker-only),
así que cada guardado pasaría por el Worker: cuota, latencia y un endpoint
nuevo para una escritura que hoy es 1 write directo; o (b) una collection-group
sobre `savedLists` con `where('targetOwnerUid','==',yo)` — obliga a
denormalizar el uid del dueño en cada guardado, abre una dirección de lectura
sobre subcolecciones privadas y, en cuanto exista la query, existe la pregunta
"¿quién?", que es telemetría de interés personal que este proyecto trata como
privada (los guardados de papers lo son). Guardar debe ser un acto privado del
que guarda, como en el resto de la app. Si algún día se quiere, es la vía (a)
con recuento sin identidades, y una fase propia.

### `users/{uid}/lists/{listId}` gana dos campos (para la sincronización)

```
updatedAt       timestamp?   lo sella el cliente en cada edición
publicSyncedAt  timestamp?   lo sella el Worker en cada sync que comete
```

Sucio = `updatedAt > publicSyncedAt`. Sobrevive a sesiones y cuesta 0 lecturas
(el doc ya se lee). Un cliente hostil puede falsificar su propio
`publicSyncedAt` y silenciar su propio indicador: autolesión, no se protege
(protegerlo costaría presupuesto en `lists/` a cambio de nada).

## Qué imponen las rules y qué el Worker

| Garantía | Dónde | Cómo |
| --- | --- | --- |
| Nadie fabrica ni edita tarjetas del escaparate | rules | `profileLists/`: `write: false` |
| El escaparate de un perfil privado no se lee | rules | `get` condicionado a `profileIsPublic(get(userProfiles/{uid}))` o dueño |
| Nadie se atribuye la lista de otro | Worker | `requireOwnedShare` (ya existe) antes de escribir la tarjeta |
| Tope de 3 pines, formato de share id | rules | `pinnedShareIds` ≤3, tres matches desenrollados, sin `get()` |
| Pin de lista ajena/muerta inofensivo | construcción | render = proyección ∩ pines |
| Tope de 30 listas en el perfil | Worker | cuenta las tarjetas de la proyección al publicar/atribuir |
| Guardadas: solo el dueño, forma acotada | rules | subcolección owner-only, `savedAt == request.time` |
| Atribución retroactiva solo con consentimiento | Worker + UI | ningún endpoint atribuye sin la acción explícita (ver Migración) |
| La copia pública no encoge por deshidratación | Worker | merge en `/lists/update` (ver Sincronización) |
| Cuotas diarias | Worker | el ledger existente (60/usuario, 2000 global), sin cambios |

Endpoints del Worker (P22): los tres de F11 ganan mantenimiento de proyección
en el mismo commit, más **`POST /lists/attribute`** `{shareId, attributed:
bool}` — enciende/apaga la atribución de una lista ya publicada sin tocar su
contenido (lee owner + doc público + lista privada para la tarjeta; comete
tarjeta + espejo `onProfile` en la lista privada en un commit). El espejo
`onProfile` en la lista privada existe para que "¿está en mi perfil?" se pinte
en Mis listas sin leer la proyección.

## Las preguntas del encargo, una a una

### ¿Se atribuyen retroactivamente las listas publicadas anónimas?

**No.** P15 fijó que la visibilidad de datos no cambia a espaldas de nadie, y
atribuir en bloque lo haría. La línea exacta:

- **Listas fijadas hoy = consentimiento ya dado.** La tarjeta fijada ES
  atribución pública hoy mismo (vive en el doc público del perfil). Migrarlas
  a la proyección no revela nada nuevo: **se migran automáticamente** (ver
  Migración). Nadie pierde lo que ya enseñaba.
- **Listas publicadas sin fijar = anónimas se quedan.** En Mis listas aparecen
  con el interruptor "Mostrar en mi perfil" **apagado**; encenderlo es el acto
  de consentimiento (llama a `/lists/attribute`). Republicar por "Actualizar"
  **no** atribuye en silencio.
- **Publicaciones nuevas**: atribuidas por defecto, y el propio flujo de
  publicar lo dice antes del clic ("se verá en tu perfil"), con el interruptor
  a mano. El caso "compartir por enlace sin escaparate" sigue existiendo:
  publicar con el interruptor apagado.

En producción hay una lista publicada y una fijada (la misma): la migración
real es un caso.

### ¿Qué pasa si mi perfil es privado y publico una lista?

Se permite (hoy también). La lista es pública por su enlace; la atribución
queda **latente**: la proyección existe pero su lectura está denegada (la
puerta del `get()`). Al volverte público, aparece sin tocar nada. La copy del
interruptor de atribución lo dice cuando el perfil está privado ("nadie verá
la atribución mientras tu perfil sea privado"). Con la decisión 1 no hay nada
más que explicar: la página de la lista es anónima siempre y P15 sigue
diciendo la verdad palabra por palabra.

### El tope de 3: cabe, y qué pasa con quien tenga 4–6

- **Cabe con margen que sobra**: no es que bajar de 6 a 3 quepa — es que la
  validación entera se abarata en un orden de magnitud (fuera los `get()` y el
  desenrollado de tarjetas; F11 midió que el desenrollado se paga aunque
  cortocircuite, así que recortarlo libera de verdad). Aun así se re-mide
  contra el emulador con el método fijado (extender el desenrollado al medir,
  solo `allowed` como señal), porque la ventana de migración tiene ambas
  validaciones vivas — ver Migración, que es donde está el riesgo real.
- **Quien tenga 4–6 fijadas**: sus 4–6 listas **siguen visibles en su perfil**
  (todas pasan a la proyección: fijar era consentir), y las 3 primeras por
  orden actual quedan destacadas. Nadie pierde visibilidad; pierde adornos del
  4º en adelante, y la UI lo dice al migrar. En producción nadie tiene más
  de 1 (se verifica por REST antes de desplegar, los pines son públicos).

### ¿Copia o referencia? / ¿Y si el dueño despublica, borra o se esconde?

Referencia (arriba). Efectos:

| El dueño… | La guardada del otro |
| --- | --- |
| Edita la lista | Ve la versión viva al abrirla (con P25, al día; sin P25, la última actualizada). Tarjeta congelada hasta abrir. |
| La despublica o la borra | Abrirla da ausencia ⇒ "Ya no está disponible" + quitar. La referencia muerta no rompe nada ni se limpia en cascada (sería un fan-out sobre árboles ajenos que las rules prohíben con razón). |
| Se vuelve privado | La lista sigue pública por enlace (contrato de P15): la guardada sigue funcionando; solo la atribución visible desaparece. |

## Sincronización al editar (la decisión, con números)

### Coste por edición si cada edición disparara un sync

Un `/lists/update` cuesta al Worker ~2–3 lecturas + 1 commit de 3 escrituras
(doc público + tarjeta de proyección + sello en la lista privada), más el
canje de identidad (no es Firestore). Añadir 30 papers uno a uno desde el
modal serían 30 llamadas: ~90 escrituras y **la mitad de la cuota diaria del
usuario (60)** en una sesión de curación. Inaceptable sin agrupar.

### Agrupado: sí, obligatorio

- **Debounce por lista, trailing, 45 s** (constante a ajustar 30–60 s): la
  ráfaga de N ediciones = 1 sync. Una sesión de curación intensa queda en
  ~5–15 syncs ≈ 15–45 lecturas y 15–45 escrituras: ruido frente a los topes de
  Spark (50k/20k) y dentro de la cuota de 60.
- **Flush al salir** (`pagehide`/`visibilitychange` con `fetch keepalive`): la
  edición de última hora no se queda colgada hasta la próxima sesión.
- El modal de guardar puede tocar varias listas publicadas en un commit: cada
  una arranca su propio debounce (N listas = N syncs, no N×papers).

### La trampa que el sync automático no puede heredar

`handlePublishList` construye hoy el payload con los papers **hidratados en
memoria** (`getPaper` con título real) y descarta el resto. Para un botón
manual en una página que hidrata, vale; un sync de fondo desde otro contexto
**encogería la lista pública en silencio**. Arreglo en el Worker, no en el
cliente: `/lists/update` gana semántica de **merge** — el cliente manda el
`paperIds` autoritativo (orden y bajas incluidos) más los papers que pudo
hidratar; el Worker lee el doc público actual (+1 lectura, ya contada) y
conserva la versión publicada de los ids que siguen en la lista y no llegaron
re-hidratados. Las bajas se propagan; la deshidratación no destruye.

### Si el sync falla

**Se queda rancio, se ve, y se reintenta — las tres cosas.** El estado sucio
es persistente (`updatedAt > publicSyncedAt`), así que sobrevive a cierres y
cortes; el cliente reintenta con backoff mientras la sesión vive, y la
siguiente sesión que abra Mis listas lo detecta y reintenta. Nunca se degrada
a silencio: la fila de la lista muestra "El enlace público va por detrás —
Reintentar".

### ¿Sigue el botón manual?

**Sí, transformado en indicador de estado**: "Al día / Sincronizando… /
Pendiente — Reintentar". Es la salida honesta del caso de fallo, el "ahora
mismo" para quien no quiere esperar el debounce, y la única vía si la cuota
diaria se agotó. Lo que desaparece es la obligación de pulsarlo.

## Migración

Orden de despliegue global: **rules v1 → Worker (P22) → app → [migración
perezosa] → rules v2**. Las rules van PRIMERO, y no es cosmético: el Worker
nuevo sella `onProfile` y `publicSyncedAt` en las listas privadas, y toda
escritura de cliente sobre esos documentos es un merge que arrastra el
documento entero contra el `hasOnly` — con las rules viejas, el primer publish
del Worker nuevo dejaría esa lista ineditable para su dueño (la familia exacta
del bug de las legacy keys de `users/{uid}`). Rules v1 es aditiva e inerte:
tolera claves que nadie escribe aún, describe una colección que no existe aún.
Las rules v2 (retirada del modelo viejo) al final, cuando ya no queden
escritores del modelo viejo.

1. **Antes de nada, verificar producción por REST** (los pines son públicos):
   cuántas cuentas tienen pines y cuántos. Esperado: 1 cuenta, 1 pin.
2. **Rules v1** (aditiva): entra `profileLists/` (get condicionado,
   write false), `pinnedShareIds` (≤3), y `onProfile`/`updatedAt`/
   `publicSyncedAt` en `lists/`. (`savedLists/` es de P24 y llegará en su
   propio despliegue aditivo.) `pinnedLists` y su validación **siguen
   vivas** tal cual. Tras rules v1 se despliega el **Worker** (P22), y solo
   entonces la app. Riesgo medido: durante la ventana conviven la validación
   vieja (tarjetas ≤6) y la nueva (≤3 strings); el coste añadido de la nueva
   es ~decenas de expresiones sin `get()`, pero P16 dejó el techo exacto en
   6/6/6 — **hay que medir si un guardado con 6 tarjetas + el campo nuevo
   pasa**. Si no pasa, no es bloqueo: en producción nadie tiene 6, y la
   ventana acaba en el paso 4. Se documenta el resultado midiendo, no
   suponiendo.
3. **App**: el perfil pasa a renderizar la pestaña Listas desde la proyección;
   al primer arranque de un dueño con pines, migración perezosa: por cada
   tarjeta fijada, `/lists/attribute` (consentimiento ya dado por el pineo);
   `pinnedShareIds` = los 3 primeros; `pinnedLists: []` y fuera
   `showPinnedLists` en el mismo guardado de perfil. Si había pines ocultos
   (stash de F8), **prompt** en vez de automatismo: ocultar era una intención
   explícita y atribuir sin preguntar la pisaría — la respuesta enciende o no
   `/lists/attribute` por lista, y el stash se vacía.
4. **Rules v2**: fuera `validPinnedList`, `validPinnedLists`,
   `ownsPinnedShare`, la clave `pinnedLists` del `hasOnly` (los perfiles ya
   migraron; los que no hayan entrado desde entonces migran en su primer
   guardado — v2 no se despliega hasta que producción esté migrada, que con
   dos cuentas es un día), la forma `pinnedLists` del stash. Re-medición
   completa del presupuesto y pasada de mutación. `refreshPinnedCard` se
   retira del Worker en este punto.
5. **Listas anónimas existentes**: sin migración de datos. Aparecen en Mis
   listas con "Mostrar en mi perfil" apagado; el interruptor es el opt-in.

Cada despliegue de rules lleva: suite de emulador completa, pasada de mutación
sobre las cláusulas nuevas, y verificación byte a byte de que los cuatro
arreglos de P16 (`searchIndexCoherentAfter`, `isAdmin()` en el delete de
`userSearch`, `createdAt` fuera del allowlist, consentimiento explícito)
siguen presentes.

## Costes (lecturas L / escrituras E)

| Camino | Hoy | Con F12 |
| --- | --- | --- |
| **Carga de feed** | **1 L** | **1 L, intocable** — nada de esto entra en su grafo; el test SOURCE gana `profileListsService`/`savedListsService` al veto |
| Perfil: cabecera | 1–2 L + 2 count | igual |
| Perfil: pestaña Listas (visitante) | 0 (pines embebidos) | **+2 L** (proyección + `get()` de su rule); dueño +1 L |
| Página de lista pública | 1 L | igual (decisión 1: sin atribución en la página) |
| Publicar | 1 L + 3 E | 2 L + 4 E (tarjeta en el mismo commit) |
| Actualizar / sync | 1 L + 1–2 E (+refresh best-effort) | 2–3 L + 3 E, atómico |
| Atribuir/desatribuir | — | 3–4 L + 3 E, una vez por lista |
| Guardar lista ajena | — | 1 E (el doc de la lista ya está en pantalla) |
| Mis listas (sección Guardadas) | — | +1 query acotada (`limit 60`) |
| Sesión de curación con sync | 0 automático | ~5–15 syncs agrupados ≈ ≤45 L + ≤45 E |

Todo dentro de Spark con órdenes de magnitud de margen; las cuotas del Worker
(60/usuario/día, 2000 globales) no cambian y el ledger sigue fallando cerrado.
Ninguna query nueva sin `limit`; ninguna colección se lee entera.

## Qué se rompe de lo que hoy funciona

- **`refreshPinnedCard` y los dos commits que lo trajeron** (`4c2f46a`,
  `2a0b0c6`) quedan superseded al final de la migración. Trabajo reciente que
  se tira, dicho de frente: la solución nueva es estrictamente mejor (atómica,
  sin carreras) porque cambia el dueño del documento, no porque aquello
  estuviera mal hecho.
- **`partitionStalePins`, `togglePinnedList`, `sanitizePinnedLists`,
  `pinListEntry`, `unpinListEntry`, `readPinnableLists`** y la UI de pineo del
  editor de perfil se reescriben o retiran (el pineo pasa a vivir junto a la
  lista, en Mis listas/perfil propio).
- **La pestaña Listas del visitante cuesta 2 lecturas más** (antes 0, iban
  embebidas). Es el precio de sacar las tarjetas del documento del perfil, y
  compra el presupuesto de expresiones y la atribución automática.
- **`showPinnedLists` y el stash de pines de F8 se retiran**; su sucesor es el
  interruptor por lista. Los tests de F8 sobre el stash se invierten o borran.
- **Tests de emulador de pines** (F1, P16, la medición 6/6/6): reescritos
  contra el modelo nuevo; la medición del techo se repite en v1 y en v2.
- **Documentos**: `01-DATA-MODEL.md` (sección `userProfiles`, decisión F1 de
  atribución), `02-SECURITY.md` (sección nueva §9), `04-PHASES.md` (F12),
  `docs/PUBLIC_DISCOVERY.md` — que además sigue diciendo "20 papers" y "never
  include owner identity": lo primero lleva rancio desde F11 (R9), lo segundo
  lo cambia esta fase.
- **No se rompe**: el enlace público de una lista (mismo shareId, misma URL,
  misma lectura de 1 doc), despublicar, borrar listas, el coste del feed, la
  búsqueda (P16 intacta: `userSearch` no gana campos), y P17, que sale
  beneficiada (recupera el margen de presupuesto).

## Fases

### P22 `[worker]` — El Worker atribuye y mantiene el escaparate
Proyección mantenida por publish/update/unpublish (mismo commit),
`/lists/attribute`, semántica de merge en update, tope de 30, sellos
`onProfile` y `publicSyncedAt` en la lista privada. Inerte hasta que la app lo
use — pero **detrás de rules v1** (ver orden de despliegue). Tests del Worker
(payload hostil, merge, atribución ajena denegada, tope, idempotencia).

### P23 `[rules]`+app — Pines de 3, perfil desde la proyección, migración
Rules v1 → app (render + migración perezosa + prompt de stash + interruptor
por lista) → rules v2. Las dos mediciones de presupuesto, mutación, y los
cuatro arreglos de P16 verificados en cada despliegue. `PublicListPage` no se
toca (decisión 1).

### P24 `[rules]`+UI — Guardar listas de otras personas
Rules de `savedLists` (aditivas, un despliegue) + botón Guardar en
`PublicListPage` (con `AuthPrompt` sin sesión) + sección Guardadas en Mis
listas con sus estados (viva/no disponible). Independiente de P22 y P23
(decisión 1: la tarjeta guardada no lleva dueño). **Ojo**: toca
`ListsPage.jsx` y `PublicListPage.jsx`, los archivos de la fase del modal de
guardar en curso — no arrancar hasta que esa fase aterrice.

### P25 — Sincronizar al editar
Motor de debounce + flush + estado sucio persistente + botón manual como
indicador. Necesita el merge de P22. Última a propósito: es la que menos
duele si se retrasa (el botón manual sigue funcionando mientras tanto).

Orden: P22 → P23 → (P24 ∥ P25). P24 puede adelantarse a P23 si se acepta
guardar listas aún anónimas (funciona: la referencia no depende de la
atribución).

## Lo que se recomienda NO hacer (y por qué)

- **Contador de "guardada N veces"**: razones arriba. Si se quiere, fase
  propia por la vía del Worker, sin identidades.
- **Atribución retroactiva automática de listas anónimas**: viola P15.
- **Re-compartir listas guardadas en el perfil público propio**: matriz de
  problemas propia (tarjetas muertas, atribución de terceros); fase futura si
  el producto lo pide.
- **Denormalizar handle/nombre del dueño en `publicLists` o en las tarjetas
  guardadas como verdad de render** (solo como pista): texto rancio y fuga de
  identidad tras volverse privado. La verdad es el `get` del perfil en vivo.
- **Cascada de limpieza de referencias guardadas al despublicar**: fan-out
  sobre árboles ajenos; la referencia muerta degrada bien y sale gratis.

---

## Impacto en `01-DATA-MODEL.md` (texto a aplicar al aprobar)

- Sección `userProfiles/{uid}`: `pinnedLists` (tarjetas ≤30 en el boceto, 6 en
  la implementación) se sustituye por `pinnedShareIds list ≤3 de string`; la
  decisión F1 "atribución opt-in por pineo" se marca **superseded por F12**:
  la atribución es por publicación (opt-out por lista), mantenida por el
  Worker en `profileLists/{uid}`, y el pin es solo orden.
- Colección nueva `profileLists/{uid}` (tabla como la de arriba: lee
  condicionado al perfil público, escribe solo Worker, ≤30 tarjetas, 1 lectura
  por pestaña).
- Colección nueva `users/{uid}/savedLists/{shareId}` (referencia con tarjeta
  congelada, owner-only, sin contador público).
- `publicLists`: la fila "Ninguno en forma" **se mantiene** (decisión 1: sin
  campo de dueño; sigue `write: false` para clientes).
- `users/{uid}/lists`: gana `onProfile` (Worker), `updatedAt` (cliente) y
  `publicSyncedAt` (Worker).
- Resumen de costes: perfil pestaña Listas +2 L; página de lista pública sin
  cambios; feed sin cambios.

## Impacto en `02-SECURITY.md` (texto a aplicar al aprobar)

Sección nueva **§9 — F12: atribución de listas, pines y guardados**:

- La atribución la escribe solo el Worker tras `requireOwnedShare`: nadie se
  atribuye la lista de otro, y las rules lo garantizan con `write: false`
  (cero presupuesto), no con validación.
- La lectura del escaparate está condicionada a perfil público vía `get()` en
  la rule — la privacidad del perfil gobierna la dirección perfil→listas sin
  añadir cláusulas a la escritura del perfil.
- Dirección lista→perfil: **no existe** (decisión 1). El documento público no
  lleva identidad del dueño; la página de la lista es anónima siempre, y P15
  sigue siendo verdad sin matices.
- El pin deja de ser superficie de atribución (era el agujero A de F1): un
  share id fijado que no esté en tu propia proyección no pinta nada. La
  falsificación pierde el premio en vez de ganarse una validación.
- `savedLists` es privado: guardar no notifica, no cuenta y no expone al que
  guarda. El análisis del contador rechazado queda escrito aquí.
- Presupuesto de expresiones: esta fase **libera** (fuera el desenrollado con
  `get()` de los pines); mediciones obligatorias en rules v1 (convivencia) y
  v2 (estado final), con el método de `p17-measure` y `allowed` como única
  señal.

---

## Estado de implementación (2026-08-21)

**P22 y P23 (rules v1 + Worker + app) implementadas. Rules v2 NO: es un paso
posterior al despliegue y a la migración de producción. Nada desplegado, nada
commiteado.**

### Qué entró

| Pieza | Archivo |
| --- | --- |
| Rules v1: `profileLists/` (get condicionado por `get()` del perfil, `write: false`), `validPinnedShareIds` (≤3, sin `get()`), claves `onProfile`/`updatedAt`/`publicSyncedAt` en `lists/` | `firestore.rules` |
| Worker: proyección mantenida en el MISMO commit de publish/update/unpublish, `POST /lists/attribute`, merge por `paperIds` en update, tope de 30 (`PROFILE_LISTS_FULL`), sellos `onProfile`+`publicSyncedAt`, atribución por defecto con escape `attributed: false` | `worker/public-list-api.js` |
| `attributePublicList()` | `src/services/publicListService.js` |
| `sanitizePinnedShareIds`, `savePinnedShareIds`, `readProfileLists`, `mergeShowcaseCards`, `needsLegacyPinMigration`, `migrateLegacyPins`, `migrateHiddenPins`; `onProfile` en `readPinnableLists`/`readOwnLists` | `src/services/userProfileService.js` |
| Pestaña Listas del visitante: escaparate ∪ tarjetas legacy, pines primero, cache de sesión (`showcaseCache`), estado vacío que espera la respuesta | `src/components/Public/PublicProfilePage.jsx` |
| Editor: migración automática de pines visibles al cargar, banner de decisión para pines ocultos (stash F8), interruptor "En mi perfil" por lista + Fijar (≤3), fuera el switch `showPinnedLists` y el banner de pines rancios | `src/components/Profile/ProfilePage.jsx` (+`.css`) |

### Verificado

- **`npm run check` completo en verde**: secretos, lint, **800 unitarios**
  (65 nuevos: 11 Worker F12, migración, merge, atribución), build, dry-run
  del Worker.
- **154 tests de emulador** (11 nuevos de F12), incluida la medición de
  convivencia: **6 tarjetas legacy + 3 ids en una sola escritura PASAN** — la
  ventana de migración no rompe a nadie en el tope.
- **Pasada de mutación: 11 mutantes, 10 muertos.** El superviviente
  (`is string` en `validPinnedShareIds`) es redundante demostrado —
  `.matches()` sobre no-string revienta y deniega — y queda anotado en las
  rules, el precedente de `validFollowEdge`.
- **Los cuatro arreglos de P16 presentes** en el archivo final
  (`searchIndexCoherentAfter`, `isAdmin()` en el delete de `userSearch`,
  allowlist sin `createdAt`, público explícito).
- **Producción leída por REST sin auth**: @mugar 1 pin (flag true),
  @nick_mugar 1 pin (sin flag). Nadie por encima de 3; la migración real es
  un caso por cuenta.
- Un test SOURCE se invirtió a propósito: el editor ya no puede tocar los
  caminos de escritura de tarjetas (`togglePinnedList`/`savePinnedLists`);
  escribe ids y aloja la migración.

### Decisiones tomadas al implementar

- **El indicador del estado sucio de sync** (`publicSyncedAt` en la lista
  privada) lo sella ya el Worker desde P22, aunque el motor de sync es P25:
  así P25 nace con historia en vez de estrenar el campo.
- **El editor (`/settings/profile`) aloja el interruptor por lista y el pin**;
  `ListsPage` no se toca (la fase del modal la tiene en curso). Consecuencia
  transitoria asumida: publicar desde Mis listas atribuye por defecto sin que
  ESA pantalla lo diga aún — la copy ("se verá en tu perfil") y el interruptor
  en la propia fila de publicar son una edición pequeña de `ListsPage`
  pendiente de que aterrice la fase del modal. El control existe mientras
  tanto en el editor de perfil.
- **La migración corre en el editor de perfil**, no en la página pública: es
  la pantalla del dueño, ya lee perfil y listas publicadas, y el prompt del
  stash necesita UI de decisión que ya tiene estilo ahí.
- El render del visitante consulta la cache de sesión **en render** (no
  setState en efecto) — la regla nueva de lint de hooks lo exige y el patrón
  queda mejor: pinta lo cacheado y revalida detrás.

### Qué falta para cerrar F12 (por orden)

1. **Desplegar rules v1** (`firebase deploy --only firestore:rules`) — desde
   este working tree, que contiene los cuatro arreglos de P16.
2. **Desplegar el Worker** (`npm run worker:deploy`).
3. **Desplegar la app** (push a `main`).
4. **Pasada con sesión** (humana): migración de los dos perfiles reales
   (1 pin cada uno; @nick_mugar sin flag → automática; comprobar el escaparate
   del visitante y el interruptor por lista).
5. **Rules v2**: retirar `validPinnedLists`/`ownsPinnedShare`/`pinnedLists`
   del perfil y la forma del stash; retirar `refreshPinnedCard` del Worker;
   re-medición y mutación. Fase corta, tras confirmar la migración.
6. **P24** (guardar listas de otros) cuando aterrice la fase del modal; **P25**
   (sync al editar) cuando se quiera — el Worker ya tiene el merge y el sello.
