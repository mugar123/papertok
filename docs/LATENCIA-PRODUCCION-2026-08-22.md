# Latencia de PaperTok medida en producción — 2026-08-22

**Qué es esto.** Medición contra `https://mugar123.github.io/papertok` (build
desplegado a las 00:17 UTC de hoy ≈ commit `2b051d1`) para cerrar el agujero del
diagnóstico previo: números de producción en los que se pueda confiar, con
mediana y rango, no muestras sueltas. No se ha tocado código de producto.

**Cómo se midió.** Arnés de iframe del mismo origen dentro de una página
estática aparcada: el observador de DOM se instala *antes* de que llegue el
contenido, así que «primer paper» es el instante real en que el nodo aparece,
no una lectura tardía. Waterfall por Resource Timing, pintado por
paint/LCP con observadores buffered, bloqueo de main thread por Long Tasks API,
toque por Event Timing API con input real (CDP). Cache-buster solo en el
documento: los assets van con hash y quedan cacheados, así que **estos números
son de revisita**; el coste de primera visita (bundle) se midió aparte. El
estado visitante se produjo respaldando y restaurando el registro de sesión de
IndexedDB (restauración verificada: la sesión quedó intacta al terminar).

**Validez del entorno.** El panel de navegador de la sesión corre capado a
~42 fps (mediana de frame 23,2 ms *en un iframe en blanco*), así que los fps
absolutos no son comparables con un dispositivo real. Lo transferible son los
**milisegundos de bloqueo** (longtasks) y los frames muy por encima del techo.
`visibilityState` se comprobó en cada corrida (una captura despierta el
compositor; oculto, rAF da 0 fps y cualquier métrica de pintado es basura).

---

## 1. Los números

### Tiempo a primer paper utilizable (ruta `/`, revisita, RTT ~40–60 ms)

| Escenario | Mediana | Rango | N |
|---|---|---|---|
| **Logueado, revisita <15 min** (snapshot de feed en localStorage) | **464 ms** | 428–667 | 4 |
| …pero el refresh **reemplaza el contenido** que ya estás leyendo | 1 642 ms | 967–8 644 | 4 |
| **Logueado, sin snapshot** (>15 min fuera o dispositivo nuevo)* | 1 728 ms | — | 1 |
| **Visitante** (nunca hay snapshot) | **2 205 ms** | 1 588–2 700 | 3 |
| Peor caso estructural (borde del Worker frío + presupuestos) | est. 6,5–9,5 s | observado 8,6 s | ver §1.3 |

\* Una segunda corrida de este escenario se descartó por contaminación del
arnés (el parche de `fetch` alteró la carga); con una sola muestra válida, el
1 728 ms es indicativo, no mediana. Además sus fuentes acertaron caché HTTP:
es el **suelo** del escenario, no el caso típico.

Primer contenido (esqueleto): FCP 84–728 ms en todos los escenarios. El
esqueleto llega rápido siempre; lo que tarda es el paper.

### La cascada: qué espera a qué (logueado, sin snapshot)

```
0 ms      accounts:lookup (gate de auth)     187–442 ms, mediana 222 (N=10)
          └─ TODO espera: la primera petición a Firestore sale ~20 ms
             después de que termine el lookup, nunca antes
~250 ms   Firestore listens (prefs, perfil)  ~300–700 ms
~550 ms   FUENTES en paralelo, settleWithin(5 000)
          └─ espera al más lento o quema el presupuesto entero
+0–300    ENRIQUECIDO OpenAlex, waitForInitialEnrichment(4 500)
          └─ solo arranca cuando las fuentes asientan (medido: serie, no solape)
+250–1350 un único setPapers → montaje + animación → paper visible
```

La serie fuentes→enriquecido está tanto en `useGuestFeed.js:87-100` como en el
camino logueado, y se observó en vivo: en la corrida 1 las fuentes asentaron a
los 6 540 ms (presupuesto quemado) y el enriquecido arrancó a los 6 574 ms.

### Los dos cuellos dentro de la fase de fuentes

- **OpenReview quema el presupuesto entero cuando el borde está frío**: 5 213,
  5 324 y 5 165 ms en tres observaciones (el cliente corta a 5 000). Con caché
  de borde: 149–276 ms. El Worker cachea 30 min, de ahí que el síntoma vaya y
  venga. Sigue siendo cierto que pierde siempre en frío.
