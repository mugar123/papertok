# Estado / pendientes

## Un solo buscador: las personas entran donde ya se buscan papers (2026-08-20)

**Implementado, tests verdes, SIN commitear y SIN desplegar.** No toca
`firestore.rules` ni una línea, así que no hay despliegue de rules. La pasada
con sesión está pendiente — lista de pasos al final.

La búsqueda de personas deja de ser una página aparte (`/search/users`) y pasa
a ser una sección más del buscador de `/search`, con su píldora **"Users" /
"Usuarios"** como filtro. La página antigua se **borra**, sin redirect: la UI de
F9 nunca llegó a desplegarse, así que no existe ni un enlace a esa ruta en
ninguna parte. Comprobado en vivo: `/search/users` cae al feed por el catch-all,
sin pantalla en blanco.

### Cómo se mezclan los dos buscadores

**No se mezclan fila a fila, y esa es la decisión.** OpenAlex devuelve su propio
ranking de relevancia y Firestore devuelve orden lexicográfico sobre un prefijo;
no hay forma honesta de comparar la puntuación de un paper con la de un handle.
Inventar una puntuación global sería mentir. Así que las personas son una
sección como las otras cinco.

| Pregunta | Respuesta |
| --- | --- |
| Orden **dentro** de la sección | El contrato que ya existía y ya estaba testeado: `mergeUserSearchResults` pone las coincidencias de handle antes que las de nombre, deduplicadas por uid. Sin tocar. |
| Orden **entre** secciones | El mismo heurístico que ya ordenaba las cinco. `users` entra en `DEFAULT_SECTION_ORDER` en segunda posición y **el primero** en `exactPriority`. |
| Cuándo mandan las personas | Una coincidencia exacta con handle o nombre, o un término que empieza por `@`. |
| Por qué segundas y no primeras | Un prefijo de dos letras coincide con alguien por accidente, así que una sección de personas no vacía no es por sí sola prueba de intención. Primera pondría desconocidos por encima de la literatura en cada búsqueda. |

**Detalle que muerde:** `getSearchSectionOrder` puntúa 99 a las secciones
desconocidas. Una sección pintada por la página pero ausente de
`DEFAULT_SECTION_ORDER` queda la última en todas las búsquedas, en silencio y
para siempre. Hay un test que lo fija.

### Dos relojes, una caja de texto

El abanico externo mantiene su debounce de 320 ms. La consulta de personas va en
**un efecto aparte con los 400 ms que fijó P16** y su mínimo de 2 caracteres, así
que una palabra tecleada cuesta una búsqueda y dos lecturas, no una por letra.
La razón de la asimetría: OpenAlex y OpenAIRE son cuota de otro, Firestore es
nuestra factura.

Y la píldora es **puerta de gasto además de filtro**: con cualquier filtro que
no sea "Todo" o "Usuarios", no se emite ninguna consulta a Firestore. Elegir
"Usuarios" con un término ya escrito dispara la búsqueda.

### Qué pasa si uno responde y el otro no

Las cinco fuentes externas siguen en `settleSearch`, que nunca rechaza, y el
banner de siempre distingue "Resultados parciales" de "La búsqueda no está
disponible". **Las personas no entran en ese banner**, y hay un test que lo
impide, por dos razones:

1. El botón de reintentar del banner relanza las cinco fuentes externas —
   gastar cuota de OpenAlex no arregla un tropiezo de Firestore.
2. `openAlexUnavailable` dice literalmente "OpenAlex no está disponible". Si un
   fallo nuestro entrara ahí, la página estaría atribuyendo a un tercero un
   fallo propio. Misma familia de mentira que la guillotina de 6 s que ya se
   corrigió en la pasada de fiabilidad.

La sección lleva **su propio estado en línea**, con `patientRead`: reintentos
acotados sin abandonar los anteriores, gana el primero que conteste, "está
tardando más de lo normal" en vez de "ha fallado", y **la respuesta tardía se
entrega igual** por `onLateResult`. Un parón que acaba a los nueve segundos cura
la sección a los nueve segundos sin tocar nada.

### Sin sesión

La píldora **se queda visible y seleccionable** — esconderla deja "¿por qué no
encuentro a nadie?" sin respuesta. En su lugar aparece una fila que dice lo que
es verdad: encontrar personas necesita cuenta, con el botón que abre el
`AuthPrompt` que ya existe, y una línea aclarando que papers, instituciones y
proyectos siguen abiertos a todo el mundo. **Cero consultas a Firestore.**

Lo importante es el mapeo: `UserSearchAuthRequiredError` va a ese estado y
**nunca** al banner de error. Sin eso, un visitante leería "la búsqueda no está
disponible temporalmente", que es falso — no está rota, está cerrada para él.

**Hoy esto es una rama latente**: `/search` está detrás de `ProtectedRoute`, así
que ningún visitante sin sesión llega. Se construye igual porque el servicio
rechaza antes de la red pase lo que pase, y porque abrir el buscador de papers a
invitados es la dirección natural del viaje — cuando pase, degrada solo.

### Lo demás que entró

- **La arroba.** `normalizeUserSearchTerm('@nick')` devolvía `'@nick'` y los
  handles se guardan sin ella, así que buscar `@nick` no encontraba a nadie —
  la búsqueda más segura que hace nadie, teclear el handle que ya conoce.
  Ahora se quita. **Solo del lado de la consulta**: `toIndexedName`, que espeja
  el `.lower()` del motor de rules, no se toca.
- **Fila de persona**: reutiliza `.search-item` y `.search-item-avatar`, que ya
  pintaban monograma para los autores de OpenAlex — **cero CSS nuevo de fila**.
  Sin foto (el índice no la guarda) y **sin botón de seguir**: seguir a una
  persona es el grafo `follows/` de F2, y saber si ya la sigues sería una
  lectura por fila, la familia de bug de R7. Vive en el perfil que la fila abre.
- **El aviso de prefijo sobrevive**, y ahora hace más falta: una sección de
  personas vacía al lado de diez papers se lee como "esta persona no está en
  PaperTok", y casi siempre es falso.
- En la vista "Todo" se muestran **5 personas** como mucho, con un "ver las N"
  que cambia a la píldora Usuarios; bajo la píldora salen todas.
- El título de sección desambigua: "Usuarios de PaperTok" frente a "Autores",
  que son los que firman papers en OpenAlex. La píldora se queda corta.

### Costes

**La carga de feed sigue costando 1 lectura, y el test estructural pasa sin
tocarlo.** `SearchPage` no está entre los cinco módulos que vigila, y la
dirección del import es `SearchPage → PaperCard`, nunca al revés. Una búsqueda
de personas ejecutada sigue siendo 2 queries acotadas; cero lecturas por fila
pintada.

### Tests

- **670 unitarios** (11 nuevos): `searchRelevance.test.js` nace de cero — el
  orden de secciones no tenía tests —, `searchIntegration.test.js` fija los
  cuatro invariantes que un refactor rompería en silencio, y los de la arroba.
- Lint y build limpios.

### Bug preexistente encontrado, no arreglado aquí

**`--text-muted` no está definido en ninguna parte**, y `SearchPage.css` lo usa
**7 veces**. Las siete declaraciones se caen en silencio y esos elementos
heredan el color del padre en vez de atenuarse. Es exactamente la clase de bug
que `profileStyles.test.js` existe para cazar — se destapó al intentar apuntar
ese test al fichero nuevo.

No se arregla aquí porque definirlo **cambia cómo se ve la página de búsqueda**,
y eso no es de esta fase. El CSS nuevo usa `--text-secondary` para no añadir una
octava instancia. `profileStyles.test.js` documenta el hueco con su motivo, y
añadir `SearchPage.css` a su lista es una línea en cuanto se decida el token.

### Pendiente de tu sesión

`/search` exige sesión, así que la pasada visual es tuya. Servidor de dev
levantado en esta sesión si lo quieres. Qué mirar:

1. La píldora **Usuarios** en segunda posición, y que seleccionarla deje solo
   personas.
2. Buscar `mug` y `nicolás` → las dos cuentas, con monograma, nombre y @handle,
   sin foto y sin botón de seguir. Pulsar una abre su perfil público.
3. Buscar `@mugar` → la sección de personas **sube arriba del todo**.
4. Buscar `mugar` a secas (coincidencia exacta de handle) → también arriba.
5. Buscar `CRISPR` → sección de personas ausente, papers arriba, y el resto del
   buscador exactamente como estaba.
6. Con el filtro Usuarios, escribir una sola letra → "escribe al menos 2
   caracteres", no "sin resultados".
7. Un término que no encuentre a nadie → el aviso de prefijo, no un vacío mudo.

### Fuera, a propósito

- **El icono en la Navbar.** Sigue siendo de la rama del compañero.
- **Abrir `/search` a invitados.** El estado sin sesión está construido y
  probado, pero quitar el `ProtectedRoute` es un cambio de alcance que no
  pediste.
- **Prefijo, no substring ni typos.** Sin cambios: sigue en `02-SECURITY.md` §7.
- **La nota en `04-PHASES.md`.** Otra sesión tiene ese fichero con cambios sin
  commitear (P17); anotarlo ahí ahora sería pisarla.

## Endurecimiento de F9 — pasada hostil sobre P16 (2026-08-20)

**Rules desplegadas en `papertok-168df`. La app NO necesita despliegue todavía**
— la de F9 nunca se desplegó, así que ningún cliente vivo escribe en el índice.
No es fase nueva del plan: es la corrección de P16 contra su propia revisión
hostil, hecha antes de tocar la integración de los buscadores.

### De dónde sale: cuatro agujeros, todos reproducidos contra las rules reales

Los ataques se escribieron para **tener éxito si el agujero existe**. Los cinco
lo tuvieron. Están en el scratchpad de la sesión (`f9-attacks.test.js`); lo que
quedó en el repo son los tests de emulador que los cierran.

| Hallazgo | Qué permitía |
| --- | --- |
| **Relleno de nombres en dos pasos** | La igualdad `nameLower == displayName.lower()` solo se comprobaba **al escribir la entrada**. Ponte "Taylor Swift", indéxate legalmente, renombra el perfil sin tocar la entrada: el índice sigue anunciando un nombre que el perfil no tiene, de forma duradera e invisible desde el perfil. Es exactamente el agujero que la igualdad existe para cerrar, ejecutado en dos escrituras en vez de una. |
| **La misma deriva, en el handle** | Renombrar el handle dejaba la fila anunciando el viejo. En cuanto otra cuenta reclama ese handle libre, la fila **abre el perfil de otra persona**. |
| **Entrada que nadie podía borrar** | `userSearch` no tenía borrado de admin. Un perfil retirado por moderación dejaba su entrada sirviendo nombre y handle para siempre, y la única cuenta que podía quitarla era la que acababan de moderar. |
| **`createdAt` era un reloj de última edición** | Las rules exigían `createdAt == request.time` en create *y* update, y el cliente reescribía la entrada en cada guardado. Cualquiera con sesión podía `orderBy('createdAt','desc')` y obtener un listado de **quién tocó su perfil más recientemente**, que el producto no ofrece por ningún sitio. Nada lo leía. |

Más el consentimiento heredado, que no es un agujero de rules sino una decisión
de producto: un perfil anterior a F8 no tiene `visibility`, cuenta como público,
y el índice se escribía en *cualquier* guardado. Editar la bio te metía en un
índice buscable sin que nadie te lo hubiera preguntado.

### Qué entró

| Pieza | Archivo |
| --- | --- |
| `searchIndexCoherentAfter(uid)` y `profileSearchStateValid(uid)` (antes `profilePublicOrDelisted`): una escritura pública tiene que dejar la entrada, si existe, cuadrando con el perfil que produce — nombre **y** handle | `firestore.rules` |
| `allow delete` de `userSearch` gana `\|\| isAdmin()` | `firestore.rules` |
| La entrada pierde `createdAt`: forma `{handle, nameLower}` y las rules rechazan cualquier sello | `firestore.rules`, `userSearchService.js` |
| `validUserSearchEntry` exige perfil **explícitamente** público, no público-por-ausencia | `firestore.rules` |
| `syncSearchEntry` invierte la condición: indexa solo si `visibility === 'public'`, y en cualquier otro caso **borra** | `src/services/userProfileService.js` |

### La medición que decidía el tope de pines

La pregunta era si cerrar el agujero bajaba el tope de 6 a 5. **No lo baja.**

| variante | tope, guardado normal | tope, renombrar handle | vinculante |
| --- | --- | --- | --- |
| rules de P16 | 7 | 7 | **7** |
| solo la mitad del nombre | 7 | 6 | **6** |
| las dos mitades | 6 | 6 | **6** |

Cerrar las dos mitades cuesta **lo mismo** que cerrar solo la del nombre, porque
el camino de renombrar handle ya baja a 6 por sí solo: no había intercambio que
hacer. El tope se queda en 6 y todo guardado legítimo al tope pasa, medido.

**Lo que sí se acabó es el margen.** F1 eligió 6 dejando una entrada libre "para
la próxima cláusula"; ésta es esa cláusula. Seis es ahora techo y tope a la vez,
y **la siguiente cláusula que se añada a `userProfiles/` baja el tope a 5** — lo
cual afecta directamente a P17, que está en marcha en otra sesión.

Dos trampas de método, anotadas porque volverán a morder a quien re-mida:

1. Sondear con 7 pines mide el **tope** (`entries.size() <= 6`), no el
   presupuesto. Hay que subir el tope para medir.
2. Subir el tope solo **no cambia nada**: `validPinnedLists` desenrolla
   exactamente seis comprobaciones, así que las entradas 7 en adelante ni se
   validan ni cuestan. Hay que extender el desenrollado también.
3. Y la única señal fiable es `allowed`: las trazas de denegación del emulador
   mencionan "1000 expressions" por motivos ajenos a la cláusula que de verdad
   decidió, así que clasificar denegaciones por su mensaje miente.

### Tests

- **131 contra el emulador** (10 nuevos), y varios existentes **invertidos**
  porque afirmaban lo contrario de lo que ahora es cierto: un perfil heredado ya
  no se indexa solo, y renombrar sin llevarse la entrada ya no pasa.
