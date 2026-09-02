# Rediseño de cuatro puntos de interfaz — 2026-09-02

Cuatro peticiones del usuario, cada una verificada en vivo antes de escribir
este plan. Las medidas vienen de un Chrome dedicado por CDP en `:9223` contra
el dev server de `localhost:5173` (el pane del navegador está oculto y congela
las animaciones de framer-motion, así que no sirve para medir movimiento).

---

## 1. El mapa de país de afiliación

### 1a. No está centrado — **causa medida**

`ReportFilters.css:466`

```css
.rf-map-wrap {
  position: relative;
  width: min(100%, 780px);
}
```

`.rf-country-controls` es `display: flex; flex-direction: column`, así que
`align-items` vale `stretch`; un hijo con `width` explícito deja de estirarse y
se queda pegado al **inicio del eje transversal**, o sea a la izquierda.

Medido en el arnés: el envoltorio ocupa 778 px dentro de un contenedor de
1192 px (el `max-width: 1240px` del informe menos su padding). Sobran 414 px de
blanco a la derecha del mapa mientras la nota, el buscador y la selección
rápida ocupan el ancho entero. Es exactamente lo que se ve en la captura del
usuario, donde la pista «SELECT A SUPPORTED COUNTRY ON THE MAP» aparece
centrada bajo el mapa pero descentrada respecto del panel.

**Arreglo:** `margin-inline: auto` en `.rf-map-wrap`. La pista ya está centrada
respecto del envoltorio, así que se centra con él.

### 1b. El glitch al cerrar — **dos causas medidas**

Muestreo por `requestAnimationFrame` del cierre de la sección (altura del
elemento de `Collapse`, altura del panel y `top` de la fila de acciones):

| t (ms) | altura | salto |
|--------|--------|-------|
| 8      | 579.0  | — |
| 26     | 545.3  | −33.7 |
| **43** | **390.2** | **−155.1 en un frame** |
| 60     | 267.6  | −122.6 |
| 210    | 8.5    | … |
| 343    | ~0.0   | … |
| **360**| desmontado | **panel 286 → 274, acciones 281 → 269** |

**Causa A — la curva.** `Collapse` usa la misma `EASE = [0.16, 1, 0.3, 1]`
(expo-out) para entrar y para salir. Al entrar está bien: arranca rápido y
posa. Al salir, esa curva significa arrancar a velocidad máxima: 155 px en un
frame de 17 ms y luego 133 ms arrastrándose de 8,5 px a 0. Se lee como un
corte, no como un plegado.

**Causa B — el salto de 12 px al desmontar.** `.rf-section` es
`display: flex; flex-direction: column; gap: var(--space-3)` y `--space-3` son
0,75 rem = **12 px**, que es exactamente el salto medido. Mientras el
`motion.div` de `Collapse` existe, el `gap` entre el botón de la sección y él
ocupa esos 12 px; cuando `AnimatePresence` lo desmonta, el `gap` desaparece de
golpe y todo lo que hay debajo pega un tirón. La animación termina en 0 px de
altura y aun así el panel salta.

**Arreglo:**
- Marcar la sección de países con su propio modificador y ponerle `gap: 0`,
  moviendo esos 12 px dentro de la caja que se pliega
  (`.rf-country-controls { padding-top: var(--space-3) }`, hoy `--space-2`).
  Así el espacio se anima con la altura en vez de evaporarse al desmontar.
- Dar a `Collapse` una transición de salida propia, simétrica de la de entrada
  (una curva que arranque suave), y hacer que la opacidad acompañe a la altura
  en lugar de terminar antes.

---

## 2. Las dos barras separadoras de «Mis listas»

`ListsPage.css:51` y `ListsPage.css:462`

```css
.lists-masthead-row  { border-bottom: 3px double var(--border-ink); }
.lists-expanded-header { border-bottom: 3px double var(--border-ink); }
```

`3px double` dibuja **dos líneas** de 1 px con 1 px de hueco: son las «dos
barras» de la petición, y aparecen tanto en el índice de listas como al abrir
una lista.