- **La cadena PubMed es serial e incacheable**: esearch → esummary → efetch,
  1 350 / 1 504 / 2 050 ms de cadena en las tres corridas de invitado. Es el
  cuello *constante* del visitante: las demás fuentes cachean bien y PubMed no,
  así que marca el suelo de ~1,6–2,7 s.

### El reemplazo de contenido en revisitas (no estaba en el diagnóstico previo)

Con sesión y snapshot (<15 min), el feed pinta papers reales a los ~460 ms…
y luego `loadPapers(refresh)` los **pisa con contenido distinto** cuando
fuentes+enriquecido terminan: a los 967/1 642/1 724 ms con borde caliente, a
los **8 644 ms** en la corrida con OpenReview frío. El usuario ya está leyendo
un paper y el título cambia debajo. Encaja con la hipótesis del diagnóstico de
aspereza («la animación termina sobre un esqueleto y el contenido aparece
después de golpe») — es peor: no aparece, *cambia*.

Además, la carga logueada dispara **oleadas duplicadas de fuentes**: 1, 3 y 4
oleadas de `/sources/openreview` en tres corridas (las repetidas aciertan caché
HTTP, pero una carga logueada mueve 29–41 peticiones frente a 17–18 la de
invitado).

### El coste del gate de auth

- `identitytoolkit/accounts:lookup`: **mediana 222 ms, rango 187–442, N=10**.
  Siempre es la primera petición; Firestore y Worker esperan su fin.
- Perfil público `#/public/user/mugar`: h1 a **211–259 ms sin sesión** frente a
  **647–660 ms con sesión** (N=2+2): estar logueado lo hace ~2,7× más lento en
  una ruta que no necesita identidad. (El diagnóstico previo decía «duplica»;
  hoy es algo peor en esta ruta, aunque en absolutos desktop siga siendo
  sub-segundo.)

### El feed parásito, acotado

- **Con sesión: confirmado.** `/public/user/mugar` dispara `/arxiv`,
  `/sources/openreview` y 5 llamadas `openalex/works` que la ruta no usa
  (N=2). No bloquea el contenido del perfil (pinta antes), pero es red y CPU
  parásitas en cada ruta.
- **Sin sesión: ya no ocurre.** Cero peticiones de feed en la misma ruta
  (N=2). El disparador exige ahora firma de preferencias y
  `recommendationProfileReady` (`FeedContext.jsx:1302-1312`; el ref nace null
  en `:1276`) — sin usuario no hay firma. El diagnóstico previo se midió con
  sesión, así que o siempre estuvo acotado a logueados o se estrechó después.

### Fluidez de interacción (nunca medida hasta ahora)

- **Scroll entre papers** (snap `y mandatory`): cada transición de tarjeta
  produce **un longtask de 58–151 ms** (4 longtasks en 6 transiciones: 58, 65,
  91, 151 ms) y frames de hasta 118–152 ms. Es el enganchón que se nota al
  pasar de paper.
- **Toque** (abrir hoja de comentarios, N=2): retardo de entrada 1–4 ms (el
  main thread está libre), el handler del click cuesta **114 ms** (montaje
  síncrono de la hoja), y el feedback visual completo llega a **256–296 ms**
  del toque — dominado por la animación de entrada (~250 ms) encima del
  montaje. La hoja está en DOM a los 123–153 ms.
- **En reposo**: sin jank atribuible a la app (mediana de frame = techo del
  entorno, igual que un iframe en blanco).
- **En carga**: los longtasks de arranque suman 0,9–1,3 s en página completa
  (parse/compile del bundle único; 0,55–1,15 s con code cache).

### Primera visita (medido con curl, fuera del navegador)

- JS: **622 736 B gzip / 1 999 755 B crudos** (creció desde los 616 KB del
  perfil previo). CSS: 57 696 B gzip / 316 376 B crudos.
- Sigue **sin Brotli** (se pidió `br`, respondió gzip) y con
  `cache-control: max-age=600` en todo. Sin code splitting: un solo chunk
  (`index-DhxjVqoB.js`), 37 imports estáticos en `App.jsx`, cero
  `lazy`/`Suspense`, katex CSS global en `main.jsx:6`.