- **659 unitarios** (4 nuevos de consentimiento heredado y coherencia).
- **Pasada de mutación: 15 mutantes, 12 muertos, 3 supervivientes**, los tres
  demostrados redundantes y anotados en las rules:
  - `hasAll` — el caso ya documentado en `validFollowEdge`.
  - `'visibility' in searchProfileAfter(uid)` — la igualdad de abajo
    desreferencia una clave ausente, lo que ya revienta y deniega. Quitar **las
    dos** líneas muere; quitar solo la igualdad muere. Se queda porque lo que
    protege es un refactor, no un llamante: el día que `searchProfileAfter`
    gane un `.get('visibility', 'public')`, el error desaparece y el
    público-por-ausencia vuelve en silencio.
  - La misma pareja al revés.

### Verificación en vivo tras el despliegue

Por REST sin cabecera de auth contra `papertok-168df`: `list` de `userSearch`
403, `get` de una entrada 403, `runQuery` de prefijo con `limit` 403, y
`orderBy('createdAt')` 403. Sin mover nada de lo anterior: `list` de
`userProfiles` 403, perfil público 200, `handles/mugar` 200,
`config/moderation` legible, `config/other` 403, `reports` 403.

### Consecuencia en producción hasta que se despliegue la app

Las dos cuentas reales se indexaron durante la verificación de P16. Con la
cláusula de coherencia puesta y el bundle desplegado (que es anterior a F9 y no
escribe el índice), **esas dos cuentas no pueden cambiar su nombre visible ni su
handle desde el sitio en vivo** hasta que la app de F9 aterrice: la entrada se
quedaría rancia y la escritura se deniega en la dirección segura. No poder
ponerse en privado ya pasaba antes de esta fase, por la misma razón. Se arregla
solo con el despliegue de la app que trae la integración.

### Sigue abierto, a propósito

- **Enumerar el índice entero, 20 filas por consulta.** Verificado: 45 cuentas
  en 3 consultas, con `orderBy('handle') + startAfter`, sin prefijo. Las rules
  acotan `request.query.limit` y nada más — ni la forma, ni el `orderBy`. Es la
  contrapartida aceptada en `02-SECURITY.md` §7 y lo que sale es solo handle y
  nombre de gente que eligió ser pública. **La consecuencia operativa es que
  este índice no puede ganar un campo nunca**: una foto o una bio aquí
  convierten una enumeración documentada en el volcado que F1 cerró.
- **El mínimo de 2 caracteres es solo del cliente.** Prefijo vacío y de una
  letra pasan en rules. Controla la factura, no es una defensa.
- **Suplantar por nombre visible sigue siendo posible**: llamarte "Taylor
  Swift" y dejarlo así siempre fue legal, y el perfil público muestra la misma
  mentira. La igualdad nunca impidió la suplantación, solo la divergencia.
- **Liberar tu propio handle sin soltar el perfil.** `handles/{h}` delete solo
  pide que seas el dueño de la reserva, así que un perfil puede seguir
  reclamando un handle que ya no tiene. Es un hueco preexistente de F1; la
  cláusula de coherencia le quita la mitad visible (el índice ya no puede
  derivar), pero cerrarlo del todo es tocar el delete de `handles/`.

## Búsqueda de usuarios — F9 / P16 (2026-08-20)

**Implementado y con las rules ya desplegadas en `papertok-168df`.** Falta
desplegar la app. `list` en `userProfiles/` y `handles/` **sigue cerrado**: la
búsqueda no lo reabre, lee una colección aparte.

### Qué entró

| Pieza | Archivo |
| --- | --- |
| Colección `userSearch/{uid}`: `get` cerrado, `list` con sesión y `limit <= 20`, escritura solo del dueño y coherente con su perfil vía `getAfter` | `firestore.rules` |
| Cláusula a prueba de fallos en `userProfiles/`: toda escritura que deje el perfil privado —y el delete— exige `!existsAfter(userSearch/{uid})` | `firestore.rules` |
| `userSearchService`: dos queries de prefijo acotadas, fusión y dedupe por uid, mínimo 2 caracteres, debounce 400 ms | `src/services/userSearchService.js` (+17 tests) |
| Los cinco caminos de escritura de perfil mantienen el índice en el mismo batch | `src/services/userProfileService.js` |
| Página `/search/users` con filas nombre+handle+monograma | `src/components/Search/UserSearchPage.{jsx,css}` |
| Punto de entrada provisional "Buscar personas en PaperTok" | `src/components/Search/SearchPage.{jsx,css}` |
| Ruta protegida | `src/App.jsx` |
| La copy de privacidad dice que un perfil público aparece en la búsqueda, y que uno privado no | `src/components/Profile/visibilityCopy.js` |

### Dos desvíos del diseño escrito, y por qué

- **La ruta es `/search/users`, no `/search`.** `04-PHASES.md` pedía `/search`,
  pero esa ruta ya es la búsqueda de papers (OpenAlex). Consultado antes de
  tocar nada; la búsqueda de papers no se toca.
- **`.lower()` de las rules es solo ASCII.** Medido contra el emulador, no
  asumido: `"Nicolás MUÑOZ"` baja a `"nicolás muÑoz"` ahí, conservando la Ñ,
  mientras `toLowerCase()` de JavaScript dice `"muñoz"`. Derivar `nameLower`
  de la forma obvia habría hecho fallar la igualdad `nameLower ==
  displayName.lower()` y **dejado sin poder guardar su perfil a cualquier
  cuenta con una mayúscula acentuada en el nombre** — `@nick_mugar` entre
  ellas. `toIndexedName` replica el motor (solo A–Z), y el test de emulador
  ejecuta **la función que se envía** contra **las rules que se despliegan**,
  así que las dos no pueden separarse sin que salte.

  Consecuencia visible, aceptada: el índice guarda solo el nombre en
  minúsculas (es lo que dice `01-DATA-MODEL.md`), así que una fila pinta
  "nicolás muñoz garcía". Y buscar `"ñoño"` no encuentra a "Ñoño", porque su
  `nameLower` empieza por `Ñ`. Si algún día molesta, la salida barata es un
  campo `name` con el `displayName` real y `name == getAfter(...).displayName`
  en rules: no revela nada nuevo — ese nombre ya se sirve por `allow get` del
  perfil — pero se sale del modelo escrito, así que no se ha hecho aquí.

### Lo que las rules imponen (121 tests de emulador, 21 nuevos)

- Un perfil privado **no puede tener documento** en el índice.
- Volverse privado dejando el documento vivo: **denegado**. Salir del índice
  en el mismo batch: permitido. Lo mismo para el delete del perfil y para un
  perfil que nace privado.
- `nameLower` tiene que ser el `displayName` real en minúsculas y el handle el
  handle real, ambos comprobados **después** del batch: nadie se indexa con el
  nombre de otro para colarse en sus búsquedas.
- Sin sesión no se busca. Sin `limit` no se busca. Con `limit(21)` tampoco.
- `get` de un documento suelto: cerrado. Escribir o borrar el de otro: cerrado.

### El presupuesto de expresiones: el tope de pines sigue en 6

Obligatorio re-medirlo y se ha re-medido. **No baja a 5.** Seis pines pasan y
siete siguen fallando con la cláusula nueva puesta, y el peor caso que esta
fase crea —seis pines **y** volverse privado **y** salir del índice en un solo
batch— también pasa. El truco es el cortocircuito: `profileIsPublic(...) ||
!existsAfter(...)`, así que un guardado público normal ni llega a evaluar el
`existsAfter`.

### Pasada de mutación: 17 cláusulas nuevas, 14 muertas, 3 vivas

Las tres supervivientes son **redundantes, no huecos**, y están anotadas como
tales en las rules:

- `hasAll` — lo cubre `hasOnly` más las desreferencias de abajo (una clave que
  falta revienta la evaluación y deniega). El mismo caso ya documentado en
  `validFollowEdge`.
- `validString(handle, 40)` y `validString(nameLower, 80)` — implicados por
  las dos igualdades de coherencia, porque los campos del perfil con los que
  se comparan ya están acotados por `validPublicProfile`. Dejan de ser
  redundantes en cuanto un perfil llegue por un camino que no pase por esas
  cláusulas: la identidad de servicio de F6.

### Costes

- Una búsqueda ejecutada = **2 queries acotadas**, 2–20 lecturas, normalmente
  <6. **Cero lecturas por fila pintada**: nombre y handle viajan en el doc.
- Cada guardado de perfil gana **1 lectura de cliente** (leer el perfil para
  que la entrada cuadre con lo que hay guardado, en vez de fiarse de lo que
  pase el llamante — que es justo lo que se rompe en la secuencia
  `changeUserHandle` → `updateUserProfile`) más ~1 lectura de rules.
- **La carga del feed sigue costando 1 documento.** Test de coste re-ejecutado
  y test estructural ampliado: `userSearchService` se suma a la lista de
  servicios sociales que ningún módulo del camino del feed puede importar.

### Migración: perezosa, y ya probada en vivo

Los perfiles públicos anteriores a la fase no tienen documento de búsqueda.
Cualquier guardado de perfil —incluido tocar el interruptor de privacidad— lo
escribe, porque la rama pública siempre hace `set`. No hace falta backfill: las
dos cuentas reales se indexaron así durante la verificación.

### Verificación en vivo (2026-08-20, panel visible)

Contra las rules desplegadas, con las dos cuentas:

| | |
| --- | --- |
| Buscar por REST **sin cabecera de auth** | **403 PERMISSION_DENIED** |
| Guardar el perfil escribe la entrada del índice (migración perezosa) | sí, en las dos cuentas |
| `@nick_mugar` busca "mug" | encuentra a **@mugar** (la otra cuenta) |
| `@nick_mugar` busca "nicolás" | encuentra por **nombre** — el handle no empieza por ahí |
| `@nick_mugar` busca "nick" | encuentra por **handle** |
| `@mugar` a privado, buscar "mug" | **desaparece de los resultados** |
| `@mugar` de vuelta a público | **vuelve a aparecer** |
| Pulsar una fila | abre el perfil público |
| Fila de resultado | nombre + handle + monograma, **sin foto** |

Las dos cuentas quedan **públicas**, como estaban antes de empezar.

### Qué desplegar

1. **Rules — ya desplegadas** (2026-08-20, `firebase deploy --only
   firestore:rules`). Un solo despliegue: el bloque `userSearch/` es aditivo e
   inerte, y la cláusula nueva de `userProfiles/` no rompe a un bundle
   cacheado — mientras una cuenta no tenga documento de búsqueda,
   `!existsAfter` es verdadero y sus escrituras de siempre pasan tal cual.
2. **La app** (`npm run build` + tu despliegue habitual de GitHub Pages).

El único choque posible sigue siendo una cuenta que ya creó su documento con
el bundle nuevo y guarda en privado desde uno viejo: se deniega en la
dirección segura y se arregla recargando.

### Fuera, a propósito

- **El icono en la Navbar.** `Navbar.jsx` es de la rama del compañero y sigue
  intacto; la entrada vive en la página de búsqueda de papers hasta que esa
  rama aterrice.
- **Prefijo, no substring ni typos.** "muñoz" no encuentra a "Nicolás Muñoz".
  La escalada sin motor externo (`nameTokens` con `array-contains`) está en
  `02-SECURITY.md` §7 y sigue sin hacer falta.
- **El delete de admin no exige salir del índice.** La rama `isAdmin()` del
  delete de perfil sigue sin restricciones, igual que ya pasaba con la reserva
  del handle: un perfil borrado por moderación puede dejar su entrada
  huérfana. Coherente con lo que ya había, y anotado aquí para que no se
  descubra por sorpresa.
- **La frescura en la dirección abierta.** Si un guardado renombrara el
  `displayName` sin tocar el índice, la entrada serviría un nombre rancio. El
  servicio siempre hace las dos cosas en un batch; la dirección que importa
  (privado ⇒ fuera) sí está en rules. Ya estaba decidido en `02-SECURITY.md` §7.

## Login con GitHub — F5 / P9 (2026-08-20)

**Implementado. `firestore.rules` NO se toca: F5 vive entera en Firebase Auth,
así que no hay despliegue de rules ni índices en esta fase.** El proveedor ya
estaba activado en la consola con su OAuth App; lo que faltaba era conectarlo.

Corrección al punto de partida: **no hay login de correo/contraseña en el
repo** (cero referencias a `signInWithEmailAndPassword`). Los métodos de hoy
son Google por popup y navegación como invitado, así que la única colisión
posible es Google↔GitHub.

### Qué entró

| Pieza | Archivo |
| --- | --- |
| `GithubAuthProvider` con scope `user:email` explícito | `src/services/firebase.js` |
| `authIdentityService`: `signInWithProvider`, `linkSignInProvider`, `providerIdsOf`, y tres errores clasificados; inyección de dependencias como el resto de servicios | `src/services/authIdentityService.js` (+21 tests) |
| `signInWithGitHub`, `linkGitHubAccount` y `signInProviders` en el contexto; Google pasa por el mismo camino | `src/context/AuthContext.jsx` |
| Botón "Continuar con GitHub" y el aviso de colisión de correo | `src/components/Auth/LoginPage.{jsx,css}` |
| Sección "Formas de entrar" con "Conectar", y la insignia de la cuenta que ya no dice siempre Google | `src/components/Settings/SettingsPage.{jsx,css}` |
| `AUTH_LINK_FAILED`, `AUTH_EMAIL_ALREADY_USED`, `AUTH_IDENTITY_TAKEN`, `auth/cancelled-popup-request` | `src/utils/errorMessages.js` |

### Decisiones tomadas al implementar (y por qué)

- **Se pide el scope `user:email`.** Sin él GitHub solo entrega el perfil
  público, y una cuenta con el correo en privado llega **sin correo**: una
  identidad sin correo no puede colisionar con nada, así que Firebase acuñaría
  un segundo `uid` en silencio en lugar de lanzar
  `account-exists-with-different-credential`. Es decir: sin el scope, el único
  caso que esta fase existe para atrapar deja de existir. Es de solo lectura.
- **La credencial pendiente NO se guarda.** El patrón habitual es quedarse la
  credencial que viaja en el error de colisión y hacer `linkWithCredential`
  después del login. `03-AUTH.md` pide otra cosa por su nombre —"entra con el
  original y vincula desde ajustes"— y guardar una credencial OAuth viva
  cruzando un cambio de sesión es estado que esta fase no necesita. Hay un test
  estructural que veta `credentialFromError`/`linkWithCredential`, para que
  revisar esa decisión sea un acto deliberado y no un descuido.
- **El mensaje de colisión no nombra al otro proveedor**, y no por prudencia
  sino porque no se puede: el error no dice cuál es, y con la protección contra
  enumeración de correos `fetchSignInMethodsForEmail` tampoco. Dice "usa el
  método que ya tienes", que es verdad y es demostrable. `03-AUTH.md` ya avisaba
  de esto como cuidado verificable; queda verificado por el lado del código.
