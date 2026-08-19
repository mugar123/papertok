# 03 — Autenticación e identidades

Estado actual verificado: **solo Google por popup**
(`src/services/firebase.js`, `AuthContext.jsx:142`). Cero infraestructura de
linking: ninguna referencia a `linkWithCredential`, `OAuthProvider` ni
`fetchSignInMethodsForEmail` en el repo. El modo invitado es navegación
pública sin sesión de Auth (no hay auth anónima que migrar).

## F5 — Login con GitHub (proveedor nativo)

Vía estándar de Firebase Auth: `GithubAuthProvider` + `signInWithPopup`. Sin
implicaciones de tier: los proveedores OAuth sociales están en el plan
gratuito actual del proyecto.

Lo único no trivial es la **colisión de email**. Firebase por defecto exige
una cuenta por email: si `nico@gmail.com` ya entró con Google y prueba GitHub
(mismo email), el popup falla con `auth/account-exists-with-different-credential`
y hay que guiar: "esta cuenta entra con Google; entra con Google y vincula
GitHub desde ajustes". El flujo de vinculación es `linkWithPopup` sobre el
usuario ya autenticado, y a partir de ahí ambos proveedores abren el mismo
`uid` (mismo árbol Firestore, cero migración de datos).

Diseño de producto que evita casi todos los conflictos: **GitHub se ofrece
primero como "vincular" en ajustes** para usuarios existentes, y como opción
de login en la pantalla de entrada para usuarios nuevos.

Cuidado verificable en implementación (pregunta abierta en STATE.md): con la
protección contra enumeración de emails activada, `fetchSignInMethodsForEmail`
devuelve información limitada, y el mensaje "entra con Google" hay que
construirlo desde el propio error de colisión, no desde esa API.

Acción humana previa: registrar la OAuth App en GitHub (callback:
`https://<proyecto>.firebaseapp.com/__/auth/handler`) y activar el proveedor
en la consola de Firebase con su client ID/secret.

## F6 — ORCID

Hechos verificados (2026-08): ORCID es un proveedor OIDC estándar. Issuer
`https://orcid.org`, discovery en `/.well-known/openid-configuration`, claves
en `/oauth/jwks`, code flow e implicit, `userinfo` con bearer. El `id_token`
es un JWT firmado cuyo `sub` es el ORCID iD. El scope `openid` funciona con
el API público (gratuito). Fuentes: doc oficial de ORCID
(github.com/ORCID/ORCID-Source, `ORCID_AUTH_WITH_OPENID_CONNECT.md`).

### Vía A — Proveedor OIDC genérico en Firebase

Verificado: exige **upgrade a Firebase Authentication with Identity Platform**
(firebase.google.com/docs/auth/web/openid-connect). Implicaciones de precio
(cloud.google.com/identity-platform/pricing, contrastado 2026-08):

- OIDC/SAML son "Tier 2": **gratis hasta 50 MAU**, después ~$0.015/MAU.
- El upgrade cambia el modelo de todo el proyecto: los proveedores sociales
  pasan a "Tier 1" con 50.000 MAU gratis (hoy, sin upgrade, no tienen tope).
  A la escala del proyecto ambos topes quedan lejos, pero es un cambio de
  contrato de facturación, no solo una feature.

Pros: login "Entrar con ORCID" de verdad, tokens gestionados por Firebase,
`linkWithPopup` estándar. Contras: upgrade de facturación, tope de 50 MAU
gratis precisamente en el segmento de usuarios que más interesa (investigadores
activos), y añade un tercer proveedor de login que multiplica los casos de
colisión/vinculación.

### Vía B — ORCID como verificación, no como login (recomendada)

El objetivo real de F6 no es "entrar con ORCID": es **probar que este usuario
controla este ORCID iD**. Eso no necesita Identity Platform:

1. El usuario, ya autenticado (Google/GitHub), pulsa "Verificar con ORCID".
2. Redirección al authorize de ORCID con el client ID público. La
   `redirect_uri` es **una ruta del Worker**, no de GitHub Pages — esquiva el
   problema de que HashRouter no puede recibir parámetros de OAuth de forma
   limpia y mantiene el `code` fuera del cliente.
3. El Worker (que guarda el client secret de ORCID en `wrangler secret`)
   intercambia el code, y **valida el id_token de verdad**: firma contra el
   JWKS de ORCID, `iss`, `aud`, `exp`, `nonce`. Ojo: esto es más estricto que
   el patrón actual del Worker (que delega en `accounts:lookup`); aquí no hay
   a quién delegar.
4. Con el `sub` (ORCID iD) y el token de Firebase del paso 1 verificados, el
   Worker escribe con la identidad de servicio: `researcherClaims/{orcidId}`,
   `researcherVerifications/{uid}` y los flags del perfil. Conflictos y
   disputas: `02-SECURITY.md` §5.
5. Redirección de vuelta a la app.

Coste: código de Worker (una ruta + validación JWT) y la identidad de
servicio que F7 ya exige. Cero cambio de facturación, cero proveedor de login
nuevo, cero casos de linking nuevos. La página de investigador y la insignia
solo necesitan exactamente esto.

**Decisión propuesta: Vía B para F6.** La Vía A queda como extensión opcional
solo si algún día hace falta que alguien entre *sin* cuenta Google/GitHub; se
reevaluaría entonces con el precio vigente.