- Descarga del bundle: 0,28–0,60 s en esta conexión; en móvil 3G/4G la primera
  visita paga descarga + parse antes de cualquier esqueleto.

---

## 2. Contra el diagnóstico previo (2026-08-21, build 33ccbdb)

**Confirmado:**
- El gate de auth bloquea la primera lectura; medido de nuevo: 187–442 ms,
  siempre delante de todo.
- Presupuestos en serie (5 000 → 4 500 → un `setPapers`): intactos en código
  (`FeedContext.jsx:71,74`; `useGuestFeed.js:25`) y observados en vivo.
- OpenReview pierde su presupuesto en frío (3 observaciones de 5,2–5,3 s).
- `fetchJsonUpstream` sigue sin `AbortController` — ahora en
  `worker/report-api.js:719`.
- Bundle único sin splitting; GH Pages sin Brotli, max-age 600.
- Las dos asperezas del CSS global siguen: `scroll-behavior: smooth` en
  `global.css:17` (activo en vivo, verificado por computed style) y
  `transition: all` en `:110`.
- Firestore sano: listens de 40–200 ms típicos; el perfil público completa sus
  8 lecturas en ~0,6–0,7 s sin sesión.

**Corregido:**
- «Estar logueado duplica el tiempo a contenido»: en perfil público hoy es
  **~2,7×** (647–660 frente a 211–259 ms). Y en el feed la comparación cambió
  de naturaleza por el snapshot: el logueado en revisita es *más rápido* que el
  invitado (0,46 s frente a 2,2 s) — su coste ya no es esperar, es el
  **reemplazo** posterior.
- «`loadPapers` arranca en cada carga en frío sea cual sea la ruta»: **solo con
  sesión**. Sin sesión ya no ocurre (el trigger exige firma de preferencias y
  perfil de recomendación listos). Las referencias de línea se movieron:
  `FeedContext.jsx:1302` → `:1276`.
- «Solo OpenAlex y OpenCitations van acotados» en el Worker: el handler de
  arXiv ahora también aborta a los 5 s (`4a29adb`, ayer). Los diez
  `/sources/*` vía `fetchJsonUpstream` siguen sin plazo.

**Ya no aplica / matizado:**
- El «peor caso 9,5 s de esqueleto» sigue siendo la cota estructural, pero para
  el usuario logueado que revisita se manifiesta como reemplazo a los 8,6 s, no
  como esqueleto. El esqueleto largo queda para invitados y arranques sin
  snapshot.

**Nuevo (no estaba en el diagnóstico):**
- Snapshot de feed en localStorage (TTL 15 min, `FeedContext.jsx:86-134`) y su
  contrapartida: contenido pisado bajo el usuario.
- Oleadas duplicadas de fuentes por carga logueada (hasta 4).
- La cadena PubMed serial e incacheable como cuello constante del invitado.
- Los números de interacción (stalls por snap, coste del toque).

---

## 3. Problemas ordenados por tiempo real que cuestan

1. **La serie fuentes→enriquecido con OpenReview frío** — hasta 8,6 s
   observados (9,5 s de cota) para ver un paper. Lo paga el invitado, el
   logueado sin snapshot y, como reemplazo, toda revisita. Componentes: el
   presupuesto de 5 s que OpenReview quema entero en frío + los 4,5 s de
   enriquecido que solo arrancan después.
2. **El reemplazo de contenido en revisitas logueadas** — papers legibles a
   0,46 s pisados a 1–8,6 s. En tiempo «robado» es menor que el punto 1, pero
   es la aspereza más visible: pasa en cada revisita.
3. **La cadena PubMed (1,35–2,05 s, serial, sin caché)** — fija el suelo del
   visitante (~2,2 s de mediana) incluso con todo lo demás cacheado.
4. **El gate de auth (222 ms de mediana) + listens antes de contenido** — con
   sesión, ~0,4–0,5 s delante de cualquier ruta, incluidas las públicas que no
   necesitan identidad (perfil: 2,7× más lento logueado).
5. **Red parásita con sesión** — feed completo (2–7 peticiones + oleadas
   duplicadas) en rutas que no lo usan. No bloquea el primer contenido; cuesta
   red, CPU y contención.
