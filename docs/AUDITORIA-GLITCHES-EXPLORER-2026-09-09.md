# Auditoría de tres glitches del Explorer (2026-09-09)

Tres quejas, con sus palabras: «al entrar a un autor desde la página de
institución hay varios glitches visuales»; «la píldora de ORCID, cuando se
carga, se recoloca en otro lugar: quiero que se cargue en su lugar final»; y «un
glitch visual con la animación de cómo carga el fondo con blur de la página de
institución».

Es la especificación del plan
`docs/superpowers/plans/2026-09-09-explorer-glitches-institucion-autor.md`.
Continúa `docs/AUDITORIA-ANIMACIONES-AUTOR-2026-09-07.md`, que cerró el
remontaje del árbol y la banda de la barra; nada de aquello se repite aquí.

## Cómo se midió

Build de producción de `aea5a59` (`npm run build`, `vite preview --port 5174`),
Chrome headless por CDP con el **perfil con sesión real**
(`PROFILE_DIR=~/.papertok-probe-profile`, tema oscuro), 1280×900, sin
estrangular la CPU. La sonda es nueva:
`scripts/diagnostics/explorer-glitch-frames.mjs`. Muestrea por
`requestAnimationFrame` **cada página bajo `#main-content`** (durante una
navegación hay dos) y graba a la vez un `Page.screencast`, con el mismo reloj en
los dos lados, así que un fotograma PNG y una línea del muestreador con el mismo
número son el mismo instante. Además del héroe, su settle y las piezas que ya
seguía `explorer-hero-frames.mjs`, registra tres cosas que ninguna sonda anterior
miraba: **la caja** del velo (`.ehc-bg-blur`), no solo su opacidad; la caja de la
nota de impacto con el texto de su línea de detalle; y la caja de la barra
lateral del héroe (`.ehc-hero-aside`) y de su rejilla.

Antes de la build hubo una ronda contra `vite dev` como visitante, sobre
`4111ad7`, que sirvió para encontrar los mecanismos y que dejó una lección
propia (§4). Los números de este documento son los de producción con sesión
salvo donde se dice lo contrario.

Corridas que produjeron números:

| # | Caso | Qué contestó |
|---|---|---|
| P1 | `chain`: Harvard → pestaña Autores → Walter C. Willett, caliente | La transición, y la píldora **sin** desplazamiento cuando la nota viene de caché |
| P2 | `route`: David Moher (`A5068353058`), frío | Los tres settles del autor y el salto de 10,3 px de la tarjeta ORCID |
| P3 | `route`: Harvard (`I136199984`), frío | El velo llegando durante el despliegue: caja de 374 → 576 px |
| D1–D4 | `vite dev`, visitante, `4111ad7` | El mecanismo de la píldora con el ORCID llegando antes que la nota; el bloqueo del clic que sólo existe en dev |

## 1. La píldora de ORCID no nace en su sitio: la nota de impacto crece debajo de ella

**Qué se ve.** La tarjeta «Verified ORCID profile» aparece y, un instante
después, baja 10 px. Según qué llegue antes, lo que baja es la tarjeta viva o
su esqueleto; el mecanismo es el mismo.

**Mecanismo, medido.** `RecentImpactStat` pinta «Calculating…» mientras
`getEntityRecentImpact` responde, y la nota asentada lleva dos líneas de
detalle («Very high · 2023–2026») donde el estado de espera lleva una. La celda
pasa de **124 × 64,5 px a 131,5 × 77,5 px**; la rejilla `.ehc-stats-grid` (dos
columnas `minmax(94px, 1fr)` bajo un `max-width: 264px`, sin `width`, así que
mide a contenido) pasa de **249 a 264 px de ancho y de 112,9 a 125,9 de alto**;
`.ehc-hero-aside` con ella. `.ehc-header` es `flex-wrap`, así que la columna
principal se estrecha (el `h1` pasa de 771 a 756 px) y la cabecera crece
**10,3 px**. Todo lo que hay debajo de la cabecera — el panel de experiencia, la
tarjeta ORCID, su píldora — baja esos 10,3 px **en un fotograma**: el settle
del cuerpo del héroe anima el borde inferior de la caja, no la posición de sus
hijos.

Autor frío en producción con sesión (P2, `A5068353058`):