**Arreglo:** quitar las dos reglas y reajustar el espaciado que la regla
sostenía. Hoy el `padding-bottom` de cada cabecera existe para separar el texto
del filete; sin filete ese hueco se convierte en aire suelto, así que hay que
reequilibrar la cabecera contra lo que viene debajo (el standfirst y la rejilla
en el índice; la fila de exportación en la lista abierta).

`listsStyles.test.js` solo cubre los pares `save-modal` y `create-list`, así que
ningún test se apoya en estas reglas.

---

## 3. El cambio de pestaña del feed

Dos piezas.

**La barra amarilla.** `Navbar.css:180` la dibuja como
`.navbar-link.active::after`: un pseudoelemento que aparece y desaparece en el
enlace que toque, sin recorrido entre uno y otro.

**Arreglo:** sustituirlo por un `motion.span` con `layoutId` compartido,
renderizado solo dentro del enlace activo. framer-motion hace el FLIP entre las
dos posiciones y la barra se desliza. Con `useReducedMotion` la transición se
anula y el comportamiento vuelve a ser el actual.

**Y un segundo fallo, del mismo elemento, que solo se ve en móvil.** El filete
llevaba `left: 10px; right: 10px` a pelo, y el enlace baja su padding por
breakpoints: 10 px por encima de 768, 8 hasta 420, 6 hasta 380 y 4 por debajo.
O sea que el filete solo coincidía con la palabra a ancho completo. Medido:
2 px corto por lado a 700, 4 px a 390 y 6 px a 360 — doce píxeles de una
palabra de 56 sin subrayar en un teléfono. El inset pasa a ser
`--nav-rule-inset`, que es el mismo valor que el padding y baja con él.

**La transición de página.** Las tres pestañas son tres rutas (`/`,
`/research`, `/following`) y ya pasan por `PageTransition` dentro de un
`AnimatePresence mode="wait"`. Medido en un arnés que reproduce esa estructura:
la salida usa la misma expo-out que la entrada, así que la página saliente
estaba al 14 % de opacidad a los 59 ms y al 0,1 % a los 159, mientras
`mode="wait"` retenía la entrante hasta los 226. **184 ms de pantalla en blanco**
entre dos pestañas de la misma barra. No es una transición lenta: es un hueco en
medio de una rápida.

**Arreglo:** una curva de salida propia (`ease-in`), que sostiene la página
saliente y la suelta al final. El hueco baja a 67 ms y el total no se alarga.

---

## 4. Research al cambiar de periodo

### 4a. El parpadeo

`ScientificReport.jsx:518-526`

```jsx
<AnimatePresence mode="wait" initial={false}>
  <motion.div className={`sr-body ...`} key={reportContentKey} ... />
```

`reportContentKey` es la lista de ids del hero y de los destacados. Cuando llega
una edición nueva la clave cambia, y con `mode="wait"` **todo el cuerpo —
incluida la barra lateral — se desvanece a 0 y vuelve a entrar desde 0**. Ese
hueco en blanco es el parpadeo.

Y ocurre **dos veces** por cambio de periodo: `fetchReport` con
`refreshTrends: true` pinta el informe, espera las tendencias y luego vuelve a
pedir el informe reordenado (`setReport(reranked)`), lo que cambia la clave por
segunda vez.

**Arreglo:** dejar de remontar el cuerpo. La atenuación mientras carga
(`animate={{ opacity: loading ? 0.76 : 1 }}`) se queda; las entradas escalonadas
las siguen haciendo los elementos de dentro, que tienen sus propias claves (el
hero real monta cuando se va el esqueleto, y las celdas de `ResearchForme` están
keyeadas por id de paper).

### 4b. La barra lateral no se pone en esqueleto

Mientras `loading` es cierto:

- el hero cede el sitio a `LeadStorySkeleton` (línea 639),
- las tendencias pintan `sr-trend-skeleton` (línea 578),
- **`.sr-stats-bar` sigue mostrando los números de la edición anterior** —
  «11 seleccionados / 9.914 citas / 11 de 11 OA» de la captura.