6. **Interacción**: un stall de 58–151 ms en cada snap de tarjeta y ~0,3 s de
   feedback al toque (114 ms de montaje síncrono + animación de 250 ms).
7. **Primera visita**: 622,7 KB gzip / 2,0 MB de JS en un chunk único con
   0,9–1,3 s de parse en desktop — en móvil será el coste dominante de la
   primera carga, y crece con cada feature (+58 % de ficheros en agosto).

---

## 4. Lo que no se pudo medir (y por qué)

- **Dispositivo nuevo totalmente frío** (sin caché HTTP ni code cache): el
  intento de forzarlo parcheando `fetch` contaminó la corrida y se descartó.
  El peor caso queda **estimado por componentes medidos** (gate 0,2–0,4 +
  listens 0,3–0,7 + fuentes hasta 5,0 + enriquecido hasta 4,5 + render
  0,25–1,35), no medido de punta a punta.
- **Móvil o red lenta**: todo es desktop con RTT ~40–60 ms. Los tiempos de
  red escalan con RTT; los longtasks escalarán con CPU móvil (a peor).
- **fps absolutos**: el entorno está capado a ~42 fps; solo son transferibles
  los longtasks y los frames >>techo.
- **El hueco de ~5–6 s al cambiar a la pestaña Research**: el contenido
  anterior se vació ~6 s después del click y la vista nueva cargó con un burst
  de ~3–4 s; el intervalo click→vaciado no quedó bien instrumentado y la vista
  Research no usa el marcador de tarjeta con el que medía. Pendiente.
- **Las 3 oleadas de la hoja de comentarios**: no re-verificadas (la base
  sigue casi vacía; la hoja abre en ~0,3 s y eso sí está medido).
- **Escenario «recién logueado en dispositivo nuevo»** (caché IDB de Firestore
  vacía): no se limpió esa caché para no arriesgar el estado de la sesión.

**Contaminaciones declaradas:** la corrida if9 (parche de fetch) se descartó
entera. Las corridas 2–3 del método inicial (dos llamadas separadas) tienen
pintado incompleto por llegar tarde el observador; solo se usan sus waterfalls.
La caché de borde del Worker (30 min) hace que las corridas consecutivas no
sean independientes para OpenReview: el rango 149 ms–5,3 s refleja ese estado,
y está anotado por corrida.

---

## 5. Post-implementación — re-medido el mismo día (build `cc29bdc`)

Los cinco commits `0e7a2dc..cc29bdc` atacan los puntos 1, 2, 3, 5, 6 y 7 del
§3 (el gate de auth queda para otra ronda; el Worker no se toca porque no se
despliega desde CI). Mismo arnés, mismas condiciones (revisita, RTT bajo),
medido contra producción tras el deploy:

| Métrica | Antes (`2b051d1`) | Después (`cc29bdc`) |
|---|---|---|
| JS de arranque | 622,7 KB gzip / 2,0 MB crudos, 1 fichero | **346,3 KB gzip** / 1,09 MB, 17 ficheros (−44 %) |
| CSS crítico | 57,7 KB gzip | **14,1 KB** (−76 %) |
| Longtasks de arranque (frío) | 0,9–1,3 s | **0,26 s** |
| Visitante, primer paper (revisita) | 1 588–2 700 ms, mediana 2 205 | **266–270 ms** (−88 %) |
| Visitante, primer paper (caché PubMed fría) | 2 700 ms (corrida comparable) | **1 689 ms** (−37 %) |
| Logueado revisita, primer paper | 428–667 ms… y **pisado** a 1–8,6 s | 615–755 ms y **cero reemplazos** |
| Oleadas de fuentes por carga logueada | 1–4 (29–41 peticiones) | **1** |
| Perfil público con sesión | 647–660 ms + 2–7 peticiones de feed parásitas | **507–818 ms + 0 parásitas** |
| Snap de tarjeta (3 transiciones) | 3–4 longtasks de 58–151 ms, frames hasta 152 ms | **0 longtasks, frame máx 24 ms** |
| Toque (abrir comentarios) | handler 114 ms, pintado a 256–296 ms | **handler 24 ms, pintado a 56–64 ms** |
| Peor caso estructural del esqueleto | 5 000 + 4 500 + render ≈ 9,5 s+ | 4 000 + 900 + render ≈ **5,2–6,2 s** |
| `/sources/*` del Worker | diez endpoints **sin plazo** (§2) | **6 000 ms** de plazo (`b295e6f`, desplegado a mano) |

