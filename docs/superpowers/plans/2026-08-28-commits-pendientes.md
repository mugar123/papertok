# Commits pendientes — navbar y alerta compactas (28-08-2026)

Los tres cambios están implementados y revisados, pero **sin commitear**: había
otras sesiones trabajando en el mismo árbol y me pediste no tocar el índice.

Antes de nada, comprueba que sigue sin colarse trabajo ajeno:

```bash
git status --short
```

Debe salir esto (más lo que hayan dejado las otras sesiones, que **no** hay que
incluir — `src/styles/global.css` era de otra sesión cuando ejecuté el plan):

```
 M src/components/Layout/Navbar.css
 M src/components/Layout/Navbar.jsx
 M src/components/Privacy/AnalyticsConsentBanner.css
 M src/components/Privacy/AnalyticsConsentBanner.jsx
 M src/components/Public/GuestFeedPage.css
 M src/components/Public/GuestFeedPage.jsx
 M src/components/Report/ScientificReport.jsx
?? src/components/Layout/NavPreferencesMenu.css
?? src/components/Layout/NavPreferencesMenu.jsx
?? src/components/Layout/navbarChrome.test.js
?? src/components/Privacy/analyticsConsentStyles.test.js
?? src/components/Public/guestHeaderChrome.test.js
```

Los tres commits, en este orden y con listas de ficheros explícitas (nunca
`git add -A`, que barrería lo de las otras sesiones):

```bash
git add src/components/Privacy/AnalyticsConsentBanner.jsx src/components/Privacy/AnalyticsConsentBanner.css src/components/Privacy/analyticsConsentStyles.test.js && git commit -m "fix(privacidad): la alerta de analítica cabe en una fila

El botón «No permitir» se sustituye por una X que registra el mismo
rechazo (el consentimiento persiste un año; sin vía de rechazo la alerta
reaparecería en cada visita), y el botón de aceptar sube a la fila del
texto: 136px de alto pasan a 104px."
```

```bash
git add src/components/Layout/Navbar.jsx src/components/Layout/Navbar.css src/components/Report/ScientificReport.jsx src/components/Layout/navbarChrome.test.js && git commit -m "feat(navbar): fuera el botón de recargar

Recargar la página consigue lo mismo: las tres cachés que forzaba
(arxiv, informe, tendencias) viven en Maps de memoria. Se van con él el
listener de refreshScientificReport y los eventos reportLoadingStart/End,
que no tenían otro consumidor; el feed conserva su refresh propio en
FeedContainer y el informe sus reintentos con forceRefresh."
```

```bash
git add src/components/Layout/NavPreferencesMenu.jsx src/components/Layout/NavPreferencesMenu.css src/components/Layout/Navbar.jsx src/components/Layout/navbarChrome.test.js && git commit -m "feat(navbar): tema e idioma se pliegan tras un mini botón de preferencias

El ThemeToggle suelto deja su hueco a un disclosure con popover CSS que
reúne tema, idioma (su primer acceso fuera de /settings) y el enlace a
los ajustes completos. El feed de invitado conserva su toggle propio."
```

Y el cuarto, pedido después de ejecutar el plan: el mismo botón, fuera también de
la cabecera de invitado.

```bash
git add src/components/Public/GuestFeedPage.jsx src/components/Public/GuestFeedPage.css src/components/Public/guestHeaderChrome.test.js && git commit -m "feat(invitado): fuera el botón de recargar de la cabecera

La misma decisión que en la navbar, por la misma razón: recargar la
página consigue lo mismo. Dejarlo en una de las dos cabeceras hacía que
la aplicación se comportara distinto según hubiera sesión o no.

useGuestFeed conserva refresh e isRefreshing: FeedContainer los lee del
source para su propio tirar-para-recargar, y un test los defiende. El
bloque de reduced-motion, que solo cubría el spinner, pasa a cubrir la
transición de color que sí queda, como ya hace Navbar.css."
```

Y el plan y esta nota, si los quieres en el repo:

```bash
git add docs/superpowers/plans/2026-08-28-navbar-y-alerta-compactas.md docs/superpowers/plans/2026-08-28-commits-pendientes.md && git commit -m "docs(plan): la navbar y la alerta de analítica, con su auditoría"
```

**Ojo:** `Navbar.jsx` y `navbarChrome.test.js` los tocan las tareas 2 y 3 a la
vez, así que aparecen en dos commits. Al no haber commits intermedios, el
primero de los dos se lleva el estado final de ambos ficheros y el segundo no
tendrá nada que añadir de ellos. Si prefieres que cada commit cuente solo su
parte, haz uno solo con los dos cambios de navbar en vez de dos.