Preguntas abiertas (en STATE.md): condiciones exactas del registro de cliente
del API público de ORCID (redirect URIs permitidas, si exige HTTPS propio),
detalles del sandbox (`sandbox.orcid.org`) para desarrollar sin tocar
producción, y si el `id_token` incluye `name` con scope `openid` solo.

## Correo universitario sin servicio de pago

Objetivo honesto: probar **afiliación a una institución**, nada más. No prueba
autoría ni identidad (§5 de `02-SECURITY.md`: nunca otorga página de
investigador por sí solo).

Flujo (todo con piezas que ya existen en el Worker):

1. El usuario introduce su email institucional en ajustes.
2. `POST /verify/edu` (Worker, autenticado): valida el dominio contra la
   lista (abajo), genera token firmado de un solo uso en KV con TTL 24 h
   (mismo mecanismo que los tokens de unsubscribe) y envía email de
   confirmación por Brevo/Resend.
3. El clic en el enlace llega al Worker, que consume el token y escribe
   `researcherVerifications/{uid}` `{ method: 'edu-email', eduDomain }` y la
   insignia de afiliación en el perfil. El email en sí **no se persiste** en
   Firestore; solo el dominio.
4. Caducidad: la verificación expira a los 12 meses (campo `verifiedAt`;
   la UI pide renovar). La gente cambia de institución.

**La lista de dominios sin trabajo infinito:**

- Semilla: dataset abierto de dominios universitarios (existe uno
  comunitario ampliamente usado en GitHub, "university domains list";
  confirmar licencia al implementar — pregunta abierta). Se carga una vez
  en KV del Worker.
- Matching por sufijo contra el dominio base registrado (`cs.stanford.edu`
  casa con `stanford.edu`). Los dominios de alumni cuentan: el badge dice
  afiliación, y un alumnus la tiene; no fingimos más precisión de la que hay.
- Dominio desconocido: la petición no falla — queda `pending-domain` y le
  llega al admin en el digest de moderación. Aprobar = una escritura en KV
  desde una ruta de admin del Worker. Solo el primer usuario de cada dominio
  nuevo genera trabajo; después es automático.

**Comparativa con la alternativa de pago** (contexto: SheerID y similares
quedaron descartados por presupuesto):

| | Coste dinero | Coste tiempo | Riesgo |
| --- | --- | --- | --- |
| Servicio de pago (descartado) | Suscripción (no verificado el precio; fuera de presupuesto por decisión) | Integración pequeña | Bajo; verificación de estatus real (estudiante/staff) |
| Dominio + confirmación + revisión manual (elegida) | 0 € (envíos dentro del tier de Brevo/Resend ya en uso) | ~1 sesión de Worker + goteo de aprobaciones de dominio | Medio: prueba dominio, no estatus; mailbox compartida o alumni pasan; aceptable porque solo da insignia de afiliación |
| Solo revisión manual (sin email) | 0 € | Todo recae en el admin | Alto y no escala ni a 20 usuarios |

## Vinculación de identidades y conflictos

Con la Vía B, el mapa se queda deliberadamente simple: **el `uid` de Firebase
es la identidad; Google y GitHub son puertas al mismo `uid`; ORCID y el email
edu son verificaciones colgadas del `uid`, no identidades.**

| Escenario | Qué pasa | Política |
| --- | --- | --- |
| Google y GitHub, mismo email | Colisión al segundo login | Guiar a entrar con el original y `linkWithPopup`. Mismo `uid`, cero migración. |
| Google y GitHub, emails distintos, usados a ciegas | Dos `uid`, dos árboles Firestore | **No se fusionan automáticamente.** La app permite vincular el segundo proveedor al `uid` bueno solo si la cuenta accidental está vacía (heurística: sin interacciones); si no, el usuario elige cuál conserva. Fusión de árboles = migración manual asistida por admin, fuera de alcance; se documenta como limitación. |
| ORCID ya reclamado por otro `uid` | El servicio detecta `researcherClaims/{orcidId}` ocupado | No escribe; el segundo usuario ve "este iD ya está reclamado; ¿disputar?" → cola manual (`02-SECURITY.md` §5). |
| Mismo usuario, ORCID en cuenta A y quiere moverlo a B | Revocación + re-verificación | El servicio revoca en A (a petición del propio A autenticado) y B re-verifica por OAuth. Nunca "transferencia" sin pasar por OAuth de nuevo. |
| Borrado de cuenta | `uid` desaparece de Auth | La verificación se revoca (claim liberado); el contenido público del usuario queda huérfano visible (`authorHandle` snapshot) hasta limpieza de admin. Detalle en `05-RISKS.md`. |

## Acciones humanas previas (bloqueos exactos)

1. **GitHub**: crear OAuth App (callback del auth handler de Firebase) y
   activar proveedor en la consola. Sin esto no hay F5.
2. **ORCID**: crear cuenta ORCID si no la hay, registrar cliente del API
   público con `redirect_uri` = URL del Worker; obtener client ID y secret;
   `wrangler secret put`. Sin esto no hay F6-OAuth. (Decisión previa
   respetada: la app OAuth aún no está registrada.)
3. **Service account**: crearla en Google Cloud con rol mínimo de Firestore,
   descargar clave, `wrangler secret put`. Bloquea F6 y F7.
4. **Admin UID**: copiar el UID propio a las rules (`isAdmin()`).
