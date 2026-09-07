# El glifo de campo destella al llegar la tarjeta — Auditoría y plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Que el glifo del campo científico (el «átomo» de física, `Orbit`) deje de atenuarse de golpe sin causa visible cuando la tarjeta acaba de entrar, y que no se atenúe en absoluto donde los recortes nunca se dibujan.

**Spec:** El síntoma reportado — «al scrollear hacia abajo el logo del átomo parece tener un glow momentáneo, pero luego dicho glow desaparece» — medido en vivo sobre el feed de invitado, y la semántica de la regla comprobada contra la hoja publicada.

---

## Auditoría

### Qué es el «logo del átomo»

`AREA_WATERMARK_ICONS` en [PaperCard.jsx:87](../../../src/components/Feed/PaperCard.jsx#L87) mapea `physics → Orbit` (lucide). Se dibuja a 220 px en la esquina de la hoja como `.pc-watermark`, tintado con `--area-accent` (`#4f46e5` indigo en claro, `#8792ff` en oscuro). No es el `AnimatedAtom` del velo de carga: ése es el estado de espera del feed, no una marca de categoría.

### El síntoma, medido

La hoja tiene **dos** valores para ese glifo, en [PaperCard.css:218-229](../../../src/components/Feed/PaperCard.css#L218):

```css
.pc-figures ~ .pc-sheet .pc-watermark { opacity: 0.1; }   /* con recortes */
.pc-watermark { …; opacity: 0.14; }                        /* en reposo */
```

Sonda CDP sobre `localhost:5173`, feed de invitado, 1280×900, muestreando cada
fotograma la opacidad computada de cada `.pc-watermark` y el estado de los
recortes de su tarjeta. Un swipe hacia abajo:

| t (ms) | scrollTop | tarjeta que llega | opacidad | recortes montados / cargados |
|---|---|---|---|---|
| 1095 | 657 | `top=200` (entrando) | **0.140** | 0 / 0 |
| 1455 | 757 | `top=100` (asentada) | **0.100** | 4 / **0** |
| 1585 | 757 | asentada | 0.100 | 4 / 1 |
| 1678 | 757 | asentada | 0.100 | 4 / 4 |

Tres hechos salen de ahí:

1. **El salto ocurre con la tarjeta ya en pantalla**, a ~360 ms de llegar al
   punto de anclaje. No es un artefacto del scroll.
2. **Es instantáneo.** El muestreo es por fotograma y deduplica cambios: entre
   0.140 y 0.100 no hay un solo valor intermedio. `.pc-watermark` no declara
   `transition`, y la única transición global de `global.css` es la de `button`.
3. **Llega antes que su causa.** En el fotograma del salto hay 4 recortes
   montados y **ninguno cargado**, y `.pc-figure:not(.is-loaded)` los mantiene a
   `opacity: 0`. El primer recorte se ve 130 ms después, y el último 220 ms
   después. El lector ve desaparecer tinta sin que aparezca nada.

Cuánta tinta, compuesta sobre el fondo de la tarjeta:

| tema | 0.14 | 0.10 | salto máx. por canal | tinta perdida |
|---|---|---|---|---|
| claro (`#4f46e5` sobre `#ffffff`) | `rgb(230,229,251)` | `rgb(237,236,252)` | 7 | 29 % |
| oscuro (`#8792ff` sobre `#16191f`) | `rgb(38,42,62)` | `rgb(33,37,53)` | 9 | 29 % |

**El 29 % de la tinta del glifo se va en un fotograma.** En oscuro, un indigo
suave sobre una hoja casi negra que se apaga de golpe es exactamente lo que se
describe como «un glow que desaparece».

### Por qué siempre cae en pantalla

El montaje de `.pc-figures` depende de que haya figuras, y la búsqueda está
cerrada tras `isCardSettled` en [PaperCard.jsx:456-464](../../../src/components/Feed/PaperCard.jsx#L456):

```js
useEffect(() => {
  if (!isCardSettled) return () => { active = false; };
  getPaperFigures(paper).then(found => { … setFigures(found.slice(0, 4)); });
}, [isCardSettled, paper]);
```

`isCardSettled` se enciende `ENRICHMENT_SETTLE_DELAY_MS` (240 ms) después de que
el IntersectionObserver dé la tarjeta por visible. La puerta es correcta —evita
pedir figuras de tarjetas que el lector está saltando— pero garantiza que el
cambio de opacidad **nunca** puede ocurrir fuera de pantalla. Los 360 ms medidos
son esos 240 ms más la resolución del servicio.

### El segundo defecto de la misma regla

Bajo 1080 px los recortes no se dibujan ([PaperCard.css:209-211](../../../src/components/Feed/PaperCard.css#L209)):

```css
@media (max-width: 1080px) { .pc-figures { display: none } }
```

Pero `~` es estructural: ignora `display`. React monta `.pc-figures` en
cualquier viewport, así que el glifo se aparta igual. Comprobado contra la hoja
real, construyendo una tarjeta a mano en la página ya cargada:

```
desktop 1280: {"figuresDisplay":"block","withFigures":"0.1","withoutFigures":"0.14"}
mobile   390: {"figuresDisplay":"none", "withFigures":"0.1","withoutFigures":"0.14"}
```

En el móvil el glifo cede sitio a recortes que **nunca aparecen**, y el destello
sigue ocurriendo con la tarjeta delante.

### Qué no es

- No es el `AnimatedAtom` del velo de carga (`FeedContainer.jsx`).
- No es la llegada de la tarjeta: `.pc-watermark` no está en la lista de
  `pcArrive` y no lleva animación ninguna (`getAnimations()` vacío en todos los
  fotogramas medidos).
- No es un filtro, un `mix-blend-mode` ni un cambio de color: medidos
  `filter: none`, color constante `rgb(79,70,229)` a ambos lados del salto.

### La intención original, que se conserva

El comentario de la regla dice por qué existe: «The field glyph stays when the
paper brings figures… Behind the figures it steps back rather than leaving».
Es una buena decisión y no se toca. El fallo es de **momento** y de **alcance**:
se aparta antes de que llegue aquello para lo que se aparta, de golpe, y también
donde no llega nada.

---

## Plan de implementación

### Tarea 1 — Test que falla primero

- [ ] Crear `src/components/Feed/paperCardWatermark.test.js` siguiendo la
      convención de `paperCardOverflowStyles.test.js` (despojar comentarios,
      capturar el cuerpo de una regla por selector exacto).
- [ ] Aserciones:
      1. no queda ninguna regla que atenúe el glifo por la mera existencia de
         `.pc-figures` (guarda de mutación: la regla vieja tiene que fallar);
      2. la regla que atenúa exige un recorte **con su imagen**
         (`.pc-figure.is-loaded`);
      3. está acotada al viewport donde los recortes se dibujan, en complemento
         exacto del `max-width: 1080px` que los oculta;
      4. `.pc-watermark` declara una `transition` de `opacity`, para que el
         apartarse sea un asentamiento y no un escalón;
      5. los dos valores siguen siendo 0.14 en reposo y 0.1 apartado.
- [ ] `node --test src/components/Feed/paperCardWatermark.test.js` → rojo.

### Tarea 2 — La regla

- [ ] En `PaperCard.css`, sustituir `.pc-figures ~ .pc-sheet .pc-watermark` por
      una regla condicionada a `:has(.pc-figure.is-loaded)` y envuelta en
      `@media not all and (max-width: 1080px)` — el complemento exacto de la
      regla que esconde los recortes, sin el uno-menos de un `min-width: 1081px`.
- [ ] Añadir a `.pc-watermark` una `transition: opacity` con la duración base y
      la curva de la entrada de los recortes (`FIGURE_ENTRANCE_BASE_MS` = 620 ms,
      `cubic-bezier(0.16, 1, 0.3, 1)`), para que el glifo ceda **con** el primer
      recorte y los dos se lean como un solo suceso.
- [ ] Degradación: en un motor sin `:has()` la regla entera se descarta y el
      glifo se queda en 0.14 — el destello desaparece; el modo de fallo es el
      seguro.

### Tarea 3 — Movimiento reducido

- [ ] Añadir `.pc-watermark` a la lista de `@media (prefers-reduced-motion: reduce)`
      que ya anula `animation`/`transition` en `.pc-figure`. Con la preferencia
      puesta el recorte aparece de golpe, así que el glifo debe apartarse en el
      mismo fotograma: instantáneo, pero por fin **simultáneo a su causa**.

### Tarea 4 — Verificación en vivo

- [ ] Volver a pasar la sonda de fotogramas sobre el feed de invitado y
      comprobar, en la tarjeta que llega: que la opacidad ya no salta de 0.140 a
      0.100 en un fotograma, y que el descenso arranca en el fotograma en que el
      primer recorte se marca `is-loaded`.
- [ ] Repetir la comprobación sintética a 390 px: el glifo debe quedarse en 0.14.
- [ ] `npm test` y `npm run lint` completos.

---

## Fuera de alcance

- **Adelantar la búsqueda de figuras** a la tarjeta siguiente para que los
  recortes lleguen antes de que la tarjeta se vea. Cambia el coste de red y
  desarma a propósito la puerta de `isCardSettled`, que existe para no pedir
  figuras de tarjetas que el lector está saltando. Con el apartarse ya ligado a
  una causa visible, deja de ser necesario.
- **Los recortes bajo `prefers-reduced-motion`**: `.pc-figure` ya está en la
  lista que anula su entrada, así que aparecen de golpe. Es anterior a este bug
  y no se toca aquí.
