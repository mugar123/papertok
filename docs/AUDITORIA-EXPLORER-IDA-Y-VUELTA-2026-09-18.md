# Explorer: institución → autor y la vuelta — 2026-09-18

Reportado por el usuario: «cuando entro a una institución, luego a un autor desde la institución
y desde el autor voy hacia atrás, la animación de ir hacia atrás parece algo glitcheada»; y «arregla
también la animación de entrada al pulsar un autor desde la página de institución».

## Cómo se midió

Chrome headless por CDP (1280×900) con el perfil de sondas que tiene la sesión real, sobre la build
de producción en `localhost:5174`. Sonda `entity-pair-frames.mjs` (scratchpad de la sesión,
derivada de `scripts/diagnostics/page-transition-frames.mjs`): abre Harvard
(`#/explorer/institution/I136199984`), pulsa la pestaña Authors, pulsa la primera tarjeta de autor
y graba la ida; espera 4 s y graba `history.back()`. Cada grabación es un screencast (hoja de
contactos) más una muestra por `requestAnimationFrame` de las dos páginas bajo `#main-content`:
`data-page-motion`, opacidad, transform, `position`/`top`, el nombre del héroe, si es esqueleto,
la caja del héroe y su settle WAAPI, la pestaña activa, la tira de pestañas, la primera fila y la
altura de la página; y `window.scrollY`. Dos tiradas: sin scroll, y con las dos páginas a 600 px
(`scroll=600`), que es el caso real, porque la lista de autores está debajo del héroe.

## La ida: institución → autor

**Autor frío (nunca abierto en el perfil).** La página de autor entra como ESQUELETO: héroe gris de
131 px y filas grises durante toda la transición y hasta los ~600 ms, cuando aparece el nombre; el
héroe se asienta entonces dos veces, 131 → 238 (el registro: nombre, cifras, conceptos) y
238 → 393 (ORCID, impacto reciente, experiencia). Causa: la tarjeta de autor de la pestaña Authors
navega con `navigateToEntity('author', author.id)` sin entregar el autor en el estado del router,
aunque tiene su nombre, sus cifras y su índice h — el mismo camino que la paleta de búsqueda ya
recorre con `handoverFromSearchRow`.

**Autor caliente (en caché).** Nace vivo (nombre y héroe de 238 px en el primer fotograma), pero la
lista de papers se monta durante la propia entrada: la altura de la página sube en cinco tramos
(1549 → 3977 → 5797 → 7725 → 9653 → 11581 px) y **no hay ningún fotograma entre 147 y 325 ms**,
ni en el screencast ni en el muestreador: la entrada se congela a mitad de camino.

## La vuelta: autor → institución

La ruta está keyed por pathname, así que volver monta la institución de nuevo. Con la página a
600 px al salir, medido por fotograma:

| t | Qué pasa |
|---|---|
| 40 ms | La institución monta en `reveal` a **scrollY 0**, pestaña **Papers** (se dejó en Authors), héroe **148,8 px** (sin el bloque de Wikipedia) |
| 58 → 294 ms | El navegador restaura el scroll **deslizando**: 2, 11, 29 … 428, 557, 600 — `html { scroll-behavior: smooth }` convierte su restauración en un viaje vertical superpuesto al horizontal del `reveal` |
| 40 → 191 ms | La lista de papers llega en tramos durante el revelado (altura 1675 → 7094) |
| 299 ms | La página se asienta; **arranca un settle** del héroe |
| 332 → 691 ms | Héroe 148,8 → **320,2 px**: la tira de pestañas y la lista bajan 171 px en una página que el lector acaba de ver llegar |

Tres cosas superpuestas: la restauración del scroll del navegador (tarde y suave), la pestaña
equivocada con su lista cargándose, y el bloque de Wikipedia pedido otra vez y aterrizando como
settle después del revelado.

## Arreglos

1. **`PageTransition` restaura el scroll por su cuenta.** `history.scrollRestoration = 'manual'`;
   cada página recuerda su `scrollY` bajo la `key` de su entrada de historia al irse, y una página
   que vuelve (`reveal`) se coloca en ese valor, instantáneo, en el layout effect del montaje: antes
   del primer fotograma, sin deslizamiento. Una recarga empieza arriba (el feed guarda lo suyo en
   sessionStorage).
2. **La página de entidad vuelve como se dejó.** Una memoria de visitas por `type:id` (24 entradas)
   guarda la pestaña, la lista de autores (página, si hay más, la búsqueda), el bloque de Wikipedia,
   la miniatura cargada y el impacto reciente. El siguiente montaje nace con ellos; el efecto de
   carga no los borra en ese montaje y el efecto de autores no vuelve a pedir ni pinta su esqueleto;
   el reset diferido de pestaña ya no corre al montar. Las peticiones siguen corriendo y solo
   mejoran lo que hay.
3. **La tarjeta de autor entrega su fila.** `navigateToEntity(type, id, handover)` pasa
   `handoverFromSearchRow` en el estado del router; la página de autor nace con nombre y cifras.
4. **La primera página de papers espera a que la página termine de llegar** (`useAfterPageArrival`,
   como ya hacía el bloque de Wikipedia); las filas de esqueleto quedan mientras.

## Resultado (medido igual, build de producción, sesión real)

| Escenario | Antes | Después |
|---|---|---|
| Ida, autor frío (Heng Li, Peter Libby) | esqueleto hasta ~600 ms; dos settles, 131 → 238 → 393 | nace con nombre y cifras en el primer fotograma; un solo settle al llegar el registro, ya con la página quieta |
| Ida, autor caliente, institución a 600 px | sin fotogramas de 147 a 325 ms (la lista de papers montando) | fotogramas continuos; la lista monta a ~400 ms, con la página quieta |
| Vuelta, sin scroll | pestaña Papers; héroe 148,8 → 320,2 en un settle tras el revelado | pestaña Authors; héroe 320,2 desde el primer fotograma; sin settle |
| Vuelta, a 600 px | mounts a 0 y desliza 0 → 600 durante el revelado; Papers; settle de 171 px | scrollY 600 desde el primer fotograma; Authors; sin settle; sin huecos de fotogramas |

Tres tiradas seguidas de la vuelta a 600 px y dos de autor frío, todas iguales. Queda un hueco
de fotogramas de ~250 ms **después** de que el autor se asienta (a ~1 s, el registro ORCID y el
panel de experiencia montando), que ya estaba antes y no es la entrada.

**Una trampa de medida que parecía un fallo:** la primera tirada tras cada `vite build` fallaba
entera (Papers, scroll 0, settle) con el autor marcando `data-nav-direction="0"`. Es la recarga
que la pestaña se da a sí misma cuando el service worker nuevo toma el control tras un despliegue
(memoria `papertok-feed-position-lost-is-a-reload`): la recarga cae en la página de autor y se
lleva las dos memorias de módulo. Las tiradas siguientes, sin recarga (`performance` dice
`navigate`), pasan todas. En producción esto significa que la **primera** vuelta atrás después de
un despliegue vuelve como antes; las demás, como ahora.
