# SDD ledger — plan: docs/superpowers/plans/2026-09-11-feedback-tester.md

## Preflight scan (2026-09-11)

### Pares que comparten fichero o interfaz
| Tareas | Qué comparten | Hallazgo |
|---|---|---|
| T1 ↔ T2 | PaperCard.jsx | T1 cambia 'Open source' en :1054 y :1738; :1738 está DENTRO del ternario que T2 borra entero. Conflicto real, ver R2. |
| T1 ↔ T9/T10/T11 | PaperCard.jsx | Regiones distintas (copia vs botón comments vs portal vs raíz). Solo deriva de líneas. |
| T2 ↔ T9 | PaperCard.jsx columna de acciones | T2 = toggle del ojo, T9 = botón Comments. Elementos distintos. Limpio. |
| T2 ↔ T11 | PaperCard.jsx | T2 = etiqueta, T11 = atributo en la raíz `.pc`. Limpio. |
| T7 ↔ T11 | PaperCard.css | T7 = .graph-peek/.related-sheet (~1332/~1888); T11 = .pc-sheet (48-53) y llegada (279-339). Sin solape. |
| T8 → T9 | prop `isActive` | T8 la produce, T9 la consume. Restricción de orden. |
| T8 → T11 | prop `isActive` | T8 la produce, T11 la consume. Restricción de orden. |
| T9 ↔ T10 | src/hooks/ y PaperCard.jsx | Ficheros nuevos distintos; en PaperCard tocan regiones distintas. Limpio. |
| T3 ↔ T8 | contexto del feed | T3 = FeedContext.jsx, T8 = FeedContainer.jsx. Ficheros distintos. |
| T4, T5, T6 | — | Dueñas únicas de sus ficheros. |

### Coherencia interna de cada tarea
| Tarea | ¿El test que pide concuerda con el código que pide? |
|---|---|
| T1 | Sí. Dos ocurrencias de 'Open source' (1054, 1738), el plan nombra ambas. |
| T2 | Sí. El regex exige 'Marcar leído' y el bloque de código lo escribe. |
| T3 | Sí, con permiso explícito de ajustar el regex al nombre real de la escritura. |
| T4 | Sí. titleRef + tabIndex={-1} en DialogTitle en test y código. |
| T5 | Sí. `language:en` antes de ${countryFilter} en ambos. |
| T6 | Sí. 260/200 ms en ambos. |
| T7 | Sí, pero el paso 1 es una sonda: la hipótesis puede caerse. |
| T8 | Sí. Las cuatro aserciones tienen su contraparte en el código. |
| T9 | Sí. Riesgo: el paper de prueba debe dar ≥1 clave local (ver R4). |
| T10 | Sí. El historial falso acepta pushState(state) e ignora el resto. |
| T11 | Sí. Añadido: borrar el @keyframes muerto (ver R5). |

### Rulings previos a la ejecución
Ruling R1: el worktree parte de `main` local (69027da), no de origin/main — main local va 37 commits por delante y branchear desde el remoto habría perdido el trabajo de otra sesión. Si me equivoco: la rama lleva commits aún sin subir y habría que rebasar antes de fusionar.
Ruling R2: T1 cambia las dos ocurrencias de 'Open source'; T2 después borra la de :1738 junto con su ternario. No es una regresión, la aserción de T1 sigue verde por :1054. Si me equivoco: nada, el test lo detecta.
Ruling R3: el orden de ejecución es estrictamente 1..11, que ya satisface «8 antes que 9 y 11». Si me equivoco: nada.
Ruling R4: si el paper de prueba de T9 no produce claves locales, el implementador arregla el fixture, nunca la aserción. Si me equivoco: un test que no prueba nada.
Ruling R5: T11 borra además el `@keyframes cardSlideUp` si deja de usarse. Si me equivoco: CSS muerto.
Ruling R6: credenciales institucionales y lector HTML de arXiv quedan fuera (confirmado por Nicolás el 11-09). Si me equivoco: dos peticiones del tester sin atender en este PR.