| t | Qué llega | Celda de impacto | Rejilla | Tarjeta ORCID (esqueleto) |
|---|---|---|---|---|
| 344 ms | esqueleto | — | 189 × 101 en x = 963 | — |
| 1306 ms | héroe vivo | «Calculating…» 124 × 64,5 | 249 × 112,9 en x = 903 | y = 267,6 |
| 1790 ms (+484) | nota de impacto | «Very high · 2023–2026» 131,5 × 77,5 | 264 × 125,9 en x = 888 | **y = 277,9 (+10,3, en un fotograma)** |
| 3123 ms (+1333) | registro ORCID | igual | igual | tarjeta viva en y = 430,3; píldora en 456,3 |

Con la nota de impacto **después** del ORCID lo que salta es la píldora viva.
Medido en dev como visitante (D1, Willett desde Harvard): el registro llegó en
t = 1627 con la píldora en y = 383,9 (base, sin su rise de 6 px) y la nota 74 ms
después la dejó en **394,3**. El orden entre las dos respuestas depende de
OpenAlex y de si la nota está en la caché de Firestore: la auditoría del 07-09
midió que con sesión y perfil caliente «se funde con el primer settle»; en la
primera visita a un autor no, y P2 lo confirma (+484 ms).

Además, ese mismo crecimiento es el **settle intermedio** del autor frío:
`227,6 → 237,9 px` en P2, uno de tres. Reservado el tamaño final de la celda, ese
settle desaparece y quedan dos.

**Segundo hallazgo de la misma medida.** La rejilla del esqueleto mide
**189 × 101 px en x = 963** y la viva **264 × 125,9 en x = 888**: durante el
fundido esqueleto → héroe (420 ms) hay dos rejillas superpuestas 75 px
desplazadas en horizontal, y la del esqueleto no reserva la línea de detalle de
la celda de impacto. Es una de las «varias» cosas que se ven al entrar desde la
institución (§3).

**Fichero.** `src/components/Explorer/EntityExplorer.css:632-640` (`.ehc-stats-grid`),
`:701-705` (`.ehc-stat-detail`), `:1158-1159` (celdas del esqueleto);
`src/components/Explorer/RecentImpactStat.jsx:82-84` (el detalle);
`src/components/Explorer/EntityExplorer.jsx:1431-1438` (rejilla del esqueleto).

**Corrección.** Reservar el tamaño final: `width: 264px` en la rejilla (con
`max-width: 100%` para el ancho estrecho, donde ya se anula) y `min-height` de
dos líneas en `.ehc-stat-detail`, para que «Calculating…» ocupe la caja que
«Very high · 2023–2026» va a ocupar; y darle al esqueleto la misma rejilla (264
de ancho y la línea de detalle en la cuarta celda) para que el fundido no
superponga dos rejillas. Es el patrón de
`docs/superpowers/plans/…` anteriores: reservar la caja, no medir antes de pintar.

## 2. El velo con blur de la institución hace zoom mientras se funde

**Qué se ve.** La foto desenfocada del fondo aparece «respirando»: mientras se
funde hacia su 10 % de opacidad, la imagen cambia de escala y de posición.

**Mecanismo, medido.** `.ehc-bg-blur` es `position: absolute; top: -20%;
bottom: 0` dentro de `.explorer-hero`, con `background-size: cover` y
`filter: blur(48px)`. Su caja mide el 120 % de la altura del héroe, y el héroe
está creciendo justo cuando el velo monta: el velo llega cuando la miniatura de
Wikipedia termina de cargar, y eso ocurre en el mismo tramo en que el bloque de
Wikipedia se despliega (`aea5a59`: 320 ms, 0 → 155,4 px) y, en frío, la banda de
la barra se abre (240 ms).

Institución fría en producción con sesión (P3, Harvard):

| t | Héroe | Caja del velo | Opacidad del velo | Despliegue de Wikipedia |
|---|---|---|---|---|
| 834 ms | 309,8 px | (no montado) | — | 0 px |
| 849 ms | 312,8 | **374,1 px de alto, top −8,8** | 0,00 | 2,7 |
| 900 ms | 361,7 | 432,8, top −16,1 | 0,08 | 47 |
| 965 ms | 417,2 | 499,4, top −27,2 | 0,10 | 97,3 |
| 1116 ms | 481,2 | **576,3, top −40** | 0,10 | 155,4 |

El velo pasa por **21 alturas distintas** entre 374 y 576 px (**+54 %**) y su
fundido completo de 280 ms cae entero dentro de ese crecimiento. Con `cover`, la
escala de la imagen sigue a la caja: la foto hace zoom y se desplaza mientras
aparece. Y un `blur(48px)` sobre una capa de 1536 px de ancho se vuelve a
rasterizar en cada uno de esos 21 fotogramas — el pintado más caro de la base de
código (`EntityExplorer.css:2402-2406` lo dice para el móvil, donde ya está
apagado) corriendo veintiuna veces seguidas.