- **Vincular algo ya vinculado es éxito, no error.** Y si la carrera se pierde
  contra otra pestaña (`provider-already-linked`), también. Pedir algo que ya
  es cierto no es un fallo que enseñar a nadie.
- **La elección de privacidad de P15 no se toca, y por eso se dispara igual.**
  La puerta y el perfil son actos separados: entrar no escribe nada en
  Firestore, y `createUserProfile` sigue exigiendo la elección. Un alta por
  GitHub se encuentra exactamente la misma puerta que una por Google. Está
  fijado con un test estructural doble (el módulo de identidades no importa
  `firebase/firestore` ni sabe qué es `userProfiles`; y el `throw` de
  `createUserProfile` sigue en su sitio) en vez de con un comentario.
- **`signInProviders` es estado, no `user.providerData` leído al pintar**:
  vincular no siempre re-emite un cambio de estado de Auth, y una fila que
  sigue diciendo "Conectar" justo después de conectar es una fila en la que
  nadie vuelve a confiar.

### Costes

**La carga de feed sigue costando 1 lectura.** Nada de F5 entra en su camino
—el test SOURCE de esta fase lo veta en los cinco módulos del feed— y el test
COST sigue verde. Entrar o vincular no añade ninguna lectura de Firestore: son
llamadas a Auth.

### Tests

- **21 nuevos** en `authIdentityService.test.js`: alta nueva por GitHub
  (`isNewUser` → onboarding), login de cuenta existente, Google intacto por el
  mismo camino, colisión de correo con dirección / sin dirección / en el campo
  antiguo, el resto de fallos de popup sin traducir, vinculación correcta,
  ya-vinculado sin popup, carrera perdida, identidad ocupada por sus dos
  códigos, vinculación sin sesión, y los tres estructurales.
- `npm test`: **635**, todos verdes. Lint y build limpios.

### Verificación en vivo (2026-08-20, panel visible)

Hasta donde llega sin autenticarse, que era el trato:

| | |
| --- | --- |
| Botón GitHub en la pantalla de entrada | pintado bajo el de Google, mismo ancho, sin desbordes |
| Pulsarlo | llega a Firebase de verdad: el navegador del panel bloquea el popup y sale `auth/popup-blocked` con su copy localizada; el botón se recupera y no se queda colgado |
| Aviso de colisión | inyectado en el DOM para inspeccionarlo: todas las variables resuelven a valores reales (`--bg-glass`, `--accent-save`, `--radius-lg`), ninguna inventada |
| Móvil (375) | los dos botones apilados, sin scroll horizontal |
| Consola | sin errores nuevos |

**Pendiente de tu sesión** (necesita autenticarse, y eso lo haces tú):

1. Alta nueva por GitHub con una cuenta que no exista en PaperTok → debe caer
   en onboarding, y al crear el perfil público debe pedir la elección de
   privacidad sin preselección.
2. Cerrar sesión y volver a entrar por GitHub → misma cuenta, mismo `uid`.
3. Con @mugar (Google) → Ajustes → Formas de entrar → Conectar GitHub. Después,
   salir y entrar por GitHub: debe abrir @mugar, con sus datos.
4. Colisión: una cuenta de GitHub cuyo correo sea el de una cuenta Google que
   ya exista → debe salir el aviso, no un segundo `uid`. **Este es el que
   confirma la pregunta abierta de `03-AUTH.md`**: si con la protección de
   enumeración activada Firebase no lanza el error y crea la cuenta igual, el
   aviso no aparecerá y habría que replantear (la alternativa sería detectarlo
   ya dentro, comparando el correo). Los tests cubren la rama; lo que no se
   puede probar sin credenciales es cuál de las dos ramas toma Firebase.
5. Google sigue entrando como siempre.

### Fuera, a propósito

- **Borrar la cuenta accidental.** `03-AUTH.md` dice que se puede vincular al
  `uid` bueno "solo si la cuenta accidental está vacía", y eso choca con dos
  cosas que el plan no menciona: desde la cuenta buena **no se puede** mirar si
  la otra está vacía (las rules lo deniegan, y con razón), y liberar la
  identidad de GitHub exige borrar esa cuenta — **PaperTok no tiene borrado de
  cuenta hoy** (cero referencias a `deleteUser`), así que sería construir el
  borrado entero, con su reautenticación y su limpieza de Firestore. Lo que sí
  entró es la mitad honesta: la colisión se detecta, se explica que las dos
  cuentas no se fusionan y se dice que hay que elegir cuál se conserva. La otra
  mitad necesita una fase de borrado de cuenta.
- **Desvincular un proveedor.** No lo pide el plan, y desvincular el último que
  queda deja a alguien fuera de su propia cuenta.
- **Vinculación automática tras el login** (la credencial guardada). Razón
  arriba.

---

## Pasada de fiabilidad — sin fase (2026-08-20)

Trabajo hecho hoy en otras sesiones que se quedó sin anotar aquí para no
chocar con este archivo. El botón de comentarios en el feed **ya estaba
anotado** (sección "Botón de comentarios en el feed", 2026-08-19); lo que
faltaba es esto.

### Respuestas vacías de caché que se hacían pasar por respuestas (`c09b1ad`)

Toda fila de "Me gusta" podía quedarse en "Untitled paper" tras un momento de
mala conexión, y la página no se recuperaba sin recargar. La causa: con el
backend inalcanzable `getDocs` **no rechaza**, resuelve contra la caché en
memoria —que en una página recién cargada está vacía— y devuelve un éxito
vacío con `fromCache: true`. Tratarlo como ausencia confirmada asentaba los 40
ids como definitivos y ya nadie volvía a preguntar. Ahora **una ausencia solo
se asienta si el servidor la confirmó**: `fetchLibraryRecords` devuelve
`{ records, fromCache }`, `pendingIdRequests` suelta lo no autoritativo y
reintenta con backoff exponencial sin rendirse, y la biblioteca personal deja
de latchear `'ready'` sobre una respuesta de caché (que además borraba un
falso "no tienes nada guardado"). Datos en mano sí asientan, vengan de donde
vengan: la caché con datos es datos.

En la misma pasada, las pantallas que se montan y desmontan sin parar (perfil
↔ ajustes, la hoja de comentarios en cada apertura) dejaron de reiniciar desde
esqueleto: siembran de `sessionCache` y revalidan detrás de una vista ya
pintada, con clave por uid o handle para que ninguna cuenta vea la de otra.
Una revalidación fallida deja en pie la vista buena en lugar de sustituirla
por un error.

### Toda espera acotada, y ninguna espera anunciada de más (`4de16c6`)

Las lecturas de Firestore **no tienen timeout de cliente**: contra una conexión
parada —no caída, donde el SDK rechaza al instante, sino abierta y sin
contestar— la promesa no se resuelve nunca, y una pantalla cuyo estado de carga
solo termina en `.then`/`.catch` se queda ahí hasta que recargas.
`withReadTimeout` (`src/utils/boundedRead.js`) la acota, y **un timeout no es
una respuesta**: es fallo reintentable, jamás ausencia confirmada. El esqueleto
de la hoja de comentarios espera 320 ms antes de aparecer (en CSS, sin salir
del DOM, para que `aria-busy` siga diciendo la verdad a un lector de pantalla),
porque el hilo contesta en ~150 ms y casi ningún paper tiene stub: estaba
anunciando una espera ya terminada. La pantalla de perfil ganó el estado de
error que no tenía —un fallo de carga caía en el formulario con todas las ramas
`ready` apagadas— y `null` (no preguntado) dejó de ser lo mismo que `[]`
(preguntado, y no hay).

### Paciencia en lecturas lentas: culpar al servidor solo si falló (`5b5b948`)

La guillotina de 6 s de la pasada anterior convertía una conexión silenciosa en
"no se pudieron cargar los comentarios", tiraba la respuesta tardía y no
reintentaba sola — y el "Reintentar" que funcionaba al instante era la prueba
de que quien se rindió fuimos nosotros, no el SDK. `patientRead` la sustituye:
cada timeout lanza otro intento mientras los anteriores siguen corriendo, gana
el primero que conteste, la interfaz dice "está tardando más de lo normal"
(que es verdad) en vez de "no se pudo cargar" (que no lo era), y cuando todos
han expirado la respuesta tardía **se entrega igual**, así que un parón que
acaba a los nueve segundos cura la hoja a los nueve segundos sin tocar nada.
Los fallos deterministas —permiso denegado, no soportado— siguen fallando al
instante con su copy honesta. El `count()` dejó de bloquear la apertura: es una
insignia de cabecera, y un hilo ya en mano no debe esperar por ella.

### Aire en el perfil y la hoja de comentarios (`5b3ed5c`)

La cabecera del perfil arrancaba pegada a la navbar; ahora baja un paso
completo en los dos breakpoints. La hoja de comentarios compartía una sola
curva para entrar y salir, y su fondo se desvanecía antes que ella (destello
contra la página desnuda): entrada y salida son transiciones distintas, con el
fondo cronometrado para sobrevivir a la hoja.

### Sigue abierto

Nada de esta pasada. Lo que aquí quedaba anotado como abierto —**las cuentas
antiguas no pueden escribir su propio `users/{uid}`**, el bug que encontró
P15— **se arregló y se desplegó el 2026-08-20**: ver la sección
"`users/{uid}` inescribible en cuentas antiguas" más abajo.

---

## Red social — F3 (P5+P6+P7): comentarios en papers (2026-08-19)

**Implementado; rules e índices DESPLEGADOS en `papertok-168df`; verificado en
vivo la parte de visitante y de datos (REST sin auth). La pasada con sesión
(@mugar/@nick_mugar) está pendiente del usuario** — lista de pasos abajo.

### Qué entró

| Pieza | Archivo |
| --- | --- |
| Clave canónica de paper (P5): `doi:` > `arxiv:` sin versión > id crudo con prefijo; base64url; candidatos duales para el split-brain | `src/utils/paperCanonicalKey.js` (+21 tests, puro) |
| Stubs `papers/{paperKey}`: cache mínimo de metadatos, create por el primer comentarista, **inmutable salvo admin**, `list: false` (no hay directorio de papers) | `firestore.rules`, `src/services/paperStubService.js` |
| Comentarios `papers/{key}/comments/{id}` con hilos de un nivel (`replyTo`), editar/borrar propios, borrado de padre en cascada | rules + `src/services/commentService.js` |
| Throttle declarativo `users/{uid}/rateLimits/{action}` (comments 15 s, stubs 30 s, reports 60 s), en el mismo batch, con `getAfter` | rules (match top-level aparte, para no tocar el bloque `users/` que edita la otra sesión) |
| Reportes `reports/{id}` create-only + cola FIFO de admin; killswitch `config/moderation` escribible por admin sin deploy | rules + `src/services/reportService.js` |
| Hoja de comentarios en la página del paper (botón flotante, lazy: 0 lecturas hasta abrirla) | `src/components/Comments/CommentsSheet.{jsx,css}`, `PublicPaperPage.{jsx,css}` |
| "Mis comentarios" en ajustes (collection-group por autor; ahí ve el autor sus ocultos) | `src/components/Settings/MyCommentsPage.{jsx,css}`, fila en `SettingsPage` |
| Cola de moderación en ruta no listada `/admin/moderation` (ocultar/mostrar, borrar con cascada, resolver/descartar, killswitch) | `src/components/Admin/ModerationPage.{jsx,css}`, `App.jsx` |
| Índices: CG `comments (authorUid, createdAt desc)` y `reports (status, createdAt asc)` | `firestore.indexes.json` |

### Decisiones tomadas al implementar (y por qué)

- **Sin contador denormalizado `commentCount`: el recuento es `count()`
  acotado a 1000, el patrón de F2.** El plan (00/01) diseñó un increment ±1
  validado en rules, pero la cascada de borrado lo rompe: borrar padre +
  N respuestas en un batch exigiría validar "decremento exactamente N" y las
  rules no pueden contar los deletes de un batch. Permitir decrementos
  arbitrarios sería deflación libre; hacer N batches de ±1, absurdo. `count()`
  da el mismo número por 1 lectura al abrir la hoja, deja el stub **totalmente
  inmutable** para clientes y no añade superficie de inflado. Es la desviación
  del plan de esta fase; los campos `commentCount`/`annotationCount` del
  boceto simplemente no existen.
- **El punto de entrada fue primero la página del paper** (PaperCard estaba
  vetado por los cambios del compañero). **Superseded en la pasada
  siguiente**: el veto se levantó y el botón vive en la tarjeta — ver la
  sección "Botón de comentarios en el feed" de abajo.
- **Hilos en orden cronológico ascendente, una sola query.** Una respuesta
  siempre es posterior a su padre, así que en orden ascendente el padre ya
  está en pantalla cuando llega la respuesta: cero respuestas huérfanas por
  paginación, cero recuentos por padre, cero índices compuestos para el hilo.
  Responder a una respuesta responde a su hilo (nivel único, estilo TikTok).
- **La cascada**: primer batch = padre + hasta 400 respuestas (atómico); si
  hubiera más, barridos acotados de huérfanos (`!exists(parent)` permite a
  cualquier autenticado rematar). Un corte a mitad deja solo docs invisibles
  (una respuesta jamás se pinta sin su padre) y reintentable. En rules, la
  excepción está acotada: un extraño solo puede borrar una respuesta ajena si
  el padre cae en el mismo batch a manos de su autor.
- **`isAdmin()` ya lleva el uid real de @mugar** (`SrqikE0wbtPOsTZMnvK4lcLVHhD3`,
  resuelto de `handles/mugar`): P7 lo exigía (acción humana 4, hecha). Cambiar
  de cuenta admin = editar esa línea y desplegar. Los tests del emulador leen
  el uid del propio archivo, así que sobreviven al cambio.
- **Ocultos legibles a nivel de datos** (la opción simple que 02-SECURITY.md
  §1 dejaba abierta): el cliente oficial los filtra, el autor los ve marcados
  en "Mis comentarios", y el borrado definitivo es del admin. Hay un test que
  fija la postura para que un cambio futuro no la rompa en silencio.
- **Reportar queda fuera del killswitch y abierto a perfiles privados**
  (reportar no es un acto público; la alarma no se congela con la sala).
  El reportante deja de ver lo reportado en su dispositivo (localStorage,
  acotado a 300).