**Arreglo:** una versión en huesos de la barra de estadísticas mientras carga,
con el mismo vocabulario gris que ya usan `sr-bone` y `sr-trend-skeleton`, y un
fundido cruzado al pasar a los números. La animación que al usuario le gusta
—`AnimatedNumber` contando hasta el total— se conserva: cuenta cada vez que
cambia `value`, así que sigue disparándose cuando el esqueleto da paso al dato.

---

## Verificación

`npm run lint` limpio y `npm test` en 1818/1818. Todo lo demás está medido por
`requestAnimationFrame` en el Chrome de CDP, sobre los componentes reales con
sus hojas de estilo reales montados en un arnés temporal (borrado al terminar),
porque las páginas están tras `ProtectedRoute` y no hubo sesión disponible.

| | antes | después |
|---|---|---|
| Mapa | 778 px a la izquierda de 1192 | 206 px de margen a cada lado |
| Cierre del panel | −155 px en un frame; tirón de −12 px al desmontar | caída máxima −95 px; tirón de −0,3 px |
| Cabeceras de listas | `3px double` | sin filete; 20 / 20 / 24 px |
| Barra amarilla | pseudoelemento, sin recorrido | 27–29 posiciones distintas por salto, a 1440 y a 390 px |
| Inset de la barra | 0 / 2 / 4 / 6 px corto a 1440 / 700 / 390 / 360 | 0 en los cuatro |
| Cambio de feed | 184 ms en blanco | 67 ms (51 en el segundo salto) |
| Cuerpo de Research | opacidad mínima 0 (150 ms en negro) | mínima 0,76, nunca se desmonta |
| Barra lateral | 0 frames en esqueleto, 28 con cifras viejas | huesos toda la carga, `srValueIn` de 360 ms, altura clavada en 188,3 px |

## Lo que este plan NO arregla

`<Suspense>` está fuera del `<AnimatePresence>` en `App.jsx:155`, y Research y
Following se cargan con `lazy()`. La primera vez que se entra a esas pestañas en
una sesión, React sustituye el árbol entero por `RouteFallback` y corta la
animación de salida en seco; a partir de la segunda ya no. Arreglarlo significa
mover el límite de Suspense dentro de cada ruta, y eso toca el enrutado entero.

---

## Lo que salió después, ya en producción

Tres cosas que solo aparecieron con la aplicación desplegada y el usuario
mirándola desde un teléfono.

**El muelle de la barra amarilla tenía cola.** `stiffness: 420, damping: 38,
mass: 0.7` da ζ ≈ 1,11 — sobreamortiguado. Medido en el salto Para ti →
Siguiendo (133 px a 390 px de ancho): el 90 % del recorrido en 224 ms y el 10 %
restante en otros 216. Y como el filete crece mientras viaja, el borde
izquierdo llegaba con el derecho todavía a diez píxeles: se leía como llegar
corto, pararse y reptar. Ningún afinado del muelle lo arregla (medidos
`bounce: 0`, `bounce: 0.15` y uno críticamente amortiguado: todos entre el 43 y
el 50 % del tiempo en ese último décimo). Un tween acotado —
`{ duration: 0.28, ease: [0.4, 0, 0.2, 1] }` — lo baja al 28 %.

**El inset del filete no seguía al padding.** `left: 10px; right: 10px` a pelo
contra un padding que baja por breakpoints: el filete quedaba 2 px corto por
lado a 700, 4 a 390 y 6 a 360. Ahora es `--nav-rule-inset`.

**Una trampa de especificidad en la reja del forme.** `.sr-cell:not(.is-row-end)`
son dos clases; el override móvil `.sr-cell` es una, y un media query no suma
especificidad. La regla vertical entre columnas nunca se apagó en una sola
columna: la mitad de las celdas —las que el plan de seis columnas no marcó como
final de fila— seguían dibujando un filete gris al borde de la medida, y con
`padding-right: 0` el año quedaba a 1 px de él. El apagado se repite ahora a la
misma especificidad.

Y la selección de periodo de Research estrena el mismo filete viajero que la
navbar (`layoutId` compartido, misma curva). En móvil la fila envuelve a dos
líneas: el salto entre ellas cae por el hueco entre filas y sigue por la banda
de subrayado, sin cruzar tipografía.