**Sobre el Worker** (`b295e6f`, versión `1f2afe00`): las líneas de §1 y §2 que
dicen que `fetchJsonUpstream` no tiene `AbortController` describen el estado
del diagnóstico y se dejan como estaban; desde este despliegue ya no es cierto.
El plazo son 6 s a propósito, por encima del presupuesto de 4 s del cliente:
el upstream lento (OpenReview, 5,2 s en frío) llega a completar y deja la
respuesta en la caché de borde para el siguiente lector, aunque quien la
disparó ya se haya rendido. Verificado tras desplegar: 9/9 peticiones con
cache-buster a `openreview`, `biorxiv` y `europepmc` responden 200, con el
upstream real más lento en 2,79 s. Ojo: el Worker **no se despliega desde CI**
— un `git push` no lo actualiza, hace falta `npm run worker:deploy`.

### 5.1 Los flecos declarados, cerrados o desmentidos (misma noche)

**El chunk «createLucideIcon» no es de iconos.** Atribución por sourcemap
(decodificando los mappings, no a ojo): de sus 334 KB crudos, **190,8 KB son
Firestore y 134 KB el resto de Firebase**; Lucide aporta 1,6 KB — la factoría
`createLucideIcon`, que es lo único que da nombre al chunk. Los 77 iconos
usados pesan **14,4 KB crudos en total** (~190 bytes/icono, en el chunk de
entrada): el tree-shaking poda perfectamente y ahí no hay bocado. El chunk de
entrada real es: app 219 KB + react-dom 178 KB + framer-motion 122 KB. El
siguiente candidato con sustancia sería **diferir Firestore para visitantes**
(~190 KB crudos que un invitado no usa), pero es cirugía en
`services/firebase.js` y sus importadores, no un cambio mecánico.

**El `fallback={null}` de las rutas ya no es una pantalla en blanco.** Las
rutas diferidas muestran ahora `RouteFallback`: fondo `--bg-primary` con un
indicador que **no aparece hasta los 320 ms** (la misma política de
placeholders retrasados del resto de la app), así que en escritorio con caché
caliente sigue sin verse nada y en móvil lento hay fondo e indicador en vez de
blanco. Verificado en vivo: el nodo se inserta al suspender, con
`animation-delay: 0.32s` computado, y se retira al llegar el chunk.

**Primera visita, medida a nivel de red** (lo que el arnés de revisitas no
cubría): bajar el set de arranque completo (18 ficheros, ~360 KB gzip /
1,15 MB crudos) saltándose la caché HTTP cuesta **194–924 ms (mediana
342 ms)** en esta conexión. Para móvil sigue siendo un **modelo**, no una
medición: a 4G típica (~9 Mbps) la transferencia sale a ~0,32 s frente a
~0,62 s del bundle antiguo (~680 KB gzip); a 3G rápida (~1,6 Mbps), ~1,8 s
frente a ~3,4 s. El parse escala igual con los crudos: 1,15 MB frente a
2,3 MB. Sin medir de verdad: CPU móvil real y RTTs de radio. La app en
emulación móvil (375×812, táctil, UA Android) renderiza el feed completo sin
desbordes horizontales.

Notas honestas: (1) el primer paper de la revisita logueada queda ~100 ms por
encima del valor previo — 17 ficheros cacheados frente a uno — a cambio de que
nada pise el contenido; (2) la corrida logueada sin snapshot dio 2 824 ms pero
pagó la primera descarga de todos los chunks del deploy nuevo, no comparable
con los 1 728 ms previos de caché caliente; (3) el jank de snap desapareció con
el `scroll-behavior: smooth` global fuera y el arranque más ligero — no se
aisló cuál de los dos pesa más; (4) los fps absolutos del entorno variaron
entre días (42→60), así que la señal válida sigue siendo longtasks y máximos,
no medianas de frame; (5) sin medir en esta pasada: móvil, primera visita
totalmente fría de extremo a extremo, y el gate de auth (intacto por diseño).