- **Split-brain**: la hoja lee la clave alternativa (2ª lectura solo si el
  objeto trae DOI+arXiv), fusiona la vista y auto-reporta `dup-stub` una vez
  (id determinista no — auto-id con throttle; el admin fusiona a mano, como
  dice el plan).

### Lo que las rules imponen (93 tests de emulador, todos de comportamiento)

Perfil privado o inexistente no comenta; `authorHandle` debe ser el handle
real del autor (nadie firma con nombre ajeno); nadie escribe/edita/borra
comentarios de otro; el admin solo mueve `status` (no reescribe texto); el
throttle corta de verdad y su ledger ni se borra ni se backdatea (ni en el
create, hueco que encontró la mutación); comentario sin stub no existe;
respuestas a un nivel; queries sin `limit` o por encima de 1000 denegadas
(CG incluido); stub inmutable y coherente con su identidad (doi minúsculas,
arXiv sin versión); reportes create-only con cola solo-admin; killswitch
congela comments+stubs pero no reports; `config/` solo expone `moderation`.

**Pasada de mutación: 41 cláusulas nuevas eliminadas una a una → 40 muertas,
1 superviviente demostrado redundante** (el check de autor del padre en la
cascada: el delete del padre en el mismo batch ya exige a su autor con el
mismo auth). Anotado en las rules como defensa en profundidad, calcando el
precedente del `hasAll` de F2. Dos supervivientes de la primera ronda eran
huecos de test, no de rules (backdate en el create del ledger; reporte sin
sello enmascarado por un helper que siempre sellaba): tests añadidos y ambas
mutaciones ahora mueren. Script en el scratchpad de la sesión, no versionado.

### Costes

| Camino | Lecturas |
| --- | --- |
| **Carga de feed** | **1, sin cambios** — nada de F3 se importa en el camino del feed; el test SOURCE ahora veta `commentService\|paperStubService\|reportService` además de `followUserService`, y el test COST sigue verde |
| Página del paper (sin abrir comentarios) | 0 de Firestore (como antes) |
| Abrir la hoja | 1 stub (+1 si identidad dual) + 1 count + 1 página de 20 + 1 perfil propio (gating del composer; solo autenticado) |
| Publicar comentario | batch de 2 escrituras (4 si estrena stub) + ~4 lecturas de rules (killswitch, perfil, getAfter, existsAfter; +1 en respuestas) |
| "Mis comentarios" / cola admin | 1 query acotada por página |

### Tests

- `npm run test:rules`: **93** (29+4 nuevos F3). `npm test`: **590** (86
  nuevos: clave canónica, stubs, comentarios con cascada, reportes, SOURCE).
- Lint y build limpios.

### Verificación en vivo (2026-08-19) — hecha la mitad sin sesión

Contra las rules **desplegadas** en `papertok-168df`, por REST sin cabecera
de auth: stub get permitido (404 en ausente; el primer intento dio 403 por
propagación de las rules recién liberadas — reintentar antes de alarmarse),
query de comments sin `limit` → 403, con `limit(20)` → pasa, `limit(1001)` →
403, crear stub sin auth → 403, `reports` → 403, `config/moderation` legible
y `config/other` → 403. En el navegador, como visitante: la página del paper
muestra el botón Comments, la hoja abre con contador 0 real de producción,
estado vacío y la puerta "Sign in to join the conversation"; consola sin
`permission-denied` (solo los 429 de OpenAlex de siempre).

**Pendiente de tu sesión (el navegador quedó en el login del server de esta
sesión):**

1. Con @mugar (público): comentar en un paper → estrena stub; responder,
   editar, borrar propio. Al borrar un padre con respuestas de la otra
   cuenta, verificar que se van juntas.
2. Con @nick_mugar: comentar en EL MISMO paper llegado por otra ruta (p. ej.
   uno por el feed/arXiv y otro por su URL con DOI) → mismo hilo.
3. Poner @nick_mugar en privado (Ajustes → Perfil) → la hoja debe mostrar
   "Tu perfil es privado…" con el camino al editor, y el composer no enviar.
4. Reportar un comentario de la otra cuenta (desaparece localmente) y, como
   @mugar, abrir `/admin/moderation`: cola con el reporte, Ocultar (la otra
   cuenta deja de verlo; el autor lo ve marcado en Mis comentarios),
   Mostrar, Borrar, Resolver. Probar el killswitch: congelar → comentar
   falla con el aviso honesto → descongelar.
5. `/settings/comments` con cualquiera de las dos.

**Datos de prueba**: en producción no se creó NADA (todas las escrituras de
verificación fueron denegadas por diseño; la hoja de visitante solo lee).
Lo que crees en la pasada con sesión se borra desde la propia UI (borrar
comentario borra el hilo; el stub que quede huérfano es inerte y solo el
admin puede borrarlo — hazlo desde la consola de Firebase si quieres cero
rastro, colección `papers`).

### Qué desplegar, en qué orden

1. **Rules + índices: YA DESPLEGADOS** (2026-08-19, este chat). Aditivos:
   ningún cliente viejo pierde nada; el índice CG de `comments` nace con la
   colección vacía, sin backfill.
2. **La app** (`npm run build` + push a `main` para GitHub Pages), cuando
   quieras exponer la UI. No hay ventana de incompatibilidad: la UI vieja
   no toca las colecciones nuevas.
3. **FUSIÓN MANUAL de `firestore.rules`: HECHA** (2026-08-20, merge
   `371662c`). La rama `brave-keller-ea1633` traía el arreglo del bug de
   `users/{uid}`. La previsión se cumplió y de más: `firestore.rules` fusionó
   **sin un solo conflicto** —el bloque de F3 vive al final del archivo justo
   para eso, y el match de `rateLimits` es top-level aparte—, así que los
   conflictos reales cayeron en los otros dos archivos, `STATE.md` y
   `tests/firestore.rules.test.js`, donde ambas ramas añadían al final. Se
   resolvieron **conservando los dos lados**, comprobado comparando el
   resultado contra cada padre. Rules re-desplegadas en `papertok-168df` y
   `npm run test:rules` en verde: **98 tests** (93 de F3 + 5 del arreglo).

### Botón de comentarios en el feed (2026-08-19, pasada posterior)

**Hecho y verificado en vivo.** El veto sobre `PaperCard.{jsx,css}` se
levantó (working tree comprobado: limpio, último toque el commit `82764ef`
del compañero), y el botón vive en el carril lateral de la tarjeta, entre
Like y Save, con el estilo de sus hermanos (`pc-side-btn` — **cero CSS
nuevo** en PaperCard).

- **Cómo mantiene el invariante de coste**: PaperCard solo gana una prop
  (`onOpenComments`) y un import puro (`paperCanonicalKey`, para no pintar
  el botón en papers que no pueden anclar hilo). La hoja, sus servicios y
  toda lectura viven en **App.jsx**, que ya alojaba `PDFViewer` y
  `SaveToListModal` por la misma razón: el feed entrega el paper y nada más.
  Ningún servicio social entra en el grafo de módulos del feed — el test
  SOURCE pasa **sin tocarlo**, no debilitado.
- Cableado por prop a los tres feeds (For you, Following, invitado — el
  invitado puede LEER hilos; el composer le pide sesión) y a la tarjeta
  anidada de relacionados.
- `PublicPaperPage` se unifica: fuera la píldora flotante (JSX + CSS), el
  botón del carril abre la hoja que esa página ya alojaba.
- En la hoja, navegar por un @handle ahora cierra la hoja (contrato
  `onNavigate` de FollowSheet), necesaria al ser modal global.
- **Medido en vivo**: `__papertokReads` tras cargar el feed = aggregate 2
  (StrictMode; 1 en prod), interactions 0, library 0 — sin cambios. Nada de
  contadores por tarjeta (R7): el número se cuenta al abrir la hoja.
- **Verificado en vivo con la sesión de @mugar** (sobrevivió en el origen
  `localhost:57212`; hay entrada `papertok-dev-57212` en `.claude/launch.json`
  para reencontrarla): abrir la hoja desde el feed → comentar → cerrar →
  seguir deslizando, sin roturas. El comentario pasó el batch completo
  contra las rules desplegadas y **estrenó el primer stub real**:
  `papers/YXJ4aXY6MjYwOC4xODAzMA` (`arxiv:2608.18030`), clave coherente y
  campos saneados. La query collection-group de producción respondió (el
  índice CG está vivo).
- **Dato de prueba en producción**: el comentario "Probando los comentarios
  desde el feed" de @mugar en ese paper. Se borra desde la propia hoja o
  desde `/settings/comments`; el stub restante es inerte (solo admin puede
  borrarlo, consola de Firebase, colección `papers`).

### Fuera, a propósito

- **Anotaciones (F4/P8)**: siguiente fase; `annotationsFrozen` ya existe en
  el killswitch y el stub no necesita cambios.
- **Digest de reportes por email** (02-SECURITY §3): el cron del Worker
  existe, pero tocar `worker/` no era de esta fase.
- **Insignia "N comentarios" en tarjetas del feed**: sería N lecturas por
  carga de feed, la familia de bug que R7 documenta. El número vive solo en
  la hoja.
- Publicar papers propios: sigue fuera (decisión previa).

## `users/{uid}` inescribible en cuentas antiguas — arreglado (2026-08-19)

**Arreglado en rules, probado contra el emulador y DESPLEGADO en
`papertok-168df` (2026-08-20).** Bug preexistente, encontrado y diagnosticado
durante F8; esta es su resolución. Llegó a `main` por el merge `371662c`.

### El fallo

Los documentos `users/{uid}` creados por una versión temprana llevan `email`,
`displayName`, `photoURL` y `createdAt`. La lista blanca `userProfileKeys()` no
los nombraba, y **todas** las escrituras de la app a ese documento son `merge`,
así que `request.resource.data` es el documento entero ya fusionado: la lista
blanca veía cuatro claves que no conocía y denegaba. Confirmado en producción
sobre `@mugar` con una escritura idempotente (`{ onboardingComplete: true }`):
`permission-denied`.

Se llevaba por delante todo lo que escribe ese documento: `completeOnboarding`,
`updatePreferences`, `updateReadingPreferences`, `updateProfilePhoto` y la
migración de `followedAuthors` de `FollowingContext`.

### La decisión: tolerar las cuatro claves, pero congeladas

| Opción | Por qué |
| --- | --- |
| (a) Meterlas en `userProfileKeys()` y ya | Una línea, pero deja `email`, `displayName` y `photoURL` **escribibles por el cliente** en un documento que se lee como identidad, y permite que documentos nuevos adquieran la forma antigua: la haría permanente en vez de terminal. |
| (b) Migrar los documentos y dejar la lista estrecha | Es el estado final correcto, pero necesita un backfill con identidad de servicio (P10, bloqueado en una acción humana). Mientras tanto ninguna cuenta antigua puede guardar nada. |
| **(c) Tolerarlas y congelarlas** | Desbloquea hoy todas las escrituras, la lista blanca sigue siendo verdad (las cuatro claves se **toleran**, no se escriben) y la forma antigua queda **terminal**: un documento que no las tiene no puede adquirirlas. |

Elegida **(c)**, y no cierra la puerta a (b): un backfill corre con identidad de
servicio, por encima de las rules, y cuando los campos desaparezcan las
cláusulas se quedan inertes solas.

**Congelado** significa: una escritura puede arrastrar los campos con el valor
que ya tienen — que es exactamente lo que hace un `merge` —, pero no puede
**añadir, cambiar ni borrar** ninguno. Borrarlos es trabajo del backfill.

| Archivo | Qué cambió |
| --- | --- |
| `firestore.rules` | `legacyUserKeys()` y `legacyUserFieldsUntouched()`; el `hasOnly` de `users/{uid}` pasa a `userProfileKeys().concat(legacyUserKeys())` |

**Ni una línea de app**: la app dejó de escribir esos cuatro campos hace tiempo
y nadie los lee — `AuthContext` solo mira `onboardingComplete`, `preferences`,
`selectedCategories`, `followedAuthors`, `readingPreferences` y `profilePhoto`.
Los cuatro son copias del registro de Firebase Auth, que sigue siendo la
fuente de verdad.

### Tests

- **98 contra el emulador ya fusionado con F3** (5 nuevos; 66 eran en la rama
  aislada), más el test de F8 que asertaba que el documento padre era
  inescribible, ahora invertido.
- **Pasada de mutación: 5 mutantes, 5 muertos** — quitar el `concat`, quitar la
  llamada a `legacyUserFieldsUntouched()`, forzar a `true` cada una de las dos
  ramas del ternario, e intercambiar las ramas.
- 531 unitarios y lint, sin cambios.

### Cómo se manifestaba en pantalla (revisado, no tocado aquí)

| Camino | Qué veía la persona |
| --- | --- |
| `updatePreferences` (Editar intereses) | **Se lo tragaba**: el estado local ya estaba puesto, el `catch` solo hacía `console.error` y el modal se quedaba abierto sin decir nada. Los intereses parecían guardados hasta recargar. |
| `completeOnboarding` (alta) | **Se lo tragaba a medias**: `console.error` y se queda en el último paso, sin navegar y sin explicar por qué. |
| Migración de `followedAuthors` | `console.warn`. Las aristas nuevas sí se escribían, pero `followingMigratedAt` no, así que la migración se reintentaba entera en cada sesión. |
| Nivel de IA e idioma (Ajustes) | Correctos: `updateReadingPreferences` revierte el estado local y relanza, y la página pinta el error. |
| Foto de perfil | Correcto: revierte y pinta el error. |

Con las rules arregladas ninguno falla ya por este motivo, pero los tres
primeros **seguirían tragándose cualquier otro fallo de escritura**. Trabajo
aparte.

### Qué desplegar

**Ya desplegado** (`firebase deploy --only firestore:rules`, 2026-08-20, sobre
`papertok-168df`, con la fusión de F3 dentro). **No necesitó despliegue de
app**: ningún cliente, viejo o nuevo, cambia de comportamiento salvo dejando de
recibir `permission-denied`.

Comprobado por REST sin auth que la fusión llegó entera a producción: `papers`
por id 200 y `list` 403, `reports` 403, `config/moderation` legible y
`config/other` 403 — es decir, F3 sigue vivo bajo las rules nuevas.

**Pendiente de tu sesión** (necesita entrar con una cuenta de las antiguas, y
esa autenticación es tuya): con `@mugar`, Ajustes → **Editar intereses** →
guardar. Antes se lo tragaba en silencio; ahora debe persistir tras recargar.