En la ronda dev sobre `4111ad7` (D3), antes del despliegue de Wikipedia, el velo
montaba al final del settle y su caja apenas cambiaba (583 → 576). Es
`aea5a59`/`3b96b3a` lo que puso el despliegue y la carga de la foto en el mismo
tramo; el acoplamiento de la caja al héroe existía desde siempre.

**Fichero.** `src/components/Explorer/EntityExplorer.css:134-155`;
`src/components/Explorer/EntityExplorer.jsx:1543-1572` (el `motion.div` con el
`backgroundImage` en línea).

**Corrección.** Desacoplar la imagen de la altura del héroe: el elemento sigue
siendo el contenedor con la máscara (`top: 0; bottom: 0`, para que el degradado
siga cerrando en el borde del héroe), y la imagen desenfocada pasa a un `::before`
con caja fija (`top: -96px; height: 720px; left/right: -10%`), que es lo que
`-20%` medía sobre un héroe de 480 px. Con caja fija la escala no cambia y el
blur se rasteriza una vez. La imagen viaja por una variable CSS
(`--ehc-wash-image`) en vez del `backgroundImage` en línea, porque un
pseudo-elemento no lee estilos en línea.

## 3. Entrar a un autor desde la institución: lo que hay y lo que no

Con sesión y build de producción (P1) la transición es limpia: 90 ms de tarea al
clic (layout de las dos páginas), `hold` y `enter` de 300 ms sin fotogramas
vacíos, ninguna pausa del hilo principal (`gaps: []`) en las tres corridas. Lo
que se ve, en orden, y qué es cada cosa:

1. **0–300 ms: dos héroes superpuestos.** El esqueleto del autor llega al 24 px
   y opacidad creciente **sobre** el héroe de Harvard al 60 % y escala 0,98
   (fotograma `f005_00298ms`). Las dos páginas tienen la misma anatomía —
   icono, nombre, rejilla a la derecha, lista debajo — así que durante la
   superposición se leen como un solo héroe corrupto, no como una hoja
   posándose sobre otra. Es la transición v2 elegida el 06-09 y medida limpia
   entonces; **la diferencia es que ahí se midió feed → entidad**, dos
   anatomías distintas. No entra en el plan: es una decisión de producto, y la
   alternativa (que una página del Explorer saliente hacia otra del Explorer
   se funda más rápido, o que el héroe entrante sea opaco antes) se propone en
   §5 para que la decidas tú.
2. **1143 ms: fundido esqueleto → héroe** con las dos rejillas 75 px desplazadas
   (§1, segundo hallazgo). **Entra en el plan.**
3. **1306–1790 ms (autor frío): la tarjeta ORCID baja 10,3 px** (§1). **Entra
   en el plan.**
4. **1793–2160 ms: el registro ORCID llega y el settle lo revela por barrido.**
   El panel de experiencia monta a su altura y el cuerpo del héroe crece 152 px
   en 360 ms con `overflow: hidden`: «Harvard University / Professor» aparece
   **cortado por un borde recto que baja** (`f096_01813ms`), y la tarjeta ORCID
   aparece cuando el borde la alcanza. Es el «reveal the settle exists for»
   documentado en `EntityExplorer.css:147-152` y una decisión del 05-09. No
   entra en el plan como tarea; §5 deja la alternativa.

Lo que **no** hay en producción: el bloqueo de medio segundo al clic. En `vite
dev` sobre `4111ad7` el clic congelaba la pantalla **254 + 192 ms** (D1: 569 ms
en la primera corrida), y el perfil de CPU lo atribuye a `jsxDEV`
(`react_jsx-dev-runtime`, 1004 ms de tiempo propio en una corrida de 5,6 s) y
al layout de las dos páginas. En producción, 90 ms. Si lo has visto en el
móvil o en producción, no está reproducido aquí y habría que medirlo con
estrangulamiento.

## 4. Lecciones de medida

- **Medir el Explorer en `vite dev` inventa un defecto.** La creación de
  elementos con `jsxDEV` domina el perfil (1004 ms propios frente a 19 ms de
  `EntityExplorer.jsx`) y convierte cada llegada de datos en una pausa de
  100–700 ms que no existe en la build. Las pausas de P1–P3 fueron cero. Ya lo
  decía el README de las sondas para `open`; vale para todo lo que mueva.
- **El reloj del screencast y el del muestreador tienen que ser el mismo.**
  La primera versión de la sonda numeraba los PNG desde el primer fotograma y
  las muestras desde el primer script; casar «qué se veía» con «qué medía»
  era adivinar. Ahora los dos usan `Date.now()` y el nombre del fichero es el
  instante.
