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