## Privacidad del perfil — F8 / P15 (2026-08-19)

**Implementado, fase 1 de rules desplegada, verificado en vivo.** Fase escrita
en `docs/plan/04-PHASES.md` como P15; no existía en el plan original, que daba
por hecho que todo perfil es público.

### Las cuatro decisiones, y por qué

| Pregunta | Decisión | Razón |
| --- | --- | --- |
| ¿El handle de un perfil privado sigue reservado? | **Sí**, y nadie más puede pedirlo | Volverse privado es reversible; si el handle se liberase, alguien podría cogerlo mientras estás fuera y el interruptor dejaría de tener vuelta. Un interruptor sin vuelta no es un interruptor. |
| ¿Qué ve quien abre `/public/user/:handle` de un perfil privado? | **"Este perfil no está disponible"**, idéntico a un handle que no existe | Mínima revelación y cero texto nuevo. Verificado: la salida es la misma palabra por palabra en ambos casos. |
| ¿Y los enlaces ya compartidos de listas publicadas? | **Siguen funcionando** | Publicar una lista es un acto propio con su control en Mis listas. `publicLists` es anónimo por diseño de F1: ser privado quita la **atribución**, no la lista. |
| ¿Se puede seguir a un perfil privado? | **No se crean aristas nuevas; las que había se conservan** | Borrarlas sería destructivo e irreversible. Dejar de seguir sigue abierto siempre: hay que poder salir. |

**No hay nivel "solo seguidores"**, y no por esfuerzo: seguir es unilateral e
instantáneo, así que ese nivel sería "todo el mundo con un clic de más" hasta
que exista aprobación de solicitudes, que es otra fase.

### Lo que ser privado NO cubre — dicho en pantalla, antes de elegir

Tres cosas, en el propio flujo de elección y en Ajustes: las listas ya
publicadas siguen accesibles por su enlace, el handle sigue reservado (lo que
implica que se puede saber que existe), y el número de seguidores se puede
seguir contando. Los tres están **asertados contra el emulador**
(`F8: what going private does NOT hide`) para que el texto no se convierta en
mentira si alguien cambia las rules más adelante.

### El modelo

`visibility: 'public' | 'private'` en `userProfiles/{uid}`, string y no
booleano porque **la ausencia del campo es portante**: un documento escrito
antes de esta fase no lo tiene y debe seguir leyéndose como público. Un
booleano ausente se lee `false` y habría puesto en privado a todo el mundo sin
preguntar, que es justo lo que esta fase existe para evitar.

| Archivo | Qué cambió |
| --- | --- |
| `firestore.rules` | `allow get` de `userProfiles` acotado a `profileIsPublic(resource.data) \|\| dueño`; `visibility` y `showPinnedLists` validados; `follows` exige destino público al crear; **nueva subcolección** `users/{uid}/profileStash/{id}`, owner-only y de forma cerrada |
| `src/services/userProfileService.js` | `PROFILE_VISIBILITY`, `isVisibilityChoice`, `profileIsPublic`, `needsVisibilityChoice`, `pinnedListsAreVisible`, `saveProfileVisibility`, `setPinnedListsVisible`; `createUserProfile` **exige** la elección; `readUserProfileByHandle` traduce `permission-denied` a "no existe" |
| `src/components/Profile/VisibilityChoice.{jsx,css}` + `visibilityCopy.js` | La elección, sin nada preseleccionado, con las tres limitaciones a la vista |
| `src/components/Profile/VisibilityPrompt.{jsx,css}` | La pregunta única para cuentas que ya existían |
| `src/components/Profile/ProfilePage.jsx` | Elección en el alta; dos interruptores en Privacidad que guardan al instante |
| `src/components/Public/PublicProfilePage.{jsx,css}` | Insignia "Privado" y aviso, solo para el dueño; el prompt |

**Los interruptores guardan al momento**, sin pasar por "Guardar cambios": un
control de privacidad que necesita una confirmación aparte es un control que
la gente cree que ya ha usado.

### Ocultar listas fijadas saca las entradas, no las tapa

Firestore **no tiene seguridad por campo**: si el documento se lee, se leen
todos sus campos. Así que "listas fijadas: no" no puede ser un flag que la UI
respete — el array sale del documento público y espera en
`users/{uid}/profileStash/pinnedLists`, owner-only, en el mismo batch. Vuelve
intacto al encender. `showPinnedLists` existe para que "no tengo pines" y
"los tengo ocultos" no sean el mismo estado al recargar.

**Por qué una subcolección y no un campo en `users/{uid}`**: porque ese
documento **no se puede escribir** en las cuentas antiguas. Ver el bug de
abajo.

### Verificación en vivo (2026-08-19)

Contra las rules desplegadas en `papertok-168df`:

| | |
| --- | --- |
| Perfil privado por REST **sin cabecera de auth** | **403 PERMISSION_DENIED** |
| `handles/mugar` sin auth | 200 (no protegido, documentado) |
| Perfil público de otra cuenta | 200 (nada roto) |
| Página del perfil privado, sin sesión | "This profile is not available", **idéntico** a un handle inexistente |
| El mismo privado a través de la hoja de seguidores de otro | fila "Account unavailable", sin filtrar nombre ni handle |
| `users/{uid}/profileStash/pinnedLists` sin auth | 403 |
| Ciclo privado → público → privado | funciona en ambos sentidos, `visibility` cuadra en el doc |
| Ocultar y volver a mostrar pines | los pines vuelven intactos desde el guardado privado |
| Prompt en cuenta con perfil heredado | aparece, sin preselección, con el botón deshabilitado hasta elegir |
| Coste del feed | sin cambios (nada de esto entra en su camino) |

**Pendiente de tu sesión**: la lectura denegada **desde otra cuenta con
sesión**. Está cubierta por el emulador con un contexto autenticado real
(`F8: a private profile is unreadable to another signed-in account`), pero en
vivo hace falta iniciar sesión como `@nick_mugar`. A propósito he dejado
`@nick_mugar` **sin elegir todavía**, así que al entrar con esa cuenta verás
el prompt de migración tal cual lo verá cualquier usuario existente.

`@mugar` quedó **público**, que es como estaba antes de empezar.

### Tests

- **61 contra el emulador** (14 nuevos), de comportamiento.
- **531 unitarios**.
- **Pasada de mutación: 14 cláusulas nuevas, 14 muertas.** Una sobrevivió al
  primer intento (la lista blanca de claves del guardado privado): el test
  colaba una clave extra en un documento que ya era inválido por otro motivo,
  así que otra cláusula lo denegaba y la mutación no se notaba. El test ahora
  cuela la clave en un documento **por lo demás válido**, que es la única
  forma de que esa cláusula sea la que decide.

### Bug preexistente encontrado (no de esta fase, no arreglado aquí)

**Las cuentas antiguas no pueden escribir su propio `users/{uid}`.** Los
documentos creados por una versión temprana llevan `email`, `displayName`,
`photoURL` y `createdAt`, y la lista blanca `userProfileKeys()` de las rules no
los incluye; como todas las escrituras son `merge`, la lista blanca ve el
documento entero resultante y deniega. Confirmado en producción con una
escritura idempotente: `permission-denied`.

Afecta a preferencias, nivel de IA, foto de perfil y la migración de
seguimientos — conviene revisar si alguno lo traga en silencio. Hay una tarea
aparte con el diagnóstico y tres opciones de arreglo. Esta fase **no lo
arregla ni lo esquiva a medias**: guarda los pines en una subcolección, que no
depende de esa lista blanca. Hay un test que asertaba que el documento padre
era inescribible, para que el arreglo se notase ahí también — y así fue:
**arreglado**, ver la sección de arriba.

### Qué desplegar, en este orden

1. **Rules, fase 1** — `git checkout dbf141b -- firestore.rules` no hace falta:
   **ya está desplegada** (2026-08-19). Permite el campo, impone la lectura y
   valida; un cliente viejo sigue pudiendo crear perfiles.
2. **La app** (`npm run build` + tu despliegue habitual de GitHub Pages).
3. **Rules, fase 2** — `firebase deploy --only firestore:rules` desde `HEAD`,
   que ya lleva el `'visibility' in request.resource.data` del create. **No
   antes del paso 2**: un bundle cacheado que cree un perfil sin el campo sería
   rechazado. Ese es todo el motivo de que sean dos despliegues.

### Fuera, a propósito

- Nivel "solo seguidores" y solicitudes de seguimiento (razón arriba).
- Cerrar `handles/{handle}` para privados: exigiría denormalizar la
  visibilidad en el doc de handle y mantener dos documentos en sincronía, que
  es justo donde un bug rompe la unicidad. Y "está cogido" se sabe igual
  intentando registrarlo.
- Ocultar el grafo de seguidores de un perfil privado: costaría un `get()` por
  fila en una query de lista. Las aristas guardan solo uids.
- Arreglar el bug de `users/{uid}`: era tarea aparte y **ya está hecha**, en
  la sección de arriba.

## Rediseño integral de perfil y ajustes — séptima pasada (2026-08-19)

**Hecho y verificado en vivo** con las dos cuentas (`@mugar` / `@nick_mugar`),
en escritorio (800/1280) y móvil (375), en dev y, para la vista de visitante
anónimo, contra el build servido desde un origen limpio (`vite preview`, sin
sesión de Firebase). 524 tests verdes, lint y build limpios.

### El bug que iba primero (commit aislado `5b7afee`)

Los títulos de Me gusta morían si se cambiaba de pestaña antes de aterrizar
`fetchLibraryRecords`: los ids se marcaban como pedidos **antes** del fetch,
el cleanup del efecto descartaba la respuesta al cambiar `activeTab`, y no
había reintento — 40 × "Paper sin título" hasta recargar. 100 % reproducible
(Me gusta → otra pestaña en <1 s → volver). Fix de raíz: la respuesta se
fusiona siempre (la caché `likedExtra` es por id, idempotente; setState tras
unmount es no-op) y un batch fallido des-marca sus ids para que la siguiente
activación reintente. Commit propio ANTES del rediseño; la secuencia exacta
se verificó antes (40/40 sin título) y después (0/40), y otra vez sobre la
página ya rediseñada.

### La semántica que cambia: los contadores de cabecera cuentan usuarios

La cabecera decía *Siguiendo* = entidades del feed (privado) con el botón
*Siguiendo* = usuarios al lado: misma palabra, dos grafos. Ahora los tres
contadores del dueño son **Siguiendo (usuarios) / Seguidores / Me gusta** —
Siguiendo sale de `countFollowedUsers`, la agregación pública que la hoja ya
pedía, así que **cero lecturas nuevas** (y en vista de dueño se ahorra el
`isFollowing` contra uno mismo que antes sí se pedía). Las **entidades**
tienen su propia puerta etiquetada: chip "Contenido seguido · N" →
`/settings/following`, solo dueño. En perfil ajeno ya no hay guiones "—":
se ven Siguiendo y Seguidores **reales** (el grafo es público por diseño de
F2) y Me gusta simplemente no está — dos stats, composición completa, sin
huecos. La hoja vuelve a decir "Siguiendo": el renombrado "Usuarios seguidos"
de la pasada F2 quedó superseded (ya no colisiona con nada y en móvil se
partía en dos líneas).

### El resto del rediseño

| Cambio | Dónde |
| --- | --- |
| Navbar con sesión también en `/public/user/*` (como ya hacía `/public/paper/*`); el eyebrow "PAPERTOK · PUBLIC PROFILE" queda solo para visitantes sin sesión | `App.jsx`; clase `--app` por `hasAppChrome` en la página |
| Títulos de filas con `ScientificText` (el mismo KaTeX del feed) + saneado al pintar | `PublicProfilePage.jsx` + `src/utils/paperText.js` (+6 tests) |
| Botón Seguir: hover/focus cambian etiqueta y color **juntos** ("Dejar de seguir" en rojo) vía clase de estado, no `:hover`; tras pulsar Seguir descansa en "Siguiendo" neutro aunque el puntero siga encima | `PublicProfilePage.{jsx,css}` |
| Perfil ajeno: heading "Listas fijadas" en vez de tab-bar de un solo tab; fuera el CTA "Ir a mis listas" con sesión (la Navbar ya da la vuelta); el CTA de login queda solo sin sesión | ídem |
| Estados vacíos icono+título+hint (el patrón de FollowingSettingsPage) en las tres pestañas y en la hoja | ídem + `FollowSheet.jsx` |
| Skeleton completo (cabecera+stats+tab bar+filas) y filas fantasma al cargar pestañas | ídem |
| Móvil: cabecera retrato centrada (avatar 88 px, stats en columnas centradas, acciones centradas), no el escritorio estirado de antes | `PublicProfilePage.css` |
| Hoja: **altura fija por breakpoint** (cambiar de pestaña ya no salta ni re-centra), bottom-sheet real en móvil (muelle desde el borde) y scale-fade en escritorio, trampa de foco (Tab cicla dentro), pills de recuento, esqueleto de filas | `FollowSheet.{jsx,css}` |
| Stagger sobrio de filas/tarjetas (delay con tope 0,22 s); `prefers-reduced-motion` en todas las piezas | ambos |
| Ajustes: fila Perfil público → "**Editar**" (era "Ver todo"), chips de seguimiento a 0 ocultos, tarjetas de nivel IA alineadas arriba, toggle de analítica a ancho completo en ≤520 px, `<title>` propio reactivo al idioma | `SettingsPage.{jsx,css}` |
| Editor: `<title>` propio y entrada suave | `ProfilePage.{jsx,css}` |
| El `a:hover` morado global neutralizado en tarjetas/filas del perfil (el feedback ahí es borde+elevación) | `PublicProfilePage.css` |
| Entrada `papertok-preview` (vite preview) para auditar la vista sin sesión desde un origen limpio | `.claude/launch.json` |

### Privacidad re-verificada (2026-08-19)

- REST sin auth contra prod: `userProfiles/{uid}` expone solo campos
  públicos; `users/{uid}` y subcolecciones → 403.
- Visual sin sesión (origen limpio, build): cabecera pública + Listas
  fijadas + contadores del grafo público, nada más — sin Guardados, sin
  Me gusta, sin engranaje, sin editar. Follow sin sesión → prompt de auth,
  cero escrituras. La hoja funciona sin sesión (lecturas públicas acotadas).
- `resolveProfileView` intacto; los efectos de dueño siguen detrás de
  `view.isOwner`.