- **Un selector que casa el esqueleto hace clic en nada.** Con sesión la lista
  de autores tarda más y `.ee-author-card` casó una fila `ex-skel-row`: la
  corrida terminó «limpia» porque nunca navegó. `:not(.ex-skel-row)`, como ya
  hacía el README.
- **La caja, no solo la opacidad.** `explorer-hero-frames.mjs` seguía el velo
  por su opacidad y por eso el zoom era invisible: la opacidad hacía
  exactamente lo que debía.

## 5. Observado y no planificado

Dos cosas que se ven en la cadena institución → autor y que son decisiones ya
tomadas, no defectos; las dejo con su alternativa medida por si quieres
cambiarlas:

- **La superposición de dos héroes del Explorer** (§3.1). Alternativa: cuando la
  página que se va y la que llega son las dos `/explorer/…`, la retenida podría
  fundirse a 0,6 en los primeros 100 ms en vez de en 300, o el héroe entrante
  llevar `background: var(--bg-primary)` opaco desde el primer fotograma con
  sólo el `translateY` animado. Cualquiera de las dos rompe la regla «un
  reloj para las dos páginas» de `PageTransition.css`, así que es tu decisión.
- **El barrido del settle sobre el panel de experiencia** (§3.4). Alternativa:
  que el panel se despliegue solo, como ya hace el bloque de Wikipedia desde
  `aea5a59` (altura propia, `--ease-out-quad`, el settle en `suspended` por su
  propio cerrojo). Con eso la tarjeta ORCID ocupa el hueco de su esqueleto sin
  moverse, y ningún texto queda cortado. Tiene un coste: la tarjeta con
  biografía (Moher: 185 px frente a los 96 del esqueleto) crecería a saltos
  con el settle suspendido, salvo que también se despliegue sola. Es una
  tarea de tamaño medio y una decisión sobre el aspecto, no un arreglo.

## 6. Cómo repetir la medida

```bash
npm run build && npx vite preview --port 5174
# El perfil con sesión: README de scripts/diagnostics, «Measuring a page that
# only exists for a signed-in reader». Chrome cerrado antes de medir.
export PROFILE_DIR="$HOME/.papertok-probe-profile" ORIGIN=http://localhost:5174
node scripts/diagnostics/explorer-glitch-frames.mjs chain '#/explorer/institution/I136199984' '.ee-author-card:not(.ex-skel-row)' tab=authors wait=2500 7000 out=/tmp/chain profile
node scripts/diagnostics/explorer-glitch-frames.mjs route '#/explorer/author/A5068353058' 8000 out=/tmp/author
node scripts/diagnostics/explorer-glitch-frames.mjs route '#/explorer/institution/I136199984' 7000 out=/tmp/inst
```

Las corridas de §7 salen de la misma sonda con `idx=N`, que hace clic en el
enésimo autor de la pestaña en vez de en el primero:

```bash
# tercera ronda (10-09): Chris Sander frío, Rubin repetido, el velo otra vez
node scripts/diagnostics/explorer-glitch-frames.mjs chain '#/explorer/institution/I136199984' '.ee-author-card:not(.ex-skel-row)' tab=authors idx=7 wait=2500 12000 out=/tmp/pt-c-idx7
node scripts/diagnostics/explorer-glitch-frames.mjs chain '#/explorer/institution/I136199984' '.ee-author-card:not(.ex-skel-row)' tab=authors idx=4 wait=2500 12000 out=/tmp/pt-f-idx4
node scripts/diagnostics/explorer-glitch-frames.mjs route '#/explorer/institution/I136199984' 8000 out=/tmp/pt-a-inst
```

La sonda imprime a qué autor hizo clic (`clicked: …`), que es como se sabe qué
`idx` es quién; el orden de la pestaña ha sido estable entre las tres rondas.

Para un autor **frío** (la nota de impacto sin caché) hace falta uno que ese
perfil no haya visitado, o borrar `recentImpact` de la caché de sesión; Moher
lo era el 09-09, y de `idx=2` a `idx=7` están ya todos calientes en este
perfil. Un fotograma se recorta con `sips --cropToHeightWidth 700 1280
--cropOffset 0 0 f.png --out crop.png` para mirarlo sin el resto de la página.

## 7. Después (2026-09-10)

