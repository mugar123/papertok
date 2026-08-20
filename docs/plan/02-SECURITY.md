# 02 — Seguridad, moderación y confianza

El documento decide cuatro cosas: qué puede y qué no puede garantizar
`firestore.rules` cuando la escritura pasa a ser pública; dónde vive el rate
limiting; cómo modera una sola persona; y cómo se reclama una página de
investigador sin fabricar suplantaciones.

## 1. Reescritura de firestore.rules para escritura pública

### Lo que las rules SÍ validan (y por tanto se exige declarativamente)

Todo el catálogo ya probado en el repo se reutiliza tal cual:

- **Identidad**: `authorUid == request.auth.uid` en cada create; el campo y el
  segmento del ID del doc coinciden donde aplique (`follows/{a}_{b}`).
- **Forma cerrada**: `hasOnly` + `hasAll` por colección, como hoy.
- **Tamaños**: todo string con techo, toda lista con techo (patrón
  `validBoundedStringList`).
- **Inmutabilidad**: en update, los campos congelados se comparan contra
  `resource.data` (`createdAt`, `authorUid`, `canonicalKey`…).
- **Coherencia entre docs del mismo batch**: `getAfter`, como ya hacen
  `publicLists`/`publicListOwners`. Se usa para: handle↔perfil, comentario↔
  throttle, comentario↔increment del contador del stub.
- **Aritmética acotada**: `commentCount == resource.data.commentCount + 1` en
  el update del stub que acompaña a un create de comentario.
- **Timestamps del servidor**: `createdAt == request.time`.
- **Intervalo mínimo entre acciones** (throttle declarativo,
  `00-ARCHITECTURE.md`).
- **Roles binarios**: `isAdmin()` con el UID del administrador cableado en el
  fichero (un UID no es secreto), y "solo servicio" expresado como
  `allow write: if false` en las colecciones que escribe la service account
  (el acceso privilegiado del Worker salta las rules; que el cliente tenga
  `false` es la garantía).

Boceto de los bloques nuevos (ilustrativo, no producción):

```
function isAdmin() { return request.auth != null && request.auth.uid == 'ADMIN_UID'; }

match /papers/{paperKey} {
  allow read: if true;
  allow create: if request.auth != null && validPaperStub()
    && request.resource.data.createdBy == request.auth.uid
    && request.resource.data.commentCount == 0;
  allow update: if isAdmin() || onlyCounterIncrement();   // ±1, resto congelado
  allow delete: if isAdmin();

  match /comments/{commentId} {
    allow read: if true;
    allow create: if request.auth != null && validComment()
      && request.resource.data.status == 'visible'
      && commentThrottleSatisfied();                      // getAfter rateLimits
    allow update: if (isAuthor() && onlyEditsTextAndEditedAt())
      || (isAdmin() && onlyChangesStatus());
    allow delete: if isAuthor() || isAdmin();
  }
}
```

### Lo que las rules NO pueden validar (y qué lo cubre)

| Hueco | Cobertura |
| --- | --- |
| Contenido (insultos, enlaces basura, spam semántico) | Moderación reactiva (§3). Las rules solo acotan longitud. |
| Cuotas por día/semana (las rules no cuentan) | Intervalo mínimo declarativo como primera línea; cuota real solo en rutas Worker (ledger DO). Umbral de migración en `00-ARCHITECTURE.md`. |
| Multicuenta (N cuentas Google gratis) | No se cubre con rules. Mitiga: fricción de crear cuentas, killswitch (§3) y bloqueo por UID en rules si hace falta (lista corta cableada). Riesgo aceptado en pre-producción. |
| Clientes no oficiales contra el API de Firestore | Las rules son la única defensa real (el SDK es público por diseño). App Check podría añadir fricción; **pregunta abierta** en STATE.md: coste/límites de App Check con reCAPTCHA en GitHub Pages, no verificado. |
| Lecturas de docs `hidden` | Un doc oculto sigue siendo legible si la rule de read es `true`. Decisión pendiente de implementación (STATE.md): exigir el `where status=='visible'` en las list-queries vía rules, o aceptar que "oculto" = no lo pinta el cliente oficial y el borrado definitivo es de admin. Para el tamaño del proyecto, la segunda es suficiente y más simple; la primera es posible pero endurece todas las queries. |