- Feed tras el rediseño, medido en vivo: `__papertokReads` = aggregate 2
  (doble montaje de StrictMode; 1 en prod), interactions 0, library 0.

### Deuda de datos anotada (no tocada, a propósito — amplía R8)

Documentos de `interactions` con títulos que llevan HTML literal
(`La <sub>2</sub> CuO <sub>4</sub>`) y autores en formato "Apellido, I.".
**No se reescriben los documentos**: el saneado es solo de presentación
(`src/utils/paperText.js`: sub/sup numéricos → Unicode ₂/², tags fuera,
"Do, T." → "T. Do" solo con iniciales inequívocas). La migración real de esos
docs queda pendiente y pertenece al mismo lote que R8 (ids de interacción no
canónicos).

### Notas de esta pasada

- Los clics del panel del navegador se cuelgan en emulación móvil y se
  pierden con viewport redimensionado a 1280: la verificación móvil/ancha fue
  con capturas + `.click()` sintético (dispara React; el router no, como ya
  documenta la memoria de la sesión).
- "Research" sigue sin traducir en la Navbar española — Navbar fuera del
  encargo y con riesgo de conflicto con la rama del compañero.
- El idioma de la cuenta quedó devuelto a inglés, como estaba al empezar.
- `SettingsPage.css` conserva sus colores/px hardcodeados (no está en el
  test de tokens); solo se tocó lo que la auditoría señaló.

### Choques con el rediseño del compañero

`PaperCard.{jsx,css}` y `Navbar.jsx` intactos. El riesgo de conflicto se
concentra ahora en `PublicProfilePage.{jsx,css}` y `FollowSheet.{jsx,css}`,
reescritos enteros en esta pasada.

## Perfil unificado estilo TikTok — hecho, pendiente de pasada con sesión (2026-08-19)

Una sola página de perfil para el dueño y para los visitantes, con el
contenido decidido por quién mira (`resolveProfileView`, puro y con tests).
Dos rutas la renderizan: `/public/user/:handle` (la URL compartible de F1, sin
cambios de contrato) y la nueva `/profile` (propia, tras ProtectedRoute, sale
en la Navbar y renderiza incluso sin perfil público creado, con CTA al editor).

| Archivo | Qué cambió |
| --- | --- |
| `src/components/Public/PublicProfilePage.{jsx,css}` | Ahora es LA página de perfil: cabecera con contadores, engranaje (→ `/settings`) y "Editar perfil" (→ `/settings/profile`) solo del dueño; pestañas Listas/Guardados/Me gusta. Conserva skeleton, estados de error, metadata y la animación de entrada. |
| `src/utils/profileAccess.{js,test.js}` | El gating dueño/visitante como función pura. Visitante = solo pestaña Listas. |
| `src/services/userProfileService.js` (+tests) | `readOwnLists()`: todas las listas propias, una página `limit(60)` sin `orderBy` (para no perder docs sin `createdAt`), orden en cliente, insignia `isPublished`. Pasa el test SOURCE de límites. |
| `src/context/FeedContext.jsx` | +6 líneas: `getCuratedInteractionIds(name)` expone los ids curados del agregado en orden de recencia. Solo memoria, cero lecturas. |
| `src/components/Layout/Navbar.jsx` | La foto navega **síncrono** a `/profile` (el navigate asíncrono se atasca con `AnimatePresence mode="wait"`). El desplegable entero desaparecido: Ajustes y Cerrar sesión ya vivían en SettingsPage (engranaje), "Mis listas" ahora es enlace "Gestionar" en la pestaña Listas. |
| `src/App.jsx` | Ruta `/profile` + entrada en `navbarRoutes`. |
| `src/components/Profile/ProfilePage.jsx` | Solo el botón volver: ahora → `/profile` (su padre natural). El editor sigue en `/settings/profile`. |
| `vite.config.js` | El server respeta `process.env.PORT` (dos sesiones de dev a la vez); sin PORT sigue siendo 5173. |
| `src/utils/myProfileRoute.{js,test.js}` | **Borrados**: la entrada de menú que resolvía el destino por lectura quedó superseded por la ruta fija `/profile`. |

**Contadores** (cabecera, estilo TikTok): *Siguiendo* = `followedEntities.length`
del FollowingContext (los autores/temas/instituciones de `users/{uid}/following`,
ya en memoria); *Seguidores* = 0 fijo, hueco listo para F2/P4, sin funcionalidad;
*Me gusta* = `likedPaperIds.size` del agregado de interacciones vía FeedContext.
En perfil ajeno, Siguiendo y Me gusta muestran "—": son datos privados
(`users/{uid}/*` es owner-only) y exponerlos exigiría tocar rules, que estaba
explícitamente fuera. Cero lecturas extra en los tres.

**Pestañas y costes**: Listas propias = 1 query acotada; Listas ajenas = las
`pinnedLists` del doc público (0 extra, como F1). Guardados = `personalLibrary`
readLater vía `ensurePersonalLibrary()` (acotado, ya existía). Me gusta = ids
curados del agregado (recencia) + `fetchLibraryRecords` solo de los ≤60 que se
pintan y solo al abrir la pestaña. El feed no cambia: `grep userProfileService
src/context src/components/Feed` sigue vacío y el test de coste sigue verde.

**Verificado** (2026-08-19): `npm test` 482 verdes (incluye los nuevos), lint,
build. En vivo sin auth contra prod: `/public/user/mugar` renderiza la vista
de visitante exacta (— / 0 / — , solo pestaña Listas con la lista fijada, sin
engranaje/editar); `/profile` sin sesión redirige a login. Por REST sin auth:
`userProfiles/{uid}` expone solo los campos públicos, y `users/{uid}`,
`users/{uid}/lists`, `users/{uid}/interactions`, `users/{uid}/following` y el
agregado devuelven todos `PERMISSION_DENIED` — guardados, likes y listas no
publicadas de otro son ilegibles a nivel de datos, no solo de UI.

**Pendiente de humano**: pasada con sesión iniciada (vista de dueño: contadores
reales, tres pestañas, engranaje, editar, foto de Navbar → perfil). Los clics
sintéticos no disparan el router en este entorno, así que la navegación por
clic real la prueba el usuario. La pestaña del navegador quedó en el login del
server de esta sesión.

**Fuera a propósito**: seguir usuarios y contador real de seguidores (F2/P4);
la pseudo-lista "Leídos" no tiene pestaña (sigue en `/lists`); las tarjetas de
lista propias llevan a `/lists` sin deep-link a la lista concreta (ListsPage no
tiene selección por URL); en modo demo `/profile` muestra el estado
"unsupported", como todo lo de perfiles desde F1; miniaturas tipo TikTok en las
pestañas (los docs de interacción no guardan imagen).

**Choques con el rediseño del compañero**: `PaperCard.{jsx,css}` intactos (sus
cambios sin commitear siguen tal cual). `Navbar.css` no se tocó: los estilos
del desplegable quedan muertos en CSS — borrarlos cuando su rama aterrice, no
antes. Si su rama toca `Navbar.jsx`, el conflicto es seguro: avisar antes de
fusionar.

### Segunda pasada (2026-08-19): privacidad, navegación y compartir

Verificada **en vivo con sesión del dueño** (el usuario inició sesión en el
navegador de la sesión): vista de dueño en `/profile` y en la URL pública,
pestañas Guardados/Me gusta con contenido real (títulos por `fetchLibraryRecords`
en orden de recencia), navegación por clic real (los clics del panel del
navegador son eventos confiables; la limitación de F1 era solo para eventos
sintéticos de JS).

| Cambio | Dónde |
| --- | --- |
| Editor rediseñado en secciones: Identidad pública / **Privacidad** / Listas fijadas / **Despublicar** | `ProfilePage.{jsx,css}` |
| Resumen de privacidad (qué es público vs qué nunca) + interruptor **"Mostrar mi foto de cuenta"**: controla si el doc público lleva `photo`; apagarlo borra el campo al guardar (`savePublicProfilePhoto(null)`, el update solo no lo elimina porque la sanitización descarta el vacío) | `ProfilePage.jsx` |
| **Despublicar perfil**: `deleteOwnUserProfile()` borra `userProfiles/{uid}` + `handles/{handle}` en un batch — la forma exacta que exigen las rules (endurecimiento C). Las listas publicadas quedan publicadas y anónimas. Sin tocar rules. | `userProfileService.js` (+3 tests) |
| Botón atrás con historial (`location.key !== 'default'` → `navigate(-1)`): perfil → Siguiendo → atrás vuelve al **perfil**, no a ajustes (bug reportado); mismo arreglo en el editor | `FollowingSettingsPage.jsx`, `ProfilePage.jsx` |
| Tarjeta de lista propia en el perfil → abre **la lista en sí**: `navigate('/lists', {state:{openListId}})` y ListsPage la expande al llegar (una vez por id; el estado sobrevive en la entrada de historial a propósito) | `PublicProfilePage.jsx`, `ListsPage.jsx` |
| "Copy link" → **"Share"** con hoja nativa (`navigator.share`) y fallback a portapapeles; hoja cerrada = silencio, no error; "Publicar y copiar enlace" → "Publicar y compartir" | `ListsPage.jsx`, `src/utils/shareLink.js` (+6 tests) |

`shareOrCopyLink` vive en `src/utils/shareLink.js` con inyección del share
nativo y del copy, por el detalle de que la activación transitoria puede
caducar durante el await de publicar (la hoja tira `NotAllowedError` y se cae
al portapapeles).

**Pendiente de humano (esta pasada)**: probar la hoja nativa de compartir en
un móvil real (en desktop cae a portapapeles o abre la hoja del sistema) y el
flujo completo de **Despublicar perfil** (no se ejecutó en vivo: habría borrado
el perfil real; el batch está cubierto por tests y calca las rules).

491 tests verdes, lint y build limpios. El test de tokens CSS cubre los dos
stylesheets tocados.

### Tercera pasada (2026-08-19): papers likeados resilientes, volver contextual, animaciones

Todo verificado en vivo con la sesión del dueño.

- **Los papers likeados ya no mueren con el rate limit de arXiv.** El bug: la
  página pública del paper siempre re-descargaba de la red (`id_list` de arXiv
  + enriquecido OpenAlex) aunque la app ya tuviera el paper en memoria, y un
  **429 de arXiv** la dejaba en "The paper could not be loaded" — con 40 likes
  y el feed compartiendo cuota, pasaba siempre. Ahora las filas del perfil
  entregan su copia por `location.state.paper`, `PublicPaperPage` la adapta
  (`paperLegacyAdapter`), la **ancla a la URL** (`encodePaperKey(semilla) ===
  paperKey`, para que un estado rancio no disfrace un paper de otro) y pinta al
  instante; la red queda como mejora opcional que ya no puede degradar a error
  lo que está en pantalla. Verificado con arXiv devolviendo 429 en vivo: la
  tarjeta sale completa (abstract "unavailable" hasta que la red vuelva). Los
  stubs solo se siembran para ids con forma de arXiv — el adaptador legacy
  fabricaría enlaces PDF rotos para cualquier otra cosa.
- **Volver desde una lista abierta del perfil vuelve al perfil.** `ListsPage`
  distingue si la lista expandida llegó por `openListId` (`openedFromRoute`):
  el control pasa a "← Volver" y hace `navigate(-1)` en vez de plegar al
  índice de Mis listas; abrir una lista desde el índice restaura el
  comportamiento clásico.
- **Animaciones de pestañas.** Indicador que se desliza entre pestañas
  (`layoutId` compartido, muelle 500/40) y panel único con
  `AnimatePresence mode="wait"` (fundido+desplazamiento 160 ms). Con
  `prefers-reduced-motion`: solo opacidad y sin muelle.

Detalle conocido (deuda R8, no de esta pasada): algún título likeado llega con
`<sub>` literal en el texto (metadatos de origen sin limpiar) y el corazón de
la página del paper no se rellena si el id de la interacción no coincide con
el canónico del adaptador.

### Cuarta pasada (2026-08-19): la página del paper es parte de la app

- **Cabecera**: con sesión, `/public/paper/*` mantiene la Navbar de la app
  (predicado `startsWith` en `App.jsx`; los visitantes sin sesión conservan la
  página autónoma con su mini-cabecera). La página añade solo un botón de
  volver flotante bajo la Navbar. Verificado en vivo: abrir un like se ve como
  el feed, no como la vista de invitado.
- **Abstract bajo rate limit**: `loadPaper` ya no depende solo de arXiv — si
  el `id_list` falla o vuelve vacío, cae a
  `fetchPaperByArxivIdViaOpenAlex()` (nuevo en `openAlexService`, mismo filtro
  de landing-page que el enriquecido, pero con abstract reconstruido del
  `abstract_inverted_index`), con `pdfUrl` derivado del id de arXiv pedido.
  Verificado en vivo **con arXiv devolviendo 429**: la página cargó completa
  con abstract vía OpenAlex; al levantarse el ban, la vía arXiv volvió sola
  (y con id canónico coincidente, el corazón de Like sale relleno).
- **"No me deja leer el paper"**: era el mismo ban de arXiv por IP (429),
  ganado a pulso en dev entre el feed y las recargas de verificación; el visor
  es un `<iframe>` directo a `arxiv.org/pdf/...` (el mismo del feed de
  siempre) y la URL quedó verificada sana por curl (200 `application/pdf`).
  El navegador empotrado de la sesión no renderiza PDFs en iframes
  (limitación de herramienta), así que la comprobación final del visor es del
  usuario en su navegador. El botón "New tab" del visor abre el PDF fuera en
  cualquier caso.

### Quinta pasada (2026-08-19): la tarjeta como destino, y que se note

- **Un paper de una lista abre su tarjeta, no el PDF.** `openPaperCard()` en
  `ListsPage` navega a `/public/paper/{key}` con el paper como semilla (el PDF
  sigue a un clic, en "Read article" de la propia tarjeta). Sin clave canónica
  cae al visor de PDF, para que el clic nunca quede muerto.
- **Volver desde esa tarjeta restaura la lista abierta**, no el índice: antes
  de salir se re-sella la entrada de historial con `{openListId, fromRoute}`, y
  `fromRoute` viaja para que el "volver" de la lista siga apuntando a donde
  apuntaba. Cerrar la lista limpia el sello.
- **Reconstrucción progresiva del paper**: la tarjeta entra con fundido y
  desplazamiento (0,45 s) y, cuando la copia sembrada se convierte en el paper
  completo, cruza un disolvido de 0,6 s en vez de aparecer de golpe. Solo
  opacidad en ese segundo tiempo: una `transform` ahí se convertiría en bloque
  contenedor de las hojas `position: fixed` de la propia tarjeta.

