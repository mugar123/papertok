# Auditoría: la ventana de intereses no aparece a los usuarios nuevos — 2026-09-16

Síntoma reportado por Nicolás: «a nuevos usuarios no les carga la ventana
pidiendo intereses (Física, Ingeniería, etc.)». Usuarios registrados, no el
feed de invitado.

**Nada está arreglado.** Esto es el diagnóstico, con la reproducción que lo
sostiene, y las opciones para decidir.

**Veredicto: no es un fallo de carga ni del guardián de rutas. Es la decisión
de producto del 13-09** (`92c01f8`, a petición de Samuel: «al crear la cuenta
relacionar los intereses sin repetir la pantalla»), que está en `origin/main`
y desplegada desde entonces. Desde ese commit, todo usuario nuevo que entra
por la puerta normal (feed de invitado → «Entrar») **nunca ve la pantalla de
áreas**: el onboarding le abre directamente en el paso 4, «¿Quieres un perfil
público?», con una nota discreta de que sus intereses «ya están». Hay además
un segundo camino, más raro, en el que el onboarding no aparece hasta más
tarde (páginas públicas). Ningún camino deja a una cuenta sin onboarding para
siempre.

| # | Camino de entrada | ¿Respondió intereses como invitado? | Paso en que abre el onboarding | Qué percibe el usuario |
|---|---|---|---|---|
| 1 | Feed de invitado → «Entrar» (la puerta habitual) | **Sí, obligatorio**: la primera pregunta no se puede cerrar | **04 Perfil** | «No me preguntó los intereses» |
| 2 | Ruta protegida (`/lists`, `/settings`…) → rebote a `/` con el modal abierto | No: el prompt se suspende mientras el modal está abierto | 01 Áreas | Ve la pantalla que espera |
| 3 | Página pública (`/public/paper`, `/explorer`, `/public/user`, `/public/list`) → acción que pide cuenta | No, si nunca pasó por el feed | **Ninguno** hasta que navegue a `/` u otra ruta protegida | Cuenta creada, sin barra y sin onboarding |

---

## Hallazgo 1 — El invitado ya respondió, y el onboarding se lo salta (por diseño)

### Qué se ve

Un usuario nuevo pulsa «Entrar» en el feed de invitado, elige Google o GitHub, y
aterriza en «Paso 04 / 04 — ¿Quieres un perfil público?». Las tres etapas
anteriores (Áreas, Categorías, Tu feed) aparecen tachadas como hechas en el
carril. Debajo del texto hay una nota con un check: «Tus intereses ya están:
las 3 áreas que marcaste como invitado, 42 categorías. Con «Atrás» puedes
afinarlos, y también desde Ajustes cuando quieras».

### Qué hay detrás

Tres piezas, las tres del 13-09:

1. **La primera pregunta del feed de invitado es obligatoria.**
   `GuestInterestsPrompt.requestOpenChange` rechaza cualquier cierre sin
   respuesta en el primer pase (sin X, sin «Ahora no», Escape y scrim
   ignorados). Todo visitante que llega a `/` sin sesión responde antes de
   poder hacer nada, y la respuesta va a `localStorage` bajo
   `papertok_guestInterests` (`src/utils/guestInterests.js`).

2. **El onboarding lee esa respuesta y arranca en el perfil.**
   `OnboardingFlow.jsx`: `useState(guestSeed ? 4 : 1)`. Las áreas quedan
   preseleccionadas y, con ellas, **todas** las subcategorías de cada área
   (`guestCategoriesForAreas`): tres áreas son 42 categorías. Las pantallas de
   áreas y categorías siguen existiendo, pero solo se llega a ellas pulsando
   «Atrás» dos veces (perfil → recibo → categorías → áreas).

3. **Un test lo fija.** `OnboardingFlow.test.js:75`, «the onboarding opens on
   the profile step, pre-filled from the guest answer», exige literalmente
   `useState(guestSeed ? 4 : 1)` y la nota `onboarding-seed-note`.

En STATE.md (entrada del 2026-09-13) está la decisión: «un invitado con
respuesta entraba en el recibo (paso 3) y aún tenía que confirmar; ahora entra
directamente en el perfil (paso 4, el único que no ha respondido)». Es decir,
la primera ronda de esa tarde dejaba al usuario ver su selección; la segunda
ronda la escondió detrás de «Atrás».

### Por qué se percibe como fallo

- La nota es una línea pequeña bajo un título que habla de otra cosa (el
  perfil público). Quien esperaba «elige Física, Ingeniería…» no la relaciona.
- «Atrás» no se lee como «afinar intereses»: es el botón genérico del pie.
- La respuesta del invitado es por **áreas**, y el onboarding selecciona
  **todas** las categorías de cada una. El usuario que quería afinar (solo
  «Física de partículas», no las 26 de Física) nunca tuvo dónde.
- El usuario pudo responder la pregunta del invitado días antes, en otra
  visita, y no recordarla: el registro «no le preguntó nada».