## 2. Rate limiting: dónde vive cada capa

1. **Rules (gratis, siempre activo)**: intervalo mínimo por acción y usuario
   vía `users/{uid}/rateLimits/{action}`. Valores iniciales: comentarios 15 s,
   anotaciones 30 s, reportes 60 s, stubs 30 s. Ajustables sin migración.
2. **Worker (rutas que ya pasan por él)**: `RequestQuotaLedger` existente.
   F7: cuotas duras por emisor, receptor y globales (§4). F6: intentos de
   verificación 5/día/usuario.
3. **Backstop involuntario**: la cuota diaria del free tier de Firestore.
   Un ataque sostenido agota cuota y la app degrada; no hay factura sorpresa
   con el plan Spark. Es feo pero es un techo real.
4. **Killswitch (§3)**: apagado de emergencia por colección.

Lo que NO hay: rate limiting fino en escrituras directas. Es el precio de no
proxificar comentarios; la decisión y su umbral de reversión están en
`00-ARCHITECTURE.md`.

## 3. Moderación con un administrador humano

Principios: nada requiere respuesta en tiempo real; todo estado es reversible;
el admin tiene un botón de apagado general que no depende de deploy.

**Flujo de un reporte:**

1. Usuario reporta → `reports/{id}` (`status: 'open'`), throttled.
2. El contenido reportado **sigue visible**. Auto-ocultar al N-ésimo reporte
   sería brigadeable (N cuentas = censura gratuita de cualquier comentario) y
   con una base de usuarios pequeña un N seguro no existe. A cambio, el
   reportante deja de verlo localmente de inmediato (estado en cliente).
3. Cola de admin: ruta oculta en la propia app, query
   `reports where status=='open' orderBy createdAt limit 50`. Acciones por
   ítem: ocultar (`status:'hidden'` en el doc de contenido), borrar,
   descartar el reporte, o bloquear autor (lista corta en rules — requiere
   deploy de rules, aceptable como acción excepcional).
4. Cierre: `status: 'resolved' | 'dismissed'` en el reporte.

**Cadencia sostenible**: revisar la cola es una tarea de minutos, 2-3 veces
por semana, con aviso opcional por el propio sistema de email del Worker
(digest de reportes abiertos reutilizando el cron existente — barato porque el
Worker ya envía digests). Si la cola supera lo que cabe en 15 min/día, ver el
umbral de migración de `00-ARCHITECTURE.md` y los recortes de `05-RISKS.md`.

**Killswitch**: doc `config/moderation` `{ commentsFrozen, annotationsFrozen,
relayFrozen }`, escribible solo por admin, leído por las rules con `get()` en
los creates (+1 lectura facturada por create, aceptable) y por el Worker en
sus rutas. Congelar comentarios en toda la app es un write desde el móvil del
admin, sin deploy.

**Qué pasa con un comentario reportado mientras se revisa**: visible para
todos salvo el reportante; editable por su autor (la edición no borra el
reporte); si el admin lo oculta, deja de renderizarse para todos y el autor lo
ve marcado como oculto en "mis comentarios". El borrado por el autor cierra
los reportes pendientes como `resolved` (lo hace el admin al encontrar el
target borrado; no hay automatismo).

## 4. F7 — Relay de correo sin exponer el email

Regla dura: **el email del destinatario no viaja nunca al cliente**; tampoco
se persiste en Firestore. El Worker lo resuelve en el momento del envío vía
`accounts:lookup` administrativo (identidad de servicio) y lo usa una vez.