Mismas sondas, misma build de producción con sesión real, sobre `a5cd5c4`.
`idx=2` de la pestaña Autores de Harvard (Gad Getz) resultó ya estar en caché
en este perfil — su nota llegó asentada desde el primer fotograma capturado
(«Exceptional · 2023–2026» en `t=150ms`, sin «Calculating…» de por medio) — así
que la medida del autor frío se hizo con `idx=3`, **Ronald C. Kessler**, y se
corroboró con un segundo autor frío, `idx=4`, **Donald B. Rubin**; un tercero,
`idx=5` **Todd R. Golub**, se usó aparte para leer las cuatro celdas
individuales de la rejilla.

Una revisión posterior (misma fecha) rehizo tres de estas medidas con
corridas nuevas — mismo build, mismo HEAD (`35e2699`; sin cambios de código
fuente entre `a5cd5c4` y ese commit, sólo la propia sección 7) — porque las
citas originales no sostenían los números escritos: se incorporó un cuarto
autor frío, `idx=6` (**Frank B. Hu**), y Kessler y Rubin se repitieron con
una ventana de captura más larga (12 s en vez de 8 s) para dejar resolver del
todo el registro ORCID.

Una **tercera** ronda (también 10-09, sobre `e0fc3f9`, otra vez sin cambios de
código fuente respecto de `a5cd5c4`) volvió a medir porque los ficheros crudos
de las dos anteriores ya no estaban en `/tmp` y varias cifras citadas habían
dejado de poder releerse en ningún sitio. Entró un quinto autor frío, `idx=7`
(**Chris Sander**), se repitió Rubin con el mismo `idx=4`, y se corrió otra vez
la institución para el velo. Cada corrección de abajo dice qué cambió y por
qué.

| Medida | Antes | Después |
|---|---|---|
| Celda de impacto, «Calculating…» → asentada | 124×64,5 → 131,5×77,5 | 131,5×77,5 — una sola caja, idéntica en «Calculating…» y en la nota asentada (Kessler y Rubin) |
| Rejilla, héroe vivo | 249×112,9 → 264×125,9 | 264×125,9 — una sola caja, sin paso por 249×112,9 |
| Tarjeta ORCID (esqueleto) al asentarse la nota | y +10,3 px en un fotograma | sin cambio de y: 277,9 px antes y después de la nota, en los dos autores |
| Settles del autor frío | 3 | 0 en los dos autores fríos medidos — ver nota abajo |
| Rejilla del esqueleto frente a la viva | 189×101 en x=963 / 264×125,9 en x=888 | 264×131 en x=888 (esqueleto) / 264×125,9 en x=888 (viva) — el offset horizontal de 75 px desapareció; queda un residuo de 5,1 px de alto |
| Alturas distintas de la imagen del velo durante su fundido | 21 (374 → 576 px) | 1: caja fija (`top: -96px; height: 720px`) — confirmada con el héroe en 480,2 px en reposo y en 720,2 px con Wikipedia expandido |

El contenedor (`.ehc-bg-blur`, ahora la máscara) sigue midiendo tantas alturas
como el héroe tenga fotogramas — 21 en esta misma corrida, contenedor de
315,8 a 480,2 px — exactamente lo que Task 4 predijo («la sonda mide el
contenedor... lo que se comprueba es la imagen»); ese número no es el que
cambió, y la fila de arriba es sobre la imagen, no el contenedor.

Desde la tercera ronda esa distinción ya no hay que argumentarla: la sonda
graba el `::before` en su propio campo (`washImg`), así que contenedor e imagen
se leen de la misma línea. En la corrida de la institución del 10-09, `washImg`
vale `-96px/720px` en **todos** los fotogramas mientras el contenedor recorre
otras 21 alturas, esta vez de 314,8 a 480,2 px — un fotograma de arranque de
diferencia con los 315,8 de la ronda anterior, mismo número de alturas y mismo
final. Y `img=y`: el campo que hasta esa ronda interrogaba un
`background-image` en línea que este mismo cambio había borrado — y que por eso
habría dicho `n` para siempre — vuelve a informar de que la imagen está puesta.

**Las tres preguntas aplazadas de Tasks 3 y 4.**