### Reproducción

Modo demo (`IS_DEMO` volteado en un config de Vite aparte, sin tocar el
árbol), Chrome headless por CDP, cuenta nueva (`papertok_user` sembrado sin
`papertok_onboardingComplete`), recarga real de la página y espera a
`.onboarding-stepcount`:

| Escenario | `papertok_guestInterests` | Hash | Paso | Título | Tiempo hasta el onboarding |
|---|---|---|---|---|---|
| Con respuesta de invitado | `physics, eess, mech` | `#/onboarding` | **04 / 04** | «Do you want a public profile?» + nota «3 areas … 42 categories» | 633 ms |
| Sin respuesta (control) | ausente | `#/onboarding` | **01 / 04** | «Choose your areas of interest», 12 tarjetas | 702 ms |

Las dos capturas (`onboarding-seeded.png`, `onboarding-fresh.png`) se
entregaron en la sesión. El control demuestra que el guardián y la ruta
funcionan: lo único que cambia entre las dos es la clave del invitado.

Trampa de la reproducción: `navigate` (o `Page.navigate`) a la misma página con
otro hash **no recarga** el documento y la app sigue con el estado anterior a
la siembra; hay que `location.reload()` / `Page.reload`.

### Qué NO es (descartado con evidencia)

- **No es el guardián.** `ProtectedRoute` manda a `/onboarding` cuando
  `onboardingComplete` es `false`, y `accountLooksOnboarded` solo da `true` con
  `onboardingComplete === true` o `preferences`/`selectedCategories` no vacío.
- **Nadie escribe `users/{uid}` antes del onboarding.** El único escritor del
  documento raíz es `AuthContext` (`completeOnboarding`, `updatePreferences`,
  seguidos, lectura, foto); el calentamiento de cuenta y el perfil público van
  a subcolecciones y a otras colecciones. Las rules (`firestore.rules:654`)
  no crean nada por su cuenta.
- **No es la memoria local.** `readStoredOnboarding` va por uid: una cuenta
  nueva no tiene clave. Y desde `2261329` un recuerdo local no tapa un
  documento ausente (`applyRemote` baja el flag y borra la clave).
- **No es la lectura del perfil.** Un documento inexistente con respuesta del
  servidor (`fromCache !== true`) es una ausencia autoritativa
  (`documentIsAuthoritative`) → onboarding. Si la lectura falla o pasa de 7 s,
  lo que se ve es «No se pudo cargar tu perfil», no un salto de pantalla.
- **No es un chunk que no carga.** De la recarga a la pantalla del onboarding,
  633–702 ms en demo; el chunk de `OnboardingFlow` es perezoso pero llega.
- **No hay un cambio posterior que lo explique.** `git log` sobre
  `Onboarding/`, `ProtectedRoute.jsx`, `accountOnboarding.js` y
  `AuthContext.jsx`: el último commit es `92c01f8` (13-09).

---

## Hallazgo 2 — Registro desde una página pública: sin onboarding hasta volver al feed

Verificado en código; **no reproducido** en el navegador (necesita una página
pública cargada del Worker).

Las rutas `/explorer/:type/:id`, `/public/entity/…`, `/public/paper/…`,
`/public/user/…` y `/public/list/…` (`App.jsx:460–511`) no van dentro de
`ProtectedRoute`. Sus botones de «me gusta», «guardar» o «seguir» llaman a
`requestAuthentication`, que solo abre el modal `AuthPrompt`. Cuando llega la
sesión, el modal se cierra (`isOpen = open && !user`) y **nada navega**: el
viaje de vuelta (`pendingReturn`) existe solo para quien llegó rebotado con
`authRequired`. La cuenta nueva se queda en la página pública con
`onboardingComplete === false`, sin barra (`showNavbar` la exige) y sin
onboarding, y puede guardar en listas (`onSaveToList={user ? setSaveModalPaper
: …}`) con un perfil sin preferencias. El onboarding aparece la primera vez que
pulsa el logotipo o «Inicio» (ambos navegan a `/`), o entra en cualquier ruta
protegida.

Gravedad: baja-media. Retrasa el onboarding, no lo impide, y afecta solo a
quien se registra desde un enlace público sin haber pasado por el feed. En ese
caso, además, no hay respuesta de invitado, así que **sí** verá las áreas
cuando llegue.

---

## Hallazgo 3 — Las 42 categorías: el feed solo usa las cinco primeras, y en orden de taxonomía

Añadido el 17-09 a raíz de «¿cuál es el problema de las 42 categorías?».

El número en sí no es el problema. El problema es lo que el feed hace con la
lista:

1. **La ventana de cinco.** `FeedContext.loadPapers` ordena las preferencias
   por afinidad (`rankedPreferences`) y se queda con `slice(0, 5)` para arXiv
   y OpenAlex y `slice(0, 3)` para PubMed. Una cuenta nueva tiene afinidad
   cero en todo; el `sort` es estable, así que manda el orden de la lista, que
   es el de la taxonomía (`guestCategoriesForAreas`: áreas en orden, y dentro
   de cada área sus subcategorías en orden). Quien marcó Física + Ingeniería
   Eléctrica + Ingeniería Mecánica arranca con `quant-ph, cond-mat.supr-con,
   cond-mat.str-el, cond-mat.mtrl-sci, cond-mat.mes-hall`: cinco de Física y
   ninguna ingeniería hasta que sus interacciones muevan las afinidades. Antes
   del 13-09 el usuario marcaba a mano seis u ocho categorías y todas cabían.
   El feed de invitado ya sabe repartir (`interleaveAreaCategories` en
   `guestFeedPlan.js`, redondo por áreas); el feed con sesión no.
2. **La exploración se queda sin material.** El paso 6 de `loadPapers` busca
   categorías hermanas dentro de las áreas del usuario que no estén en sus
   preferencias (`nearbyCats`). Con todas marcadas no queda ninguna: una
   selección más amplia da un feed menos variado.
3. **El perfil no sabe qué quería el usuario.** Las 42 pesan igual, el ranking
   parte de cero y Ajustes muestra 42 casillas marcadas.

## Hallazgo 4 — Más de 100 preferencias: la escritura se rechaza y el onboarding entra en bucle

Verificado en código; **no reproducido** (necesita el emulador de rules).

`firestore.rules:663` exige `preferences.size() <= 100`. Hay 142
subcategorías en total; las cinco áreas grandes (physics 26, cs 21, math 17,
med 16, bio 15) suman 95 y la sexta ya pasa de 100. Un invitado que marque
seis áreas grandes o «todo» (lo que hace un tester) produce una escritura que
Firestore rechaza. Y el onboarding no lo ve:

- `completeOnboarding` (`AuthContext.jsx`) hace `setOnboardingComplete(true)`
  **antes** de `await setDoc(...)`;
- el efecto de `OnboardingFlow` navega a `returnTo` en cuanto ve el flag;
- la escritura falla contra un componente ya desmontado, el `catch` de
  `handleFinish` pinta un error que nadie ve;
- `saveStoredOnboarding` va después del `await`, así que tampoco queda
  memoria local;
- en la siguiente recarga no hay documento → onboarding → misma escritura →
  mismo rechazo.

Antes del 13-09 llegar a 100 a mano era implausible; ahora son seis toques en
la pregunta del invitado. Ninguna de las dos pantallas de intereses (onboarding
y Ajustes) tiene tope propio, y ningún test de rules cubre el límite.

---

## Opciones (decidido el 17-09: A + D + las correcciones de los hallazgos 3 y 4; plan en `docs/superpowers/plans/2026-09-17-onboarding-intereses.md`)

Sobre el hallazgo 1, de menos a más cambio respecto a lo pedido el 13-09:

- **A. Dejar el salto y hacer visible lo que vino.** En el paso 4, sustituir la
  nota por el recibo compacto de áreas (con su N de categorías) y un botón
  explícito «Ajustar intereses» que abra el paso 2. Mantiene «sin repetir la
  pantalla» y responde a «no me preguntó».
- **B. Volver a la primera ronda del 13-09.** Con respuesta de invitado, abrir
  en el recibo (paso 3): el usuario ve sus áreas y categorías, confirma con un
  botón, y sigue al perfil. Una pantalla más, pero la que el usuario espera.
- **C. Preseleccionar y pasar por todo.** Abrir en el paso 1 con las áreas
  marcadas. Es lo que Samuel pidió evitar.

Sobre el hallazgo 2:

- **D. Enviar al onboarding al registrarse desde una página pública.** Un
  efecto en `App.jsx` junto a `pendingReturn`: sesión nueva con
  `onboardingComplete === false` y sin `authLoading` → `navigate('/onboarding',
  { state: { returnTo: location } })`. La página pública queda como destino de
  vuelta, igual que hoy con las rutas protegidas.

En cualquier caso, conviene que la elección del invitado se convierta en
categorías **elegidas**, no en «todas las del área»: hoy tres áreas son 42
categorías y el usuario no lo ha decidido.

## Ficheros implicados

- `src/components/Onboarding/OnboardingFlow.jsx` (`guestSeed`, paso inicial, nota)
- `src/components/Onboarding/OnboardingFlow.test.js:75` (fija el salto)
- `src/components/Public/GuestInterestsPrompt.jsx` (`requestOpenChange`)
- `src/components/Public/GuestFeedPage.jsx` (`firstAsk`, `interestsPromptSuspended`)
- `src/utils/guestInterests.js` (`guestCategoriesForAreas`)
- `src/context/AuthContext.jsx` (`applyProfile`, `applyRemote`, `completeOnboarding`)
- `src/components/Auth/ProtectedRoute.jsx`
- `src/App.jsx:126–200` (modal, `pendingReturn`) y `:460–511` (rutas públicas)