## Progreso
Task 1: minor (deferred): el test no afirma `readLaterOff: 'Leer después'` ni la presencia de 'Fuente'; ambos huecos vienen del propio plan.
Task 1: minor (deferred): saveModalCopy.test.js también afirma sobre PaperCard.jsx pese a su nombre (heredado del plan).
Task 1: complete (commits 451fce2..d5e99e5, review clean)
Task 2: INCIDENCIA — el implementador trabajó en el checkout principal, no en el worktree, y commiteó en `main` (98bc478) arrastrando 13 ficheros sin seguimiento de otra sesión. Nada subido a origin. Recuperado a mano en la rama.
Task 2: el `git checkout 98bc478 -- PaperCard.jsx` revertía el 'Source' de la Tarea 1 (el checkout principal no tenía ese commit); aplicado solo el cambio de la etiqueta.
Task 2: Ruling: `main` se resetea a 69027da y los 13 ficheros vuelven a sin-seguimiento (autorizado por Nicolás, 11-09). Hecho; checkout principal restaurado exactamente como estaba. Si me equivoco: el reflog conserva 98bc478.
Task 2: minor (deferred): el regex del test se acopla al formato exacto del código fuente (convención del fichero).
Task 2: minor (deferred): la alternancia negativa incluye 'Open source', que nunca estuvo en ese ternario; inerte, viene del plan.
Task 2: complete (commits d5e99e5..770adc0, review clean)
Task 3: Ruling: acepto el hallazgo Important pese a ser plan-mandated — el revisor probó por mutación que el test pasa aunque se reintroduzca el bug, y la convención del repo (endurecer tests de fuente, comprobar por mutación) pesa más que el texto del plan. Coste si me equivoco: una ronda de arreglo de más.
Task 3: Ruling: la comprobación en vivo (paso 4 del plan) se agrupa en una sola pasada CDP al final, junto con T4, T5, T7, T8 y T10. Coste si me equivoco: un fallo de integración se descubre tarde.
Task 3: minor (deferred): el catch de markNotInterested no revierte el estado optimista si falla la escritura, a diferencia de toggleLike. Preexistente.
Task 3: fix round 1/5 (1 addressed, 0 open — punto ciego del test cerrado y probado por mutación; commits 5f81730..13316a2)
Task 3: complete (commits 770adc0..13316a2, review clean)
Task 4-6: agrupadas en un despacho (tres ediciones pequeñas independientes, regla de batching de la skill).
Task 4: minor (deferred): `report-lede` rompe el prefijo `sr-` del fichero (viene del plan).
Task 4: minor (deferred): el lede no tiene margen superior; mirar si se ve apretado en la pasada en vivo.
Task 4: minor (deferred): themeTransition.js sigue diciendo «420 ms» en comentarios; fuera de alcance de T6.
Task 4-6: complete (commits 13316a2..4187c93, review clean)
Task 7/10: Ruling: se reordena la ejecución a 8, 9, 11 → pasada en vivo (que incluye las sondas previas de 7 y 10) → 7 y 10. Respeta «8 antes que 9 y 11» y la exigencia del plan de medir antes de tocar. Coste si me equivoco: dos tareas se implementan más tarde de lo planeado.
Task 4: pendiente de la pasada en vivo: comprobar si `.gip-title:focus-visible` llega a pintar anillo (si no, la regla y su entrada en la allowlist sobran).
Task 8: fix round 1/5 (2 addressed, 0 open — comentario de activeIndex corregido y regex acotado, probado por mutación; commits 91b8db2..10fd174)
Task 8: minor (deferred): sin manejo de `touchcancel`; el revisor trazó que el valor colgante es inerte.
Task 8: complete (commits 4187c93..10fd174, review clean)
Task 8: CAVEAT que viaja a T9 y T11 — tras montar o reanudar el feed (MOUNT_WINDOW_RESUME_RADIUS=0, settle 400 ms) un barrido rápido puede dejar CERO tarjetas activas hasta que la de destino monta; se autocura.
Task 9: Ruling R4 confirmado: el fixture del plan daba CERO claves (un prefijo DOI necesita 4-9 dígitos); el implementador corrigió el fixture, no la aserción. Correcto.
Task 9: Ruling: acepto I3 pese a ser plan-mandated — el tester pidió justo ver el número, y un contador que no se mueve tras comentar reintroduce la duda que el contador venía a quitar; además comparte maquinaria con I1. Coste si me equivoco: ~12 líneas de más y una ronda extra.
Task 9: Ruling: M2 sube a la ronda de arreglo (sumar dos hilos topados pinta «2000» donde la app pinta «1000+» en el resto de sitios). M1 y M3 también, por baratos. M4 (compuerta de permanencia) se aplaza.
Task 9: Ruling: `main` avanzó a 38c59e5 por otra sesión durante la ejecución. No actúo ahora; hay que rebasar antes de fusionar. Coste si me equivoco: un conflicto al fusionar.
Task 9: minor (deferred): M4 — se cobra lectura por tarjeta cruzada en un barrido, no por tarjeta mirada; dentro del presupuesto 2N.
Task 9: fix round 1/5 (6 addressed: I1 I2 I3 M1 M2 M3, todos probados por mutación; commits 17e563f..b6e5f46). El re-revisor levantó 4 asuntos nuevos del propio arreglo.
Task 9: Ruling: van a una ronda 2 los asuntos 1 (nada afirma la puerta `enabled`, y el comentario dice que sí), 2 (las superficies que no se suscriben pintan un número obsoleto para siempre, antes ponían la palabra) y 3 (el guard no ve imports con comillas dobles ni una segunda llamada sin puerta). El 4 (aislamiento de errores en announce) se aplaza por teórico. Coste si me equivoco: una ronda de más sobre código que ya funciona.
Task 9: minor (deferred): announce() no aísla el error de un watcher; setPainted no puede lanzar en la práctica.
Task 9: minor (deferred): una lectura que falla no se cachea, así que una tarjeta que falla repite 2 lecturas por remontaje. Preexistente, y en invitado no llega a facturar.
Task 9: fix round 2/5 (3 addressed: A, B, C — evidencia por transcripción real esta vez; commits b6e5f46..c900b16)
Task 9: complete (commits 10fd174..c900b16, review clean)
Task 11: el implementador murió por límite de sesión a mitad; dejó PaperCard.jsx modificado sin commit ni informe. DESCARTADO y relanzado. Se conserva su idea: leer `isActive` sin default (undefined) porque el contador quiere que ausente = apagado y la entrada quiere que ausente = encendida.
Task 11: Ruling: ACEPTO el coste de lectura nuevo. Peor caso medido por el revisor: 2 agregaciones por vista de página, acotado por la cache de módulo; las cuatro superficies con muchas tarjetas disparan CERO porque no pasan onOpenComments. La página pública de paper gana el número en su botón, que es justo lo que pidió el tester. Coste si me equivoco: 2 lecturas facturadas por paper distinto en enlaces compartidos anónimos.
Task 11: Ruling: el hallazgo 1 (reduced-motion) es crítico y se arregla — es una regresión de accesibilidad en un repo que hizo una auditoría WCAG de 62 hallazgos, y este cambio la amplifica de una vez por montaje a una por activación.
Task 11: Ruling: el hallazgo 2 (parpadeo al oscilar sobre el borde) se arregla con un pestillo por tarjeta. El revisor tiene razón en que invierte el objetivo de la tarea: el tester pidió suavidad y esto da tartamudeo.
Task 11: Ruling: el hallazgo 3 (la entrada arranca en el punto medio, no al llegar) es plan-mandated y solo se resuelve midiendo; el pestillo del 2 lo mitiga. Va a la pasada en vivo.
Task 11: fix round 1/5 (6 addressed: 1-6; commits e6ed31a..bf713ca). El re-revisor encontró UNA regresión nueva del propio arreglo: `.pc-abstract` perdió su `transition: none` bajo reduced-motion, misma clase de fallo en otra propiedad.
Task 11: Ruling: ronda 2 con tres cosas — restaurar `transition: none` para .pc-abstract, fijar el ORDEN de fuente en el test (la corrección depende de él y nada lo guarda), y acotar el slice de .pc-sheet al cierre de llave. Coste si me equivoco: una ronda más sobre algo que ya casi está.
Task 11: fix round 2/5 (3 addressed: A, B, C + comentarios; commits bf713ca..9866c87). Sin regresiones nuevas; cascada recomputada de forma independiente.
Task 11: minor (deferred): el segundo invariante de orden (el bloque reduce debe ir después de pcArriveAside en :309) queda documentado en comentario, no fijado por test. Ventana de 4 líneas.
Task 11: complete (commits c900b16..9866c87, review clean)
Task 10: Ruling: los cuatro hallazgos Important se arreglan. El 1 (desmontar el diálogo con `open` aún true) puede dejar la página viva pero sin scroll ni clics, que es la trampa que el requisito 4 prohíbe. El 2 (`/` abre la paleta sobre el overlay y deja una entrada varada) es alcanzable con el teclado. El 3 (la guarda de disarm sobrevive a la mutación) va contra la convención del repo. El 4 (marca `overlay` que sobrevive a la recarga) deja el botón Atrás de la página muerto. Coste si me equivoco: una ronda sobre algo que ya funciona en el caso común.
Task 10: Ruling: suben también los minors 5 (try/catch en pushState), 8 (el test fija el texto exacto de la línea del RAF), 9 y 10 (mensajes de test que dicen lo que no comprueban). Los minors 6 y 7 (location global, guardas de typeof window) se aplazan.
Task 10: fix round 1/5 (8 addressed: 1-5, 8-10 + lint; commits 0390818..fda6d74). npm run check verde de punta a punta.
Task 10: complete (commits 9866c87..fda6d74, review clean)
Task 10: Ruling: el revisor encontró una CUARTA pantalla sin cubrir — SearchPage.jsx:238,1418 monta su propio PDFViewer sin el hook, así que Atrás con un PDF abierto desde búsqueda sigue saliendo de PaperTok. Es justo el bug de la tarea en una superficie que el plan no nombró, y el «a veces» del tester encaja. Se arregla junto con la Tarea 7. Coste si me equivoco: tres líneas de más.
Task 10: minor (deferred): Atrás desarma al instante pero el overlay sigue montado durante su salida (220-300 ms); un segundo Atrás dentro de esa ventana navega de verdad con el overlay en pantalla.
Task 10: minor (deferred): `/` queda tragado mientras dura la salida de cualquier diálogo (140-300 ms).
Task 7: complete (commits fda6d74..f90fea1, review clean). Derivación de caja reproducida de forma independiente: 18 px por debajo antes, 30 px por encima después, corrección exacta y estable con --inset-bottom.
Task 10-B (cuarta pantalla): complete (commit 620fe04, review clean). SearchPage comparte la etiqueta 'pdf'; las cuatro son mutuamente excluyentes por rutas hermanas.
Task 7: Ruling: el hallazgo Important (la invariante de etiqueta compartida no está documentada ni testeada) se cierra ahora, antes de la revisión final, junto con los dos minors baratos. Coste si me equivoco: un despacho de más.
Task 10-C (endurecimiento): complete (commit 5e1b703). Invariante de tag compartido documentada, test genérico que encuentra las cuatro superficies, comentario de chunk perezoso corregido.
Task 10-C: minor (deferred): quedan dos puntos rancios adyacentes (el párrafo «onClose must BE» dice «the three owners», y los 4 mensajes de test por fichero siguen diciendo «chunk perezoso»).
Task 10-C: el subagente firmó como Sonnet 5; enmendado a Opus 5 por consistencia con el resto de la rama.
TODAS LAS 11 TAREAS COMPLETAS. Pasa a revisión final de rama.
REVISIÓN FINAL: 2 bloqueantes, 5 no bloqueantes, 16 minors diferidos todos triados como «se llevan».
Ruling final 1: los dos bloqueantes se arreglan. El de tirar-para-refrescar desde el abstracto expandido le quita al usuario el paper que está leyendo con un gesto de lectura normal; el del destello al reanudar pinta la tarjeta entera y luego la borra.
Ruling final 2: subo el NO bloqueante 1 a la oleada. Tras cualquier vuelta atrás al feed, NINGUNA tarjeta anima en toda la visita, lo que anula justo la función que la Tarea 11 vino a dar. La maquinaria para acotarlo (hasArrived) ya existe.
Ruling final 3: cierro por defecto la lectura anónima del contador (NO bloqueante 2). GuestFeedPage pasa onOpenComments y las rules permiten `list` anónimo, así que un visitante sin sesión factura 2 lecturas por tarjeta en la superficie de mayor alcance. Mantengo el botón de comentarios para invitados; solo apago el contador sin sesión. Coste si me equivoco: los invitados no ven el número.
Ruling final 4: el NO bloqueante 4 (prosa rancia: 420 ms en themeTransition, «the three owners», «chunk perezoso») entra por barato. Los no bloqueantes 3 y 5 se llevan.
OLEADA FINAL: 5 addressed (1-5), sin regresiones; las cinco guardas tocadas re-probadas por mutación y dos salieron más fuertes. Commits 5e1b703..e813c68.
Ruling final 5: no hay segunda oleada. Los cuatro residuos que dejó el re-revisor son todos del material de test nuevo (el resolver no modela !important, el re-escaneo de CSS no ve `overflow: hidden auto`, un comentario promete más de lo que el regex hace, y un doesNotMatch demasiado ancho). Ninguno es un defecto del producto. Coste si me equivoco: cuatro guardas algo menos afiladas de lo que dicen.
PASA A VERIFICACIÓN EN VIVO.
VIVO (localhost:5175, invitado, Chrome del pane visible):
  T1 OK: no hay 'Open source' en la tarjeta.
  T2 OK: la etiqueta del ojo dice «Mark as read»; el botón primario sigue diciendo «Read article».
  T4 OK: la hoja abre con scrollTop 0, «TO BEGIN» entero, foco en .gip-title. Y RESUELTO el pendiente: con teclado REAL `:focus-visible` SÍ casa, así que la regla y su entrada en la allowlist están justificadas (no era código muerto).
  T8 OK: píldora «Refresh» a 68 px = nav(56) + 12, centrada sobre el wrapper. La decisión `top: 12px` era la correcta.
  T11 OK: al pasar a la tarjeta 2, pcArrive corre (280 ms, opacity 0 → 1); al volver a la 1 NO repite (data-arrived, animationName none, opacity 1).
  T9 OK: invitado = 0 agregaciones; el botón de comentarios sigue abriendo y muestra la palabra.
  Bloqueante final 1 OK, con control a los dos lados: arrastre hacia abajo desde el cuerpo de la tarjeta refresca (5 fetches, dos veces); el mismo arrastre desde dentro de .pc-abstract--open no hace nada (0 fetches).
  Movimiento reducido: CSSOM confirma las 4 reglas con 9 selectores cada una y el bloque reduce con animation:none Y transition:none. El match de la media query NO se ejerció (el SO del pane la tiene apagada y el pane no expone emulación).
  T3 HALLAZGO: en el feed público Skip NO retira el paper: PaperCard.jsx:1039 corta con `if (publicMode) requireAuthentication(...)`, anterior a esta rama. El tester navegaba como invitado (su captura del onboarding lo prueba), así que lo que vio fue el aviso de sesión. El arreglo de T3 es correcto pero NO es lo que el tester reportó.
  T10 NO VERIFICABLE sin sesión: lector y visor PDF están tras autenticación en la superficie de invitado. No me autentico por el usuario (frontera de verificación).