1. *¿Qué ancho se midió?* 264 px, y constante entre esqueleto y estado vivo —
   pero no como se escribió la primera vez. La versión original nombraba a
   Kessler, Rubin y Golub, sin tener en realidad el ancho del *esqueleto* de
   ninguno de los tres: de Kessler y Rubin sólo se había leído el estado vivo
   (nunca su esqueleto), y la única lectura etiquetada «esqueleto» — la de
   Golub, por un script aparte — conflaba dos rejillas co-montadas (Harvard
   retenida + el esqueleto de Golub entrando) y había heredado el ancho de la
   rejilla equivocada. Re-medido con la sonda estándar, que registra cada
   `.ehc-stats-grid` dentro de su propia página bajo `#main-content` — así que
   la conflación no puede ocurrir —, sobre tres autores fríos (Kessler, Rubin
   y **Frank B. Hu**, `idx=3/4/6` de la pestaña Autores de Harvard): los tres
   entran con la misma caja de esqueleto, `264×131 en x=888`, estable en
   decenas de fotogramas consecutivos mientras la transición de ruta se
   asienta, y se convierte en `264×125,9 en el mismo x=888` al llegar el
   estado vivo — sin desplazamiento de `x` en ninguno de los tres. No se
   reprodujo el caso de ~259 px con la fila de cabecera apretada: ninguno de
   los tres nombres llena la fila lo bastante para que el `flex-shrink: 1` de
   `.ehc-stats-grid` entre en juego.
2. *Las cuatro alturas reales* (Golub, rejilla en reposo, nota asentada en
   «Exceptional · 2023–2026»): **47,5 / 47,5 / 77,5 / 77,5 px**. CSS Grid
   empareja la fila 1 (celdas 1 y 2) con la fila 2 (celdas 3 y 4) — no «las
   tres primeras iguales y la cuarta a 77–78» como preveía el plan; son dos
   pares, no tres-y-uno. Las cuatro cifras vienen del mismo script aparte que
   este punto acaba de descartar para el ancho, así que valen lo que valga esa
   fuente. Corroborado con la sonda estándar está el par de abajo — la celda de
   impacto viva mide `131,5×77,5` en Kessler, en Rubin y en Sander — y, por
   resta sobre la misma rejilla, el de arriba en 125,9 − 1 − 77,5 = 47,4; el
   emparejamiento en dos filas es lo que esas dos cifras sostienen (ver el
   último apartado de esta sección).
3. *¿Borde visible en el velo de la institución?* No. Con el bloque de
   Wikipedia expandido el héroe llegó a 720,2–721,2 px (el plan predecía
   ~721), y `getComputedStyle(.ehc-bg-blur, '::before')` dio exactamente lo
   mismo antes y después de expandir: `top: -96px; height: 720px`. Una
   captura de pantalla completa del héroe expandido no muestra ninguna
   costura: el velo se desvanece por completo dentro de los primeros ~150 px
   bajo la barra, muy antes de donde la caja de la imagen termina.

**Sobre las cero settles.** El body del héroe (`.explorer-hero-content`) midió
exactamente 237,9 px desde el primer fotograma con «Calculating…» hasta el
final de cada corrida, en Kessler y en Rubin — así que ninguna de las dos
transiciones que se esperaba que siguieran generando un settle lo generó:

```
p0 {"...","body":"20,136 1240x237.9","...","impact":"1020.5,184.5 131.5x77.5 \"Calculating…\"", ...}   # t=624 (Kessler)
p0 {"...","body":"20,136 1240x237.9","...","impact":"1020.5,184.5 131.5x77.5 \"Very high · 2023–2026\"", ...}   # t=1191 — misma caja
```

Esas dos líneas eliden justo los dos campos de los que cuelgan las filas de la
tabla: `stats`, que **es** la caja de la rejilla, y `settle`, que es la
afirmación entera de «cero settles». Y los ficheros crudos de aquella ronda
(`/tmp/v-kessler2.txt`, `/tmp/v-rubin2.txt`, `/tmp/v-chain3.txt`) ya no están
en disco, así que las elisiones no se pueden rellenar sin inventarlas. En vez
de suavizar las filas, **la medida se repitió** el 10-09: misma build de
`dist/`, mismo perfil con sesión, mismo `chain` desde Harvard, con un autor
frío que este perfil no había abierto — `idx=7`, **Chris Sander**, porque §7
ya había gastado de `idx=2` a `idx=6`. La geometría es determinista y
reprodujo exactamente, ahora con `stats` y `settle` sin elidir:

```
p0 {...,"skel":true,"body":"20,136 1240x131","settle":null,...,"stats":"888,136 264x131","impact":"1020.5,187 131.5x80 \"\"",...}                                  # t=478  — esqueleto
p0 {...,"skel":false,"body":"20,136 1240x237.9","settle":null,...,"stats":"888,136 264x125.9","impact":"1020.5,184.5 131.5x77.5 \"Calculating…\"",...}             # t=665  — héroe vivo, la nota calculándose
p0 {...,"skel":false,"body":"20,136 1240x237.9","settle":null,...,"stats":"888,136 264x125.9","impact":"1020.5,184.5 131.5x77.5 \"Exceptional · 2023–2026\"",...}   # t=1112 — la nota aterriza: misma caja
```