**Tres fallos encontrados y arreglados durante la verificación en vivo**, los
tres invisibles en tests y visibles solo pulsando:

1. La restauración no funcionaba para Favoritos / Leer después / Historial: el
   efecto buscaba en `lists` (solo las de Firestore) y esas tres se ensamblan
   en `displayLists`.
2. Corregido eso, seguía sin abrir: el efecto marcaba la lista como "ya
   abierta" **antes** del `setTimeout`, así que la primera rehidratación de
   contexto cancelaba el timer y el reintento se auto-rechazaba. La marca se
   pone ahora dentro del callback, cuando la apertura ocurre de verdad.
3. En la animación: si el paper completo llegaba antes de que acabara la
   entrada (caso caché), el segundo `start` cancelaba el primero y la tarjeta
   quedaba congelada 12 px desplazada. Ambos `start` fijan ahora `y: 0`.

### Sexta pasada (2026-08-19): esqueleto en lugar de pantalla negra

Cuando la página del paper no tiene semilla que pintar (un like cuyo título
aún no ha llegado, un DOI, o una URL abierta en frío), el estado de carga era
un spinner diminuto sobre negro. Ahora usa **`SkeletonCard`**, el mismo
esqueleto que el feed ya emplea: misma silueta que la tarjeta que viene
—pastillas de metadatos, título, autores, texto y botones— con su shimmer, y
ya trae su propia guarda de `prefers-reduced-motion`. Quitado el spinner muerto
(`.public-paper-spinner`, su keyframe y su regla de reduced-motion).

**Primer intento fallido, y por qué**: el esqueleto se ató solo a
`status === 'loading'`, y ese estado no se da nunca al abrir un like — la
semilla marca la página como lista al instante. El negro que se veía no era
la espera de red sino **el revelado de la tarjeta**: la entrada estaba
gobernada por `useAnimationControls`, y un `start()` que no encuentra su
elemento montado deja la tarjeta parada en su `initial` (opacidad 0) hasta
que otra animación la rescata — justo el segundo o dos que duraba el negro.

Arreglado en dos frentes:

1. **Animación declarativa**: `variants` + `animate` en lugar de controles
   imperativos, así no hay `start()` que pueda perder su enlace. La fase se
   deriva sin refs (`hasCurrentResult && seededPaper` ⇒ disolvido; si no,
   entrada normal).
2. **El esqueleto cubre el revelado, no solo la red**: se pinta por encima
   (`position: absolute; inset: 0; z-index: 800; pointer-events: none`) desde
   el primer fotograma y se retira con un fundido de 0,3 s cuando la tarjeta
   ha terminado de entrar (`onAnimationComplete`, con temporizador de 1,2 s
   como red de seguridad). Sea cual sea la causa de una demora futura, no
   puede volver a verse como pantalla vacía.

Verificado en vivo en el caso exacto reportado (perfil → Me gusta → clic):
capturados los tres fotogramas — esqueleto, disolvido sobre la tarjeta
emergiendo, y tarjeta completa.

## Red social — F2 (P4): seguimiento entre usuarios (2026-08-19)

**Implementado, desplegado y verificado en vivo con dos cuentas reales**
(`@mugar` y `@nick_mugar`) el 2026-08-19. Rules e índices en `papertok-168df`.

### El modelo

`follows/{followerUid}_{targetUid}`, un documento por arista, con
`followerUid`, `targetUid` y `createdAt`. El id compuesto **es** el diseño:
una arista no se puede duplicar (el segundo create cae sobre un documento que
ya existe y Firestore lo rechaza), dejar de seguir es un delete por id sin
query, y "¿le sigo?" es un `get`, no una búsqueda.

`users/{uid}/following` **no se toca**: sigue siendo privada, owner-only y de
entidades externas (autores, temas, instituciones) para el feed. El contador
*Siguiendo* de la cabecera sigue leyendo eso. Los usuarios seguidos viven
aparte y salen en la pestaña "Siguiendo" de la hoja.

| Archivo | Qué es |
| --- | --- |
| `src/services/followUserService.js` (+27 tests) | follow/unfollow idempotentes, `isFollowing`, contadores por `count()` acotado, páginas con cursor. Inyección de dependencias como `userProfileService`. |
| `src/components/Public/FollowSheet.{jsx,css}` | Hoja con pestañas Seguidores / Siguiendo, paginada (30 por página, "Cargar más"), Esc y clic fuera para cerrar. |
| `src/components/Public/PublicProfilePage.{jsx,css}` | El hueco "Seguidores" que F1 dejó a 0 ahora es un botón con el número real; botón **Seguir / Siguiendo** en el perfil ajeno, en el mismo slot que "Editar perfil" del dueño. Cabecera sin rediseñar. |
| `firestore.rules` | Bloque **aditivo** `follows/`. Cero líneas borradas. |
| `firestore.indexes.json` (nuevo) + `firebase.json` | Los dos compuestos que exige el plan: `(targetUid, createdAt desc)` y `(followerUid, createdAt desc)`. |
| `tests/firestore.rules.test.js` | +15 tests de comportamiento contra el emulador (41 en total). |
| `src/components/Profile/profileStyles.test.js` | `FollowSheet.css` entra en la lista de hojas con tokens verificados. |

### Contadores: `count()` acotado a 1000, y por qué

El plan pedía `count()` bajo demanda sin denormalizar, y así queda —
`followerCount` **sigue congelado** en las rules, junto a `orcid` y
`verified`. No hizo falta descongelarlo, así que la garantía de F1 (endurecimiento
B: nadie se auto-infla el contador) sigue intacta sin añadir nada: el número
no es un campo escribible, es una agregación sobre las aristas, y cada arista
exige `followerUid == request.auth.uid`.

El tope de 1000 no es decorativo. Firestore factura una agregación como **una
lectura por cada 1000 entradas de índice**, así que cortar exactamente en 1000
hace que un contador cueste **una lectura, siempre**, crezca lo que crezca el
grafo. Pasado el tope la cabecera dice "1000+" en vez de un número que no ha
contado. La escalada documentada si alguien pasa de verdad de ahí es el
`followerCount` denormalizado que mantendría la identidad de servicio — que
es justo por qué el campo sigue congelado para clientes.

**El techo lo impone el servidor, no el cliente.** `allow list: if
request.query.limit <= 1000` en las rules, y está comprobado contra el
emulador: una query sin `limit` se deniega, una con `limit(1001)` se deniega,
y una agregación sin `limit` **también** se deniega. No hay patrón sin tope
porque la base de datos no lo acepta.

### Coste por pantalla

| Acción | Lecturas |
| --- | --- |
| Abrir un perfil (visitante sin sesión) | 2 del perfil (F1) + 2 agregaciones |
| Abrir un perfil (visitante con sesión) | + 1 `get` de "¿le sigo?" |
| Seguir / dejar de seguir | 1 escritura (+1 lectura solo si la escritura choca, para distinguir idempotencia de fallo real) |
| Abrir la hoja de seguidores | 1 query acotada + 1 lectura por fila en pantalla (≤30), memoizadas por uid mientras la hoja vive |
| **Carga de feed** | **1, sin cambios** |

Las aristas guardan uids y nada más, a propósito: denormalizar nombre o handle
dejaría a un seguidor escribir texto que se pinta en el perfil de otro, que es
una superficie de suplantación a cambio de ahorrar lecturas. Por eso cada fila
resuelve su propio `userProfiles/{uid}`.

### Tests

- **41 contra el emulador** (`npm run test:rules`), de comportamiento, cero
  aserciones sobre el texto del fichero: no seguirse a uno mismo, seguir dos
  veces deja una arista y un seguidor, no crear ni borrar el follow de otro,
  contadores cuadrados tras seguir → dejar de seguir → volver a seguir,
  aristas inmutables, forma cerrada, `createdAt` de servidor, no seguir a un
  uid sin perfil público, techo de página, grafo público en lectura, nadie
  infla `followerCount`, y **el coste del feed sigue en 1 documento**.
- **518 unitarios** en `npm test`, incluidos 27 del servicio y tres
  estructurales: ninguna query sin `limit`, el servicio no menciona
  `users/`/`following`, y **ningún módulo del camino del feed importa
  `followUserService`** — que es donde el invariante de 1 lectura se puede
  romper de verdad, con un import.

**Pasada de mutación**: 14 cláusulas nuevas eliminadas una a una, **12
muertas** por el test que tocaba. Las 2 supervivientes (`hasAll` y el
`request.auth != null` del create) son **redundantes, no huecos**, y la propia
corrida lo demuestra: al quitarlas la escritura siguió denegada por otra
cláusula (desreferenciar `request.auth.uid` con `auth == null`, y
`createdAt == request.time` sobre un campo ausente, deniegan solas). Se
mantienen porque son el patrón de casa de `02-SECURITY.md`, y llevan comentario
en las rules para que nadie las crea portantes.

**El uid no puede llevar `_`** (`validFollowUid`). Firebase Auth emite uids
alfanuméricos de 28 caracteres, así que no rechaza nada real; sin esa cláusula
la cuenta `alice_uid` podría ocupar el documento que `alice` necesita para
seguir a `uid_bob` y bloquear ese follow para siempre. Hay test.

### Qué queda fuera, a propósito

- **Feed de actividad de seguidos**: excluido por el plan (`01-DATA-MODEL.md`),
  no por falta de tiempo.
- **Contador de "usuarios seguidos" en la cabecera**: la cabecera no se
  rediseña, y sus tres huecos ya están ocupados (Siguiendo = entidades,
  Seguidores, Me gusta). El número de usuarios seguidos sale en la pestaña
  "Siguiendo" de la hoja.
- **Notificar al seguido**: no hay infraestructura de notificaciones sociales;
  sería F7 o posterior.
- **Seguir desde otro sitio que no sea el perfil**: las rules exigen que el
  destino tenga perfil público, y el perfil es el único sitio donde eso se
  sabe sin una lectura extra.

### Verificación en vivo (2026-08-19)

**Rules, contra producción y sin cabecera de auth** (REST, no el navegador,
que comparte sesión y daría falsos positivos). Seis de seis:

| | |
| --- | --- |
| query `follows` con `limit(30)` | permitida |
| query `follows` **sin** `limit` | denegada |
| query `follows` con `limit(1001)` | denegada |
| `count()` con `limit(1000)` | permitida |
| `count()` **sin** `limit` | denegada |
| crear una arista sin sesión | denegada |

El techo de página no es una convención del cliente: producción rechaza
cualquier query sobre `follows` que no lo lleve, agregaciones incluidas.

**Flujo completo con sesión**, `@mugar` sobre el perfil de `@nick_mugar`:
contador real en 0 (ya no "—", que era el estado pre-deploy) → Seguir → 1 y
botón a "Siguiendo" → recarga y persiste → hoja de seguidores con la fila de
`@mugar` resuelta (el índice compuesto responde) → desde el perfil propio, la
pestaña de usuarios seguidos muestra `@nick_mugar` → dejar de seguir → 0 →
volver a seguir → 1. Sin descuadre en ningún paso. En consola, cero
`permission-denied`; los únicos errores son los 429 de OpenAlex, que son el
rate limit de dev ya conocido y ajeno a esto.

**Coste del feed medido en la app real**: `window.__papertokReads` tras cargar
el feed da `interactions: 0` y `library: 0` — cero escaneo, el agregado hizo
su trabajo. (`aggregate: 2` es el doble montaje de StrictMode en dev; en
producción es 1, y el test COST lo fija.)

**Un fallo encontrado y arreglado durante la pasada**: la cabecera dice
*Siguiendo* para las entidades del feed y la hoja decía *Siguiendo* para los
usuarios, a un clic de distancia y con números distintos (0 y 1). Misma
palabra, dos cosas. La pestaña pasa a llamarse **"Usuarios seguidos"** /
"Following users"; la cabecera no se toca.

**Datos vivos que quedan**: una arista real `mugar → nick_mugar`. Es un follow
legítimo, no basura de test; para deshacerlo basta pulsar "Siguiendo" en
`/public/user/nick_mugar`.

### Choques con el rediseño del compañero

`PaperCard.{jsx,css}` intactos otra vez. `Navbar.jsx` no se tocó en esta fase.
El riesgo sigue concentrado en `PublicProfilePage.{jsx,css}`, que ya venía muy
tocada por las seis pasadas del perfil: si su rama toca esa página, el
conflicto es seguro.

## Red social del conocimiento — F1 implementada (2026-08-19)

**Fase actual**: **F1 (P1+P2+P3) hecha y verificada en vivo**. Rules
desplegadas en `papertok-168df` el 2026-08-19. **F2/P4 hecha, desplegada y verificada en
vivo** (sección de arriba). Siguiente: **P5** (clave canónica de paper), que
es paralelizable.

### Qué entró en F1

| Archivo | Qué es |
| --- | --- |
| `src/utils/userHandle.js` (+test) | Gramática del handle y lista de reservados. Puro. |
| `src/services/userProfileService.js` (+test) | Crear/editar perfil, reservar/cambiar handle en batch, leer por uid y por handle, pineo. Inyección de dependencias como `publicListService`. |
| `src/components/Profile/ProfilePage.{jsx,css}` | Editor del perfil propio + pineo/despineo. Ruta `/settings/profile`. |
| `src/components/Public/PublicProfilePage.{jsx,css}` | Perfil público en `/public/user/:handle`. Sin sesión. |
| `firestore.rules` | Bloque **aditivo** `userProfiles/` + `handles/` + `isAdmin()`. Cero líneas borradas del bloque anterior. |
| `tests/firestore.rules.test.js` + `tests/README.md` | 26 tests de comportamiento contra el emulador. `npm run test:rules`. |
| `src/utils/publicNavigation.js` | `getPublicProfilePath/Url`. |
| `src/utils/profileImage.js` | `PUBLIC_AVATAR_PRESET` (≤60 KB) y opciones en `prepareProfileImage`; los valores por defecto no cambian. |
| `src/App.jsx`, `src/components/Settings/SettingsPage.jsx` | Rutas y punto de entrada. |

### Endurecimiento tras la revisión adversarial (2026-08-19)

Una relectura del bloque de rules "como si lo hubiera escrito otro" encontró
tres agujeros que los tests de texto no podían ver, porque comprueban que las
cláusulas escritas siguen ahí, no que falte alguna. Los tres arreglados,
desplegados y probados ejecutando el ataque contra producción:

| | Era | Ahora |
| --- | --- | --- |
| **A** | Cualquiera podía fijar la lista de otro: solo se validaba el *formato* del shareId. Confirmado fijando `deadbeef…`, que ni existe. | `ownsPinnedShare()` lee `publicListOwners/{shareId}` y exige `ownerId == request.auth.uid`. |
| **B** | `followerCount` era auto-escribible. Confirmado poniéndome 999999. | Congelado junto a `orcid` y `verified`. |
| **C** | Borrar el perfil no liberaba el handle ⇒ borrar-y-recrear acumulaba reservas sin límite. | El delete exige `!existsAfter(handles/{handle})`. Probado en producción: la secuencia de acumulación se deniega y una cuenta acaba con **una** reserva, no dos. |

Además, `allow read` era `get` **y** `list`: cualquiera podía volcar el
directorio de usuarios con sus fotos, a tu cuota. Ahora `allow get: if true` +
`allow list: if false` en `userProfiles/` y `handles/`.

**El tope de listas fijadas es 6, y el número está medido, no elegido.** El
límite que manda no es el de 10 accesos a documento que supuse, sino el de
**1000 expresiones por evaluación**: contra el emulador, 7 pines pasan y 8
fallan con error de límite de expresiones. 6 deja una entrada de margen para
que la próxima cláusula que se añada a `firestore.rules` (F2, F6) no empiece a
rechazar guardados de quien esté en el tope. Para ganar ese margen se quitó la
lista de 44 handles reservados de `validPublicProfile`: era redundante, porque
todo handle de un perfil tiene que estar respaldado por un `handles/{handle}`,
y es *ahí* donde se aplica. Hay un test de emulador que lo cubre.

**Efecto secundario que hay que conocer**: despublicar una lista borra el
`publicListOwners/{shareId}` que lee la comprobación de propiedad, así que un
pin huérfano bloquea *cualquier* escritura del perfil. No hay bloqueo
permanente — quitar el pin no lo valida, porque las rules validan el array que
se escribe — y `/settings/profile` detecta los pines huérfanos al cargar
(cruzándolos con las listas publicadas, sin lectura extra) y ofrece quitarlos.
`partitionStalePins()` en el servicio.

### Tests de rules que sí ejecutan las rules

`tests/firestore.rules.test.js`: 26 tests de comportamiento contra el emulador
de Firestore, vía `npm run test:rules`. Cubren los tres arreglos, el cierre de
`list`, la carrera de dos cuentas por un handle, y los dos límites del motor.
Pasada de mutación: 7 cláusulas **eliminadas** una a una, las 7 cazadas — que
es justo lo que los tests de texto no hacían.

Requiere una JRE. Instalada con `brew install openjdk` (la fórmula, no el cask
`temurin`, que necesita `sudo`). Es keg-only, así que hace falta
`export PATH="/opt/homebrew/opt/openjdk/bin:$PATH"`. Detalle en
`tests/README.md`.

Los tests de texto siguen en `src/services/userProfileService.test.js`: son
gratis, corren sin emulador dentro de `npm test`, y ahora tienen encima la
cobertura de comportamiento que les faltaba.

### Invariantes que F1 respeta (verificados, no asumidos)

- **Handle atómico**: `handles/{handle}` es *create-only* en rules (no hay
  `allow update`). Firestore rechaza un create sobre un doc existente, así
  que el perdedor de una carrera recibe `permission-denied`; el servicio lo
  traduce a `HandleUnavailableError`. El `getAfter` cruzado perfil↔handle
  calca `publicLists`/`publicListOwners`.
- **`publicLists` y `publicListOwners` intactos**: comprobado en vivo — tras
  pinear, despinear y volver a pinear, el `updateTime` del doc público no se
  movió. Hay un test que compara ambos bloques de rules carácter a carácter
  contra su texto anterior.
- **El feed sigue costando 1 lectura**: nada social entra en su camino
  (`grep` de `userProfileService` en `src/context/` y `src/components/Feed/`
  no devuelve nada). El test de coste sigue verde sin tocarlo.
- **Sin lecturas de colección sin tope**: el selector de listas pineables usa
  `orderBy('publicShareId') + limit(60)`. El `orderBy` hace el trabajo de
  filtrado (Firestore descarta los docs sin ese campo), así que no hay ni
  índice nuevo ni escaneo en cliente. Un test del *fuente* falla si aparece
  un `getDocs` que no pase por una query con `limit`.
- **Perfil público sin sesión**: verificado contra la REST API de Firestore
  sin cabecera de auth — `handles/mugar` y `userProfiles/{uid}` se leen;
  `users/{uid}` y `publicListOwners/{shareId}` siguen dando
  `PERMISSION_DENIED`.
- **`orcid` y `verified`**: intocables desde cliente, en el servicio (lista
  blanca) y en rules (`publicProfileServiceFieldsAbsent/Unchanged`).

### Cómo se probó

`npm test` (458 verdes) más una pasada de mutación: 11 fallos reintroducidos
a mano (lectura pública cerrada, comprobación de dueño quitada, `allow
update` añadido a `handles`, reservado eliminado, plegado de mayúsculas
quitado, deduplicación de pineo quitada…) y los 11 los cazó el test
correspondiente. El script vive en el scratchpad de la sesión; si hace falta
repetirlo, es reescribirlo, no está versionado.

**Límite conocido de los tests de rules**: son aserciones sobre el *texto* de
`firestore.rules`, la convención que ya usaba `publicListService.test.js`.
Muerden ante cualquier borrado de cláusula, pero **no ejecutan** las rules.
Ejecutarlas de verdad necesita `@firebase/rules-unit-testing` + el emulador,
y el emulador necesita una JRE que esta máquina no tiene (`java` es el stub
de macOS). La cobertura de comportamiento la dio la verificación en vivo.

### Fuera de alcance en F1, a propósito

- **Despublicar una lista no la despinea automáticamente.** El plan lo quería
  en el mismo batch, pero eso obliga a tocar `ListsPage.jsx`, que tiene
  cambios sin commitear. Mitigado, no resuelto: `/settings/profile` detecta
  los pines huérfanos y ofrece quitarlos, lo cual ahora es obligatorio porque
  bloquean cualquier otra escritura del perfil. El cierre limpio sigue siendo
  quitarlo en el mismo batch que el despublicado.
- Seguir usuarios, contadores de seguidores (`followerCount` ya está
  permitido en rules pero nadie lo escribe): es F2/P4. **Hecho**, ver la
  sección de F2 arriba; `followerCount` sigue congelado porque los contadores
  salieron por `count()`, sin denormalizar.
- `isAdmin()` está con el UID en marcador de posición
  (`REPLACE_WITH_ADMIN_UID`), inerte hasta P7.

El freeze del rediseño de UI se levantó el 2026-08-19: `src/` vuelve a ser
editable. `PaperCard.{jsx,css}` sigue con cambios del compañero sin
commitear; F1 no los tocó.

**Hecho**: los seis documentos de `docs/plan/` — `00-ARCHITECTURE.md` (qué
escrituras van directas vs Worker; stubs de paper con clave canónica),
`01-DATA-MODEL.md` (colecciones, índices, costes), `02-SECURITY.md` (rules,
rate limiting, moderación unipersonal, relay F7, reclamación de investigador
F6), `03-AUTH.md` (GitHub, ORCID por dos vías con la B recomendada, correo
universitario, vinculación), `04-PHASES.md` (P1–P14 de una sesión cada una),
`05-RISKS.md`.

**Siguiente**: **P8** (anotaciones, F4) — P5/P6/P7 hechos, ver la sección de
F3 arriba —, más las acciones humanas de abajo (la 4, el uid de admin, quedó
hecha en F3).

**Decisiones clave y por qué** (detalle en cada doc):

- Comentarios/anotaciones: escritura directa con rules + throttle declarativo
  (`getAfter` sobre `users/{uid}/rateLimits/`), NO vía Worker. Umbral de
  reversión documentado en `00-ARCHITECTURE.md`.
- Stubs: `papers/{base64url(doi:…| arxiv:…| id crudo)}`, DOI antes que arXiv,
  arXiv sin versión; inmutables salvo contadores; el feed no los lee nunca.
- Perfil público en `userProfiles/{uid}` separado del `users/{uid}` privado;
  handles únicos calcando el patrón `publicListOwners`; atribución de listas
  **por pineo opt-in** (publicLists sigue anónimo).
- Seguir usuarios: colección propia `follows/{follower}_{target}`, no se toca
  `users/{uid}/following` (modela entidades externas). Contadores por
  `count()`, sin denormalizar. El feed de actividad de seguidos queda FUERA.
- F6: ORCID como *verificación* vía Worker (Vía B), no como login — evita el
  upgrade a Identity Platform (verificado: OIDC genérico lo exige; Tier 2
  gratis solo ≤50 MAU, luego ~$0.015/MAU). Página de investigador indexada
  por ORCID iD, nunca por nombre. Correo edu = solo insignia de afiliación,
  jamás reclamación automática de página.
- F7: relay en el Worker; el email del receptor se resuelve por
  `accounts:lookup` administrativo al enviar y no se persiste ni viaja al
  cliente. Opt-in `allowContact`, cuotas en el `RequestQuotaLedger` existente.
- Infra nueva única: identidad de servicio (service account) en el Worker
  (P10), requisito compartido de F6+F7. Colecciones de servicio con
  `write: false` para clientes.
- Fuera de alcance confirmado: publicar papers propios (decisión previa),
  feed de actividad, anclaje posicional de anotaciones (alternativas en
  `05-RISKS.md` R3), mensajería en-app.

**Acciones humanas pendientes (bloquean fases concretas)**:

1. OAuth App de GitHub + activar proveedor en consola Firebase → bloquea P9.
2. Registrar cliente del API público de ORCID con redirect a la URL del
   Worker → bloquea P11.
3. Crear service account con rol mínimo de Firestore + `wrangler secret` →
   bloquea P10 (y por tanto P11–P14).
4. Copiar el UID de admin a `isAdmin()` en rules → bloquea P7. La función ya
   existe en `firestore.rules` con `'REPLACE_WITH_ADMIN_UID'`; hoy no casa con
   nadie, que es el fallo seguro.

**Preguntas abiertas**:

- ORCID: condiciones exactas del registro de cliente del API público
  (redirect URIs admitidas, requisitos), detalles del sandbox
  (`sandbox.orcid.org`), y si `openid` a secas devuelve `name` en el
  id_token. No asumido en el diseño; verificar al registrar (acción 2).
- Service account desde Workers: confirmar grant `jwt-bearer` contra
  `oauth2.googleapis.com/token` con WebCrypto y elegir el rol IAM mínimo
  (los roles de Firestore no son por colección; el aislamiento del lado
  cliente lo dan las rules).
- App Check con reCAPTCHA en GitHub Pages: ¿viable y gratis a este volumen?
  Sin verificar; afecta solo a R2 (`05-RISKS.md`).
- `fetchSignInMethodsForEmail` con protección de enumeración activada:
  confirmar comportamiento al implementar P9.
- Lecturas de docs `hidden`: ¿exigir `where status=='visible'` en rules o
  filtrar en cliente? Decidir en P6/P7 (`02-SECURITY.md` §1).
- Licencia del dataset abierto de dominios universitarios antes de usarlo
  como semilla (P13).

**Para ponerse al día sin reexplorar el repo**: leer `docs/plan/00` → `04`
en orden (05 opcional pero corto), más `docs/INTERACTION_PROFILE.md` si se
toca el feed. El reconocimiento que sustenta el plan está resumido en las
tablas de `00-ARCHITECTURE.md`; no hace falta releer `firestore.rules` ni el
Worker para seguir diseñando, sí para implementar.

**Deuda detectada en el reconocimiento (no bloquea, no mezclar con el plan)**:
`interactions` usa `paper.id` crudo como ID de doc (DOIs con `/` anidan
rutas; prefijos inconsistentes arXiv/OpenAlex según ruta de entrada) — R8;
doble implementación de auth en el Worker (`firebase-auth.js` vs
`email-notifications.js:688`) — R10; `PUBLIC_DISCOVERY.md` dice 20 papers
donde las rules dicen 12 — R9.

## Hecho: reparación automática de deriva del agregado

`loadInteractionProfile` compara `sourceDocCount` con un `count()` de
`users/{uid}/interactions` y fuerza un rebuild si el agregado ignora más de
`max(25, 2%)` documentos. Throttled a una vez por semana y por dispositivo vía
`localStorage`, para que una carga de feed normal siga costando una lectura.
Detalle en `docs/INTERACTION_PROFILE.md`.

## Pendiente: acotar `enrichPapersBatch` en el perfil semántico del feed

**Dónde:** [src/context/FeedContext.jsx](src/context/FeedContext.jsx), bloque
"OpenAlex Semantic Profile" dentro de `loadInteractions`, y
[src/services/openAlexService.js](src/services/openAlexService.js).

**Qué pasa:** al cargar el feed se llama a `enrichPapersBatch(positiveIds)` con
la unión completa de `liked` y `saved` para reconstruir `conceptAffinities`. Es
un fan-out HTTP a OpenAlex que crece con el número de papers que el usuario ha
marcado, sin tope propio.

**Por qué no es urgente:** no es Firestore, así que no consume la cuota de
lecturas del free tier, y desde el agregado de interacciones
(`docs/INTERACTION_PROFILE.md`) queda acotado de rebote por los topes de los
sets curados — 2.000 liked + 2.000 saved como máximo absoluto. Aun así son
hasta 4.000 IDs por carga de feed en el peor caso, contra un servicio público
con rate limiting.

**Opciones a evaluar:**

1. Limitar a los N positivos más recientes. Los sets curados ya se guardan en
   orden de recencia, así que es un `.slice(0, N)`. Cambia `conceptAffinities`
   y por tanto el ranking: hay que medir cuánto.
2. Persistir `conceptAffinities` en el propio documento agregado y mantenerlo
   incrementalmente, como se hace con `categoryAffinities`. Elimina el fan-out
   de la carga de feed por completo, pero hace persistentes los bumps que hoy
   son solo de sesión, lo cual también es un cambio de comportamiento.
3. Cachear el resultado de OpenAlex por ID con TTL, y pedir solo los que falten.
   No cambia el ranking; reduce el tráfico pero no el peor caso en frío.

**No estaba en el encargo** del agregado de interacciones; se detectó al
investigarlo.