Flujo `POST /relay/contact` (Worker, autenticado):

1. Verifica el token del emisor (mecanismo existente). Para esta ruta, **sin**
   el cache de 60 s: es de bajo volumen y alto valor.
2. Carga `userProfiles/{targetUid}` (lectura REST con identidad de servicio):
   exige `allowContact == true`. Opt-in, default false.
3. Cuotas en `RequestQuotaLedger`: emisor 5/día, receptor 10/día, global
   200/día. Además `relayFrozen` del killswitch.
4. Cuerpo: texto plano ≤2.000 chars. El Worker compone el email con plantilla
   propia: identidad del emisor = su `displayName` + `handle` + enlace a su
   perfil público. Nada de HTML del usuario.
5. `Reply-To`: decisión de producto con dos opciones — (a) el email real del
   emisor, con aviso explícito en la UI de envío ("al responder, verá tu
   dirección"): simple, una ida; (b) sin Reply-To y la respuesta se hace
   contactando al emisor por la app: simétrico en privacidad, dobla la
   fricción. **Recomendada (a) con consentimiento explícito**: el emisor
   elige exponerse a sí mismo, nunca al receptor.
6. Pie obligatorio: enlace de opt-out con token firmado (mismo mecanismo KV
   que el unsubscribe de digests, que ya existe) que pone
   `allowContact: false` sin abrir la app, y enlace de reporte.
7. Envío por Brevo/Resend con el ledger de entrega existente.

Abuso residual: contenido ofensivo dentro del mensaje relayado. Mitigación:
cuotas bajas, opt-in, opt-out de un clic, y el reporte llega con el
`reporterUid` del receptor real. Sin escaneo de contenido (no hay presupuesto
ni volumen que lo justifique).

## 5. F6 — Reclamación de página de investigador (vector crítico)

Una reclamación une `uid` ↔ investigador real. Si falla, es suplantación de
una persona identificable con nombre y obra. Diseño conservador: **la única
vía automática es ORCID OAuth; todo lo demás pasa por revisión manual del
admin o no otorga reclamación en absoluto.**

### Qué confianza da cada vía

| Vía | Qué prueba | ¿Reclama página? |
| --- | --- | --- |
| ORCID OAuth (code flow vía Worker) | Control real de la cuenta ORCID: el id_token firmado por `https://orcid.org` trae el iD en `sub` | **Sí, automática.** La página queda ligada al iD, no a un nombre. |
| Correo universitario verificado | Afiliación a un dominio académico. **No** prueba ser el autor de nada | **No.** Otorga a lo sumo insignia de afiliación; una reclamación por esta vía va a cola manual con evidencia adicional (p. ej. el email coincide con el de correspondencia de papers del ORCID reclamado) y el admin decide. |
| GitHub OAuth | Control de una cuenta GitHub | **Ninguna confianza** para esto. Es solo login (F5). |

### Homónimos: se esquivan, no se resuelven

La página de investigador se indexa **por ORCID iD** (`researcherClaims/{orcidId}`),
nunca por nombre. Sus obras se listan pidiendo a los proveedores "papers con
este ORCID" (OpenAlex expone el filtro por ORCID en autores). Prohibido en
diseño: vincular por coincidencia de nombre entre un usuario y una entidad de
autor de OpenAlex. Si un autor de OpenAlex no tiene ORCID asociado, su página
no es reclamable — se dice así en la UI en lugar de inventar una heurística.
Dos investigadores homónimos tienen dos iDs distintos y dos páginas distintas;
el problema de "¿cuál de los dos Wang es?" queda en el proveedor de datos,
que es donde está la información para resolverlo.

### Disputas y reversión

- **Unicidad**: `researcherClaims/{orcidId}` hace imposible la doble
  reclamación silenciosa: la segunda encuentra el doc y no puede crearse
  (solo escribe el servicio, que detecta el conflicto).
- **Disputa**: si alguien afirma que un iD reclamado no pertenece a quien lo
  reclamó (vía reporte), el admin marca `status: 'disputed'`: la página deja
  de mostrar el vínculo con el perfil de usuario (la insignia se retira) pero
  no se borra nada. Resolución manual; con OAuth de por medio, el caso
  esperable es cuenta ORCID comprometida, no reclamación falsa.
- **Reversión**: `status: 'revoked'` en claim y verificación +
  `verified: false`, `orcid: null` en el perfil (todo escrito por el
  servicio en una operación). Los comentarios/anotaciones del usuario
  permanecen, sin insignia. El iD queda libre para re-reclamarse.
- **Ventana de honestidad en la UI**: la insignia dice "ORCID verificado" y
  enlaza al iD; no dice "esta persona es X". La app afirma exactamente lo que
  ha comprobado y nada más.

## 6. Endurecimientos del Worker que este plan asume

- Las rutas nuevas (`/relay/*`, `/verify/*`) verifican token **sin** el cache
  de 60 s de `firebase-auth.js` (un token revocado no debe poder enviar email).
- Nota de deuda preexistente (no bloquea): hay una segunda implementación
  divergente de verificación en `email-notifications.js:688-709`; unificar
  cuando se toque el Worker. Registrado en STATE.md.

## 7. F9 — Búsqueda de usuarios: buscar es enumerar, y el diseño lo asume

Las rules no pueden distinguir "búsqueda" de "volcado": ven `limit` y
`orderBy` de una query, pero **no los valores de los `where`**, así que
cualquier índice consultable por prefijo es enumerable paseando prefijos con
paciencia. Prometer lo contrario sería mentira; lo que sí se decide es **qué
obtiene quien enumera y cuánta fricción paga**. La revisión de F1 cerró
`list` en `userProfiles/` y `handles/` porque el premio era el directorio
completo con fotos y bios, anónimo y a cuota ajena. F9 no reabre eso: crea
`userSearch/{uid}` (modelo en `01-DATA-MODEL.md`) donde el premio de la
enumeración se reduce a *handle + nombre en minúsculas de quien eligió ser
público* — datos que ya se sirven uno a uno por `allow get` del perfil — y la
fricción sube: hace falta sesión (una cuenta real, bloqueable por UID en
rules con la lista corta de §1), el techo `limit ≤ 20` lo impone el servidor
(el patrón verificado de `follows/` en producción), y el backstop sigue
siendo la cuota diaria del free tier (§2.3).

### Los perfiles privados no se filtran: no están

La garantía de F8 ("un perfil privado no aparece en resultados") no se
implementa filtrando resultados en cliente, que un cliente modificado
ignoraría. Un perfil privado **no tiene documento en el índice**:

- Escribir en `userSearch/{uid}` exige, vía `getAfter`, que el perfil quede
  **público** tras el batch.
- La dirección a prueba de fallos vive en `userProfiles/`: toda escritura que
  deje el perfil privado, y el delete del perfil, exigen
  `!existsAfter(userSearch/{uid})` — volverse privado sin salir del índice no
  es un bug improbable, es una escritura que Firestore rechaza.
- Los handles de perfiles privados siguen sin ser enumerables (`handles/`
  conserva `list: if false`); siguen siendo *sondeables* por `get` exacto,
  que es exactamente lo que F8 ya documenta y avisa en pantalla.

Boceto (ilustrativo, no producción):

```
match /userSearch/{uid} {
  allow get: if false;                    // nadie necesita un doc suelto
  allow list: if request.auth != null
    && request.query.limit <= 20;         // techo servidor, patrón follows/
  allow create, update: if request.auth != null && request.auth.uid == uid
    && request.resource.data.keys().hasOnly(['handle','nameLower','createdAt'])
    && profileIsPublic(getAfter(/…/userProfiles/$(uid)).data)
    && request.resource.data.handle == getAfter(/…/userProfiles/$(uid)).data.handle
    && request.resource.data.nameLower
       == getAfter(/…/userProfiles/$(uid)).data.displayName.lower();
  allow delete: if request.auth != null && request.auth.uid == uid;
}
// y en userProfiles/{uid}: toda escritura que deje el perfil privado, y el
// delete, exigen además !existsAfter(/…/userSearch/$(uid))
```

### Lo que las rules SÍ validan aquí, y lo que no

- **Sí**: que `nameLower` deriva del `displayName` real (`.lower()` sobre el
  perfil post-batch). Sin esa igualdad, un cliente podría rellenar el campo
  con tokens ajenos ("taylor swift") para colarse en búsquedas de otros — la
  superficie clásica de los índices mantenidos por el cliente, cerrada aquí
  por construcción. Handle coherente, forma cerrada, tamaños, `createdAt` de
  servidor: el catálogo de §1.
- **No**: la frescura en la dirección abierta. Si un guardado de perfil
  renombra `displayName` sin tocar el doc de búsqueda (el servicio siempre
  hace ambos en un batch; esto sería un bug de cliente), el índice sirve un
  nombre rancio hasta el siguiente guardado. Es deriva cosmética, nunca de
  privacidad: la dirección que importa (privado ⇒ fuera) sí está en rules.
- **No**: el ritmo de las lecturas. No hay throttle de búsquedas en rules
  (los `rateLimits/` de §2 gobiernan escrituras); las capas reales son la
  sesión obligatoria, el `limit`, el debounce del cliente oficial y la cuota
  diaria. Aceptado igual que en `follows/`, cuyo grafo también es enumerable
  con sesión.

### Límites de la búsqueda y escalada sin motor

Es búsqueda por **prefijo desde el inicio del campo**: "nico" encuentra a
"Nicolás Muñoz" por nombre y "@nick_mugar" por handle; "muñoz" no encuentra
nada, y no hay plegado de acentos ni tolerancia a typos (la derivación
verificable en rules es `.lower()` y solo eso; normalizar acentos en cliente
haría inverificable la derivación y reabriría el stuffing).

Escalada si el prefijo se queda corto, **sin motor externo y aún verificable**:
campo `nameTokens` (lista de palabras del nombre en minúsculas, separadas por
espacio simple normalizado en cliente) con la igualdad
`nameTokens.join(' ') == displayName.lower()` en rules, consultado con
`array-contains` para palabra exacta — "muñoz" pasa a encontrar. Motor
externo (Algolia y compañía) solo si algún día hicieran falta typos, con dos
costes: el precio (04-PHASES) y el problema estructural de sync — sin Cloud
Functions no hay trigger, el Worker no ve las escrituras de perfil, y
sincronizar desde el cliente exige exponer una clave de escritura del índice,
que es esta misma sección otra vez pero en un servicio sin rules.

## 8. F10 — Privacidad granular: lo que cada interruptor esconde, y lo que no

Tres interruptores (`04-PHASES.md` P17): me gusta públicos, guardados
públicos, lista de seguidores pública. Los dos primeros ABREN datos que hoy
son privados; el tercero CIERRA un dato que hoy es público. Esta sección fija
qué promete cada uno, porque prometer de más aquí es mentir con rules
delante.

### Me gusta / guardados: proyección, no apertura

Las colecciones de origen (`users/{uid}/interactions`, `savedPapers`) llevan
telemetría de comportamiento y notas; no se abren ni condicionalmente
(seguridad por campo no existe — la misma razón del stash de pines de F8).
Lo público es una proyección acotada (`01-DATA-MODEL.md`) cuya existencia es
el interruptor:

- **Dirección crítica, en rules**: la estantería no puede existir con el
  perfil privado (la escritura exige `visibility == 'public'` explícito tras
  el batch), y volverse privado o borrar el perfil exige `!existsAfter` de
  las dos estanterías. Apagar = borrar el doc: instantáneo, atómico y
  verificable. El emulador cubre las seis denegaciones y el ciclo completo
  (`tests/p17-measure.test.js`, a promover a la suite al implementar).
- **Dirección abierta, aceptada**: las rules no verifican que las tarjetas
  sean tus me gusta REALES (costaría un acceso a documento por tarjeta; no
  cabe y no hace falta). Autoinventarse la estantería es mentir en la propia
  bio: sin víctima tercera. El caso CON víctima — indexarte con el nombre de
  otro para colarte en sus búsquedas — es el de F9 y sigue cerrado allí.
- **Frescura**: proyección perezosa. Quitar un like desde el feed persiste
  en la estantería hasta el próximo refresco (la visita al propio perfil);
  la retirada TOTAL — apagar el interruptor, volverse privado — sí es
  inmediata y por rules. El mismo trato que la deriva abierta de F9, y dicho
  en la copy del interruptor.
- Quien enumera con sesión gana: las últimas ≤6 tarjetas de quien ELIGIÓ
  publicarlas. Sin foto, sin bio, sin totales y sin timestamps por tarjeta.

### Seguidores: se cierra la puerta, no el grafo

La arista de follow es un dato COMPARTIDO entre dos cuentas, y eso pone el
límite de lo prometible:

- **Lo que cierra** (matriz medida contra el emulador): la query "quién
  sigue a X" — lista y `count()` — y el `get` de una arista ajena hacia X se
  deniegan a extraños cuando X apaga `showFollowers`. El propio X lo sigue
  viendo todo; cada seguidor sigue viendo su propia arista; seguir a X sigue
  permitido.
- **Lo que NO cierra, dicho en la copy**: cada seguidor tuyo sigue mostrando
  "a quién sigo" en SU perfil, y esa dirección queda abierta — con sesión y
  paciencia, un tercero puede reconstruir parte de tu lista paseando las
  listas de seguidos de candidatos. Cerrarlo exigiría que TU flag gobernara
  las queries sobre OTROS perfiles: o un `get` por arista pintada o
  denormalizar tu flag en N aristas ajenas — las dos cosas que este proyecto
  no paga, y la segunda es además el sitio exacto donde un bug rompe la
  sincronía. La promesa honesta: "tu lista de seguidores deja de poder
  consultarse desde tu perfil".
- **El mecanismo de la doble dirección en una sola rule de `list`**: la
  igualdad de la query sobre `followerUid` permite al motor probar
  `resource.data.followerUid is string`, así que la rama de "siguiendo"
  queda abierta sin abrir la de seguidores (verificado contra el emulador —
  no era obvio que el solver lo probara). Efecto colateral aceptado: una
  query de `follows/` sin filtro por ninguno de los dos uids pasa de
  permitida (solo el techo de `limit`) a denegada; ningún camino de la app
  la hace.
- El flag vive en el perfil y es legible con él: "este perfil oculta sus
  seguidores" es observable, igual que el propio rechazo de la query.
  Meta-privacidad revelada y asumida — el killswitch de §3 sentó el
  precedente ("refusal itself is observable").
- Coste del cierre: +1 lectura de rules (el `get` del flag) por query de
  seguidores de terceros. La dirección "siguiendo" no paga nada.

### El presupuesto mandó sobre la forma

El límite de 1000 expresiones por evaluación gobernó el diseño entero: los
interruptores de me gusta/guardados NO son campos del perfil porque la
variante con campos más cláusula de coherencia perfil↔doc bajaba el tope de
pines de 6 a 5 (medida y descartada); la embarcada deja el techo en 6/6/6 —
guardado, renombre y salida a privado con todo vivo — y cada estantería
aguanta 8 tarjetas por evaluación (tope 6, holgura 2). Números y método en
`tests/p17-measure.test.js`.