Con eso las filas que iban en prosa quedan leídas de una línea: la rejilla del
esqueleto es `264×131 en x=888` y la viva `264×125,9 en el mismo x=888`, sin
paso por `249×112,9`; la celda de impacto mide `131,5×77,5` con «Calculating…»
y con la nota asentada; `settle` es `null` en los tres fotogramas y el body no
se mueve de 237,9 px entre el segundo y el tercero. La tarjeta ORCID tampoco:
`"orcidSkel":"20,277.9 1240x96"` en `t=665` y en `t=1112`, los mismos 277,9 px
antes y después de la nota.

Una diferencia que conviene decir, porque el «0» de la tabla es de Kessler y
de Rubin: Sander **sí** produce un settle, pero el de la llegada del registro
ORCID — su tarjeta mide 231,3 px contra la reserva de 96
(`"orcidCard":"20,454.3 1240x231.3"` con `"settle":"237.938px>549.547px@0"` en
`t=1311`) —, que es exactamente el caso (b) de abajo con otro autor más. Las
dos transiciones de las que trata esta tarea, esqueleto→héroe y la llegada de
la nota, siguen sin generar ninguno.

(a) esqueleto→héroe no animó: el body saltó de 131 a 237,9 px en un único
fotograma sin keyframes intermedios (`t=457` esqueleto, `t=624` héroe vivo,
`settle` nulo en las dos), consistente con el `if (suspended || resync) return
{ action: 'none' }` de `useHeightSettle` cuando el commit cae dentro de la
ventana en la que la transición de ruta todavía se considera en marcha — un
mecanismo preexistente, no tocado por este plan.

(b) la llegada del registro ORCID tampoco animó para Kessler ni para Rubin —
pero la explicación original («la tarjeta viva midió exactamente 96 px») citaba
una línea cruda con `orcidCard:null`: en ese fotograma concreto la tarjeta
todavía no había llegado, así que esa línea no medía lo que decía medir.
Repetida la corrida con una ventana de captura más larga (12 s en vez de 8 s,
para dejar resolver el fetch de ORCID del todo), la tarjeta viva de los dos SÍ
se deja ver, y en los dos mide exactamente lo mismo que la reserva de su
esqueleto: en Kessler, `"orcidCard":"20,277.9 1240x96"` — la misma caja exacta
que medía su `"orcidSkel"` un fotograma antes —; y en Rubin lo mismo, ahora
citado y no inferido. La afirmación original («la misma altura en la misma
posición») sólo era alcanzable restándole a `top` el `ty` de la transición de
ruta, y esa resta no estaba escrita en ninguna parte; su fichero crudo tampoco
sobrevivió, así que la corrida se repitió el 10-09 con el mismo `idx=4`, la
misma build y el mismo perfil, y la posición se lee directamente porque las
dos líneas llegan ya con `"tf":"none"`:

```
p0 {...,"settle":null,...,"orcidSkel":"20,277.9 1240x96","orcidCard":null,...}   # t=455 — la reserva
p0 {...,"settle":null,...,"orcidSkel":null,"orcidCard":"20,277.9 1240x96",...}   # t=855 — la tarjeta, misma caja
```

`settle` es `null` en toda esa corrida. (Su nota de impacto ya está en caché en
este perfil desde la ronda anterior — entra como «Low · 2023–2026» desde el
primer fotograma, sin «Calculating…» —, así que lo que la repetición vuelve a
leer es la tarjeta ORCID, no su camino frío.) Así que
`Math.abs(natural - remembered) < 1` y
`planHeightSettle` correctamente no programa nada: no es que el mecanismo
esté callado, es que Kessler y Rubin tienen perfiles ORCID cortos (sólo la
cabecera verificada, sin líneas de carrera) que caben en la reserva de 96 px
pensada para ese caso común.

Que el mecanismo SÍ dispare cuando la tarjeta no cabe se comprobó aparte, con
el cuarto autor frío, Frank B. Hu: su tarjeta ORCID llegó con 453,4 px (con
líneas de carrera, no sólo la cabecera) — 357,4 px más que la reserva — y
`getAnimations().find(id==='height-settle')` capturó el settle completo,
`"237.938px>942.906px"`, corriendo desde el mismo body de partida (237,9 px,
igual que en Kessler y Rubin) hasta 942,9 px en 300 ms. No es el caso de
Moher (185 px) que esta sección quería re-ejercitar — su nota de impacto
sigue en caché en este perfil, así que esa transición concreta sigue sin
poder observarse —, pero es la misma ruta de código con un delta mayor
(357,4 px contra la reserva, frente a los 185 px de Moher), y confirma que el
settle de la llegada ORCID dispara correctamente cuando el contenido no cabe
en la reserva. Ninguna de las dos — (a) ni (b) — es una regresión de esta
tarea.

**Coste de pintado del velo (Task 5, paso opcional).** Se intentó con
`Tracing.start` (categorías `devtools.timeline`, `disabled-by-default-devtools.timeline*`)
sobre la carga fría de la institución, 3,5 s de traza: `RasterTask=553`. Ese
número es de la PÁGINA COMPLETA (fuentes, icono, chrome del feed, todo), no
sólo de la capa del velo — la traza no atribuye eventos por capa de
composición sin trabajo adicional de correlación por `layerId`, así que no es
comparable directamente con el «21» de la auditoría original (que si era
específico del velo, por conteo de alturas). No se afirma un número
«después» equivalente al «21 rasterizaciones» original; la evidencia sólida
de que el coste bajó es la caja fija medida arriba (una imagen que no cambia
de tamaño no tiene motivo para volver a rasterizarse en cada fotograma).

**Lo que no mejoró, si algo.** La rejilla del esqueleto (264×131, medida en
Kessler, Rubin y Frank B. Hu — arriba) no iguala exactamente la altura de la
rejilla viva (264×125,9): quedan **131 − 125,9 = 5,1 px** de diferencia,
derivados de las dos cifras medidas, no leídos directamente en ningún campo.

El origen de esos 5,1 px **ya no se apoya en la lectura de Golub**. Aquella
venía del script aparte que el punto 1 acaba de descartar por conflar dos
rejillas co-montadas, y si su ancho era el del elemento equivocado sus alturas
no son mejor evidencia que su ancho: el documento no puede desacreditar una
fuente en un párrafo y citarla en el siguiente. Las dos filas se reconstruyen
aquí de la sonda estándar y de la hoja de estilos:

- **Fila 2 (la celda de impacto): medida.** La sonda la registra por su propia
  caja, dentro de su propia página, así que no puede conflar nada. En la
  corrida de Sander de más arriba: `"impact":"1020.5,187 131.5x80 \"\""` en el
  esqueleto (`t=478`) y `"impact":"1020.5,184.5 131.5x77.5 …"` en vivo
  (`t=665`) — **80 → 77,5 px**, −2,5.
- **Fila 1: derivada, con la aritmética a la vista.** La rejilla lleva
  `border-top: 1px` y las dos filas van bajo él, así que fila 1 = alto de la
  rejilla − 1 − fila 2: **131 − 1 − 80 = 50** en el esqueleto y
  **125,9 − 1 − 77,5 = 47,4** en vivo, −2,6. Los 50 del esqueleto salen además
  de la hoja sin medir nada, y coinciden: `.ehc-stat-box` pone
  `padding: var(--space-2)` arriba y abajo (0,5rem = 8, dos veces) y
  `border-bottom: 1px`; dentro van `.ex-skel-stat-value` (17 de alto), el
  `gap: 2px` de la columna flex y `.ex-skel-stat-label` (`margin-top: 5px`, 9
  de alto) → 8 + 17 + 2 + 5 + 9 + 8 + 1 = **50**. La celda de impacto añade su
  tercer hijo: otro `gap: 2px`, el `margin-top: 2px` de `.ehc-stat-detail` y su
  `min-height: 1.625rem` = 26 px (que gana a la barra de 8 que lleva dentro) →
  50 + 2 + 2 + 26 = **80**, el número medido.

La suma cierra: 2,5 + 2,6 = **5,1**. Cierra por construcción, eso sí — la fila
1 se obtuvo restando de la misma rejilla cuya diferencia explica, así que no es
una confirmación independiente; lo que aporta es que ninguna de las dos cifras
viene ya del script descartado, y que los 0,1 px que antes «faltaban» eran el
redondeo a la décima que la sonda aplica a cada caja, atribuido a la fila
equivocada. No reproduce el glitch original — que era el desplazamiento
horizontal de 75 px, ya cerrado — y el paso de esqueleto a héroe es un fundido
de opacidad, no un salto de layout, así que no se ve como tal; pero es un
residuo real, no cero. Y, como queda dicho arriba, el settle de una biografía
ORCID tan larga como la de Moher (185 px) sigue sin ejercitarse directamente
en esta ronda — el mecanismo sí se comprobó, pero con un delta mayor en otro
autor.
