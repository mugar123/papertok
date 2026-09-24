# Auditoría de doce fallos reportados — 2026-09-23

Doce síntomas de un informe externo, recogidos casi todos sin sesión y con la
interfaz en español.

**Nada está arreglado.** Esto es el diagnóstico, con la medición que lo sostiene.

**Sobre qué se midió.** El código auditado es `main` en `a63f919`, que es lo que sirve
producción: el HTML de `papertok.app` llevaba 4 h en la caché de Vercel, desde el
despliegue de ese commit. Las comprobaciones en vivo se hicieron contra papertok.app y
api.papertok.app:

- Un Chrome headless con perfil limpio, conducido por CDP: invitado nuevo, interfaz en
  español y las rutas `/ai/*` bloqueadas en la red para no gastar cuota.
- curl contra las APIs de origen: bioRxiv, Wikipedia, OpenAlex, OpenAIRE, NCBI y Europe
  PMC.
- Módulos del repo ejecutados en Node, sin tocar el árbol de trabajo.

Cuando un fichero tenía cambios sin commitear de otra sesión (`domainSourceService.js`,
`latex.js`), se leyó `HEAD`.

**Veredicto de conjunto:** los doce se confirman, total o parcialmente. Tres son peores
de lo que decía el informe:

- **La vista previa no mezcla nunca dos áreas**, sean las que sean: la llena la primera
  fuente que contesta.
- **En español, la caja de Wikipedia falla en el 95 % de los conceptos.** No es un caso
  raro.
- **Un autor sin id se resuelve mal casi siempre:** 0 aciertos de 25 con «Li WN».

Dos de los doce tienen parte de decisión de producto (el 9 y el 10): la puerta está
puesta a propósito, pero no explica nada.

| # | Síntoma | Veredicto | Causa raíz | ¿Nuestro código? | Gravedad |
|---|---|---|---|---|---|
| 1 | Informática + Medicina: las 12 de la vista previa son de IA | **Confirmado, y peor** | La primera rama que contesta llena las 12 plazas y las tardías no entran nunca. Al recargar salen 12 de Medicina | Sí | **Alta** |
| 2 | «Conexiones» sin cuenta dice «No se pudieron cargar» | **Confirmado** | El botón no mira `publicMode`, y el cliente falla con `WORKER_AUTH_REQUIRED` antes de pedir nada | Sí | Media |
| 3 | «Tumor progression» enseña a Allan Balmain | **Confirmado, y peor** (95 % de conceptos en español) | Búsqueda de texto libre en Wikipedia y primer resultado; nadie lee el Wikidata que trae OpenAlex | Sí; OpenAlex tiene el dato bien | **Alta** |
| 4 | Autores enlazados solo por el nombre | **Confirmado, y peor** (0 de 25 con «Li WN») | Búsqueda por nombre con un comparador laxo, y un perfil que añade búsquedas por nombre | Sí, más conglomerados de OpenAlex | **Alta** |
| 5 | Compartir enseña «PaperTok»; canonical a /feed | **Confirmado** | SPA sin cabecera por ruta, canonical fijo, la API prohíbe el rastreo y no hay sitemap de papers | Sí, por arquitectura | Media |
| 6 | Resúmenes pegados; editoriales enteros | **Confirmado** | OpenAlex indexa el editorial entero y lo aceptamos; además, nuestro lector de Europe PMC **borra texto** | Datos de origen y nuestro lector | Media |
| 7 | «Humans», «Female», «MEDLINE» | **Confirmado** | *Check tags* de MeSH sin filtrar y el concepto MEDLINE de OpenAlex sin umbral | Sí | Media |
| 8 | Etiquetas en inglés con la interfaz en español | **Confirmado**, en parte nuestro | El chip pinta la etiqueta cruda aunque ya tiene la española; el resto es texto libre | En parte | Media / Baja |
| 9 | «Leer en simple» pide cuenta sin avisar | **Confirmado**; la puerta es deliberada | El motivo se pierde antes del diálogo, y la bienvenida promete «cada uno» | Sí | Media |
| 10 | El buscador sin cuenta no deja escribir | **Confirmado**; el bloqueo es deliberado, la falta de explicación no | Campo `readOnly` sin explicación; con teclado, silencio | Sí | Media |
| 11 | Rendimiento | **Confirmado 2 de 3**; el «26» no se reproduce (medimos 71) | La muestra por defecto se carga tras la bienvenida; bioRxiv caído sin caché del fallo; OpenAIRE da 400 | En parte | Media |
| 12 | Capítulos «Preprint», sin 404, sin h1 | 404 **confirmado**; h1 y «Preprint» **parciales** | Comodín `Navigate`; faltan h1 en invitado, paper y búsqueda; expresión regular de arXiv | Sí | Baja |

---

## Fallo 1 — La vista previa no mezcla áreas: la llena la primera fuente que contesta

### Qué se ve

Medido en producción con un invitado nuevo (Chrome headless, perfil limpio, interfaz
en español), eligiendo Informática + Medicina: las 12 tarjetas son **10 de Hugging
Face y 2 de OpenReview, todas de IA**. Al recargar la página poco después, con los
mismos intereses guardados: **12 de PubMed** (11 de cardiología, 1 de oncología) y
ninguna de Informática.

Repetido con otro perfil nuevo, el resultado fue idéntico: tras elegir, otra vez 10 de
Hugging Face y 2 de OpenReview (arXiv contestó a los 59 ms, pero el dominio llegó a
los 3); al recargar, otra vez 12 de PubMed. Hasta la muestra por defecto, que mezcla
seis campos, salió en esa visita entera de neurociencia: 10 de bioRxiv y 2 de Europe
PMC.

O sea, el síntoma del tester es solo una de las caras. Medicina sí puede salir, pero
**dos áreas no salen nunca juntas**.

### Qué hay detrás

`useGuestFeed` lanza cuatro ramas a la vez y en este orden
(`src/hooks/useGuestFeed.js:26-47`): arXiv (6 categorías de cs, 12 resultados),
OpenAlex (una consulta mixta), fuentes de dominio (`fetchDomainPapers`, hasta 20) y
PubMed (3 categorías de med, 25 resultados). Después:

1. `settleSourcesForFirstPaint` (`src/utils/asyncTiming.js:52-83`) resuelve `first`
   **en cuanto lo que ya ha llegado suma 4 papers** (`GUEST_EARLY_PAINT_COUNT`). No
   espera a una segunda fuente.
2. `early = … fulfilledPaperLists(await first) … .slice(0, GUEST_PAGE_SIZE)`
   (`useGuestFeed.js:139-141`): las listas se concatenan en el orden de petición y se
   cortan a 12. **Una rama sola con 12 papers llena la página.**
3. Lo tardío entra por `mergeKeepingShownOrder(current, late, 12)`
   (`useGuestFeed.js:62-71` y `:162`), que hace `[...shown, ...extra].slice(0, 12)`.
   Con 12 tarjetas ya en pantalla, `extra` se descarta entero. **Una rama que
   contesta tarde no entra nunca.**

La carrera no la deciden los intereses, la deciden las cachés:

- Las dos fuentes de dominio de Informática (OpenReview y Hugging Face) están en la
  caché de borde del Worker (30 y 15 min) y contestan en 3-4 ms. Además, en la
  página 1 **las dos buscan siempre la etiqueta de la primera categoría del plan,
  «Artificial Intelligence»** (`domainSourceService.js:643-661` en HEAD). De ahí
  «todas de IA».
- PubMed tiene encima una caché en `localStorage` de 10 minutos
  (`PubmedAdapter.js:170-176`, `src/utils/sourceCache.js`). En una segunda visita
  contesta sin tocar la red y **gana siempre**. De ahí las 12 de medicina al recargar.
- Medicina está peor servida desde el plan: solo PubMed (3 categorías) y media
  consulta de OpenAlex. `getDomainSourcePlan` solo manda a Europe PMC y bioRxiv las
  categorías `bio.*` (`domainSourceService.js:481-525`), así que **ninguna categoría
  `med.*` tiene fuente de dominio**.

### Reproducción determinista

Un script en Node con las funciones reales del repo
(`settleSourcesForFirstPaint`, `fulfilledPaperLists`, `PaperBuilder.deduplicate`)
con cuatro fuentes falsas y distintos tiempos de llegada:

| Escenario | Qué sale en las 12 plazas |
|---|---|
| arXiv falla (502), dominio en caché a 4 ms (lo medido tras elegir) | openreview 10 + huggingface 2 |
| PubMed desde la caché local, el resto a 2 ms (lo medido al recargar) | pubmed 12 |
| Las cuatro contestan en el mismo tick | arxiv 12 |
| arXiv llega 300 ms antes que el resto | arxiv 12 |
| PubMed llega 50 ms antes que el resto | pubmed 12 |

**En ningún orden de llegada comparten página dos ramas**, salvo que la primera en
contestar traiga menos de 12 papers. (La rama de dominio ya junta dos fuentes,
OpenReview y Hugging Face, pero las dos son de IA.)

### Alcance y gravedad

Afecta a todo invitado que elija dos áreas o más, y la composición cambia de una
visita a otra sin que cambie nada de lo elegido. El feed con sesión va por otro
camino (`FeedContext`, con su propio ranking) y no se ha auditado aquí.
**Gravedad alta:** es la primera pantalla del producto, y contradice lo que el
invitado acaba de elegir.

### Qué haría

Componer por cupos: repartir las 12 plazas entre las áreas elegidas, y dentro de
cada área entre sus fuentes, con un reparto por turnos (*round-robin*) y un
presupuesto de espera por área. El primer pintado puede seguir siendo de 4 tarjetas,
pero la página final tiene que guardar sitio para el área que llega tarde, en vez
de cortar a 12 lo que ya está en pantalla. Y darle a `med.*` al menos Europe PMC.

---

## Fallo 2 — «Conexiones» se ofrece al invitado y falla siempre, sin decir por qué

### Qué se ve

Comprobado en producción como invitado: el botón «Ver papers relacionados» abre la
hoja «Conexiones del paper», y **las dos pestañas**, Grafo y Similares, dicen lo
mismo: «No se pudieron cargar estas conexiones ahora. El resto de PaperTok seguirá
funcionando con normalidad.» El «ahora» invita a reintentar, pero no se va a arreglar
nunca.

### Qué hay detrás

- El botón no mira `publicMode` (`PaperCard.jsx:1869-1878`). Todas las demás acciones
  con puerta de la tarjeta sí lo miran y abren el diálogo de cuenta: leer, me gusta,
  saltar, guardar y «Leer en simple» (`:1828`).
- Grafo va por `getCitationGraph` → `authenticatedWorkerFetch`
  (`citationGraphService.js:148`), y Similares por `getRelatedPapers`, cuyo
  `fetchWorker` es por defecto `authenticatedWorkerFetch` (`relatedPapersService.js:79`,
  llamado en `:62`). Sin usuario de Firebase,
  `authenticatedWorkerFetch` lanza `WorkerApiAuthError('WORKER_AUTH_REQUIRED')`
  **antes de hacer la petición** (`workerApiClient.js:130-131`). El servidor no llega
  a enterarse. Si se le preguntara, contestaría 401 `{"code":"AUTH_REQUIRED"}`
  (comprobado con curl sobre `/citation-graph`): `/related` y `/citation-graph` están
  en `PROTECTED_PROVIDER_PATHS` (`worker/report-api.js:195-202`).
- La consola dice `No se pudieron cargar papers relacionados WorkerApiAuthError:
  WORKER_AUTH_REQUIRED`, visto en la sonda. Es probablemente de ahí de donde saca el
  tester que «el servidor pide login».
- El estado de error no tiene región viva (`RelatedPapersSheet.jsx:852-858`), así que
  al cambiar de pestaña un lector de pantalla no anuncia nada (WCAG 4.1.3). Esto
  afecta también a usuarios con sesión cuando falla un proveedor.

Es la misma clase de fallo que STATE.md ya arregló para el feed («el feed de invitado
dejaba de pedir lo que no podía recibir»). La hoja se quedó fuera de aquel arreglo.

### Alcance y gravedad

Todo invitado, en los dos idiomas, en cualquier tarjeta con DOI, arXiv o id de
Semantic Scholar: en el feed de invitado, en `/public/paper/:key` y en el panel de
paper del Explorer. Falla el 100 % de las veces y no genera tráfico. **Gravedad media.**

### Qué haría

Poner el botón detrás de `requireAuthentication('related')` en `publicMode`, como las
demás acciones, o poner una puerta dentro de la hoja como la de comentarios
(`CommentsSheet.jsx:1225-1231`: «Inicia sesión para unirte a la conversación» más un
botón). En cualquier caso, traducir `WorkerApiAuthError` a un texto de inicio de
sesión en vez de «ahora», y dar al error una región viva. Hay una opción de producto
más ambiciosa: servir Similares al invitado desde fuentes públicas.

---

## Fallo 3 — La caja de Wikipedia de un tema enseña lo primero que encuentra el buscador

### Qué se ve

Comprobado en vivo en `/explorer/concept/C2779256057` como invitado con la interfaz en
español. La caja dice «Allan Balmain FRS es un profesor distinguido de Genética del
Cáncer en la Universidad de California, San Francisco (UCSF).». Su retrato sale como
fondo y como imagen con `alt="Tumor progression"`.

### Qué hay detrás

**OpenAlex tiene el dato bien.** El concepto `C2779256057` lleva
`ids.wikidata = Q16909647` («tumor progression», «third and last phase in tumor
development») e `ids.wikipedia` a la página inglesa. **Nadie lee esos ids.**

En su lugar, `searchWikipedia` hace una **búsqueda de texto libre** en
`{es|en}.wikipedia.org` con la etiqueta inglesa (`generator=search`, `gsrlimit=3`,
`wikiService.js:67-99`). Después, `mapWikipediaSearchResponse` descarta solo las
desambiguaciones y **se queda con el primer resultado que tenga extracto**
(`wikiService.js:43-65`). No mira el título, ni el tipo de cosa, ni el
`wikibase_item` que la propia respuesta trae. `strictTitleMatch` solo se activa para
los temas de texto libre (`EntityExplorer.jsx:975`).

En español se junta todo:

- OpenAlex no tiene etiqueta española.
- La Wikipedia en español no tiene artículo para Q16909647 (solo `enwiki` y `arwiki`).
- Su buscador, con palabras inglesas, prioriza páginas que contienen inglés: biografías
  que citan títulos de papers, nombres de revistas…

### Evidencia

Reproducido con la API de Wikipedia (la misma petición que construye el código):

| Búsqueda en es.wikipedia | Primer resultado | Wikidata |
|---|---|---|
| Tumor progression | **Allan Balmain** (persona) | Q20031714 |
| Medicine | **«Medicine», canción de Shakira** | Q17040952 |
| Physics | **American Journal of Physics** (revista) | Q465346 |
| Psychology | **Psychology Today** (revista) | Q7256412 |

El agente pasó 25 nombres reales por el código de HEAD sin modificar: 21 conceptos de
obras de 2025 de medicina, informática, física y sociales, y 4 temas. Cada acierto se
contrastó con el Wikidata de OpenAlex:

| Interfaz | Conceptos equivocados | Temas equivocados |
|---|---|---|
| Español | **20 de 21 (95 %)** | 3 de 4 |
| Inglés | 0 de 21 | 1 de 4 |

Los errores en español son: 2 personas con retrato, 6 revistas, 4 organizaciones, 4
obras creativas (la canción, una película, un disco, un grupo), 2 premios y 6
conceptos cercanos pero distintos. **19 de esos 21 conceptos sí tienen artículo en
español**, que se alcanzaría por su id de Wikidata.

### Alcance y gravedad

Todo usuario con la interfaz en español, también los invitados, en cualquier página de
concepto o tema. Instituciones y revistas usan el mismo resolutor
(`EntityExplorer.jsx:481-483`), pero no se han medido. **Gravedad alta:** rompe el
invariante 3 (procedencia de los metadatos), porque presenta como descripción del tema
una página adivinada, y pone la cara de personas reales sobre conceptos.

### Qué haría

- **Conceptos:** resolver por identidad. Leer `ids.wikidata` de OpenAlex, pedir el
  *sitelink* en el idioma de la interfaz y, si no existe, usar la página inglesa
  marcada `lang="en"` o la descripción de OpenAlex.
- **Temas, instituciones, revistas y texto libre**, que seguirán yendo por búsqueda:
  exigir que el `wikibase_item` del resultado coincida con el esperado. Si no hay id
  esperado, exigir título exacto y rechazar personas, organizaciones, publicaciones
  periódicas y obras. **Nunca enseñar una foto de una página sin verificar.**

La tabla de alias escrita a mano (`wikiService.js:3-23`) quedaría superada. La consulta
en dos pasos tiene que caber en el corte de 5 s del Explorer (`EntityExplorer.jsx:965`).

---

## Fallo 4 — Un autor sin id se resuelve por el primer homónimo, y su perfil mezcla a otros

### Qué se ve

Pulsar «Li WN» en una tarjeta de PubMed abre a otra persona. «Wei Zhang» abre un perfil
que junta a muchas.

### Qué hay detrás

**Cuándo lleva id un enlace:**

- Las tarjetas de OpenAlex llevan el id de autor, que da `/explorer/author/A…`.
- arXiv llega sin id (`ArxivAdapter.js:48-51`), salvo que el enriquecimiento de OpenAlex
  se lo añada.
- PubMed y Europe PMC mandan solo `{ name }`, con el formato «Apellido Iniciales»
  (`PubmedAdapter.js:273-275`).
- El id de autor de Semantic Scholar impide que se le añada el de OpenAlex
  (`PaperBuilder.js:222`), y el constructor del enlace solo acepta ids de OpenAlex.
  Esto sale de leer el código.
- Ningún enlace usa ORCID, aunque la ruta lo admite (`EntityExplorer.jsx:841-858`).

**Cómo se elige a la persona cuando solo hay nombre:**

- Con sesión, el enlace es `/explorer/author/<nombre>?arxivId=<id del paper>`. En
  PubMed ese «arxivId» es `pmid:…`, que acaba como
  `works/doi:10.48550/arxiv.pmid:…` y da 404 (`openAlexService.js:509`).
- Sin sesión, el invitado ni siquiera pasa el id del paper.
- En los dos casos se cae a `authors?search=<nombre>` y se toma **el primer resultado
  por relevancia que pase `matchesAuthorName`** (`openAlexService.js:425-445`, `:500`,
  `:565`). No se usa el DOI del paper para desambiguar.

**`matchesAuthorName` es a la vez demasiado estricto y demasiado laxo**
(`authorNameMatch.js:11-37`), comprobado en Node:

- `Li WN` → `Po-Wn Li`: **true**
- `Li WN` → `Wan-Ning Li`: **false**
- `Chen YC` → `Y. C. Pan`: **true**

No parte las iniciales («wn») ni ancla el apellido.

**«Junta a varios»:** todo perfil de autor, incluso uno abierto por id de OpenAlex, añade
búsquedas por nombre (`EntityExplorer.jsx:1084-1116`):

- Semantic Scholar, por palabra clave.
- PubMed, con `"<nombre>"[Author]`.
- Scopus, con sesión.
- arXiv, por nombre, si no se resuelve a nadie.

**Nada filtra esos resultados por identidad** después.

### Evidencia

- **«Li WN»**, desde el PMID 42774036, un editorial de Wan-Ning Li (NCI).
  `authors?search=Li WN` devuelve 7 entidades, y la primera es **Po-Wn Li
  (A5050248117)**: 1 obra, Chung Yuan Christian University. Comprobado con curl.
  OpenAlex atribuye ese paper a Wan-Ning Li (A5075361382). En los 25 registros de PubMed
  con «Li WN» (al menos 10 nombres de pila distintos), todos están en OpenAlex con id de
  autor, pero el id se adjuntó en 1 de 25. Los otros 24 abren a Po-Wn Li: **0 de 25
  correctos**.
- **«Wei Zhang»** tiene **11 284** entidades en OpenAlex. El código elige A5100441502:
  2813 obras y **974 afiliaciones**, un conglomerado del propio OpenAlex. Además, la
  búsqueda añadida de PubMed, `"Wei Zhang"[Author]`, se lee como apellido Wei: 192
  registros de unas 25 instituciones, y ninguno de un Zhang llamado Wei.
- **Los datos para desambiguar ya llegan y se tiran.** El Worker devuelve el XML
  completo de efetch, pero el adaptador solo lee resumen y MeSH
  (`PubmedAdapter.js:212-238`). En los 25 registros, **203 de 203 autores traen nombre
  de pila y afiliación, y 15 traen ORCID**. Europe PMC igual: 86 de 86 con nombre y
  afiliación, 10 con ORCID.

### Alcance y gravedad

En las 25 tarjetas de PubMed, solo el 32,5 % de los autores (66 de 203) recibió id de
OpenAlex, aunque las 25 obras están en OpenAlex. Sobre 15 autores sin id, la búsqueda
por nombre acertó **0 veces**. **Gravedad alta:** es atribuir mal trabajo científico, y
el botón Seguir sigue al autor mal resuelto (`EntityExplorer.jsx:658-667`).

### Qué haría

1. **Conservar los identificadores** que ya mandan las fuentes: ORCID, nombre completo
   y afiliación de PubMed y Europe PMC, e id de Semantic Scholar.
2. **Desambiguar con el propio paper:** buscar en la obra de OpenAlex por DOI o PMID al
   autor en la misma posición.
3. **Arreglar el comparador:** partir las iniciales y anclar el apellido.
4. **Limitar la lista de obras a la identidad resuelta.** Sin identidad, mostrar un
   estado explícito de «nombre sin verificar, puede haber homónimos» en vez de un
   perfil seguro de sí mismo con Seguir.

**Choca con** el contrato `?arxivId=` que mantuvo `AUDITORIA-PUERTAS-AUTOR` §4, y con
`authorNameMatch.test.js`, que fija «basta un subconjunto de las partes».

---

## Fallo 5 — Compartir enseña «PaperTok» a secas, y los papers no se pueden indexar

### Qué se ve

Se ha pedido con curl la URL que genera el botón de compartir
(`/public/paper/<clave base64url>`), con los agentes de WhatsApp, Twitterbot,
facebookexternalhit y Googlebot. Los cuatro reciben **el mismo HTML de 8963 bytes**:

- `<title>PaperTok</title>`
- `og:title` «PaperTok — Discover scientific research»
- `og:url` y `canonical` apuntando a `https://papertok.app/feed`
- un `<div id="root">` vacío

### Qué hay detrás: cuatro causas, y el canonical no es la decisiva

1. **No hay HTML por ruta.** `vercel.json:25` reescribe toda ruta de página a un único
   `index.html` estático, sin función ni middleware. Ningún rastreador de
   previsualización ejecuta JS, así que `usePublicPageMetadata`, que sí reescribe
   título, og:*, twitter:*, robots, JSON-LD y canonical en el navegador
   (`src/hooks/usePublicPageMetadata.js:220-251`), no les llega nunca. Ya estaba anotado como
   hueco conocido en `docs/PUBLIC_DISCOVERY.md:102-107`.
2. **El canonical y el `og:url` de la carcasa están fijos en /feed**
   (`index.html:58`, `:63`, `:74`). El hook los reescribe en cliente, que es justo lo
   que la guía de Google desaconseja: el canonical del HTML original y el renderizado
   deben coincidir.
3. **Para Google, el paper no llega a cargar.** Los datos solo llegan por el Worker, y
   `https://api.papertok.app/robots.txt` es `User-agent: * / Disallow: /` (comprobado
   en vivo). Es una decisión documentada para no gastar los presupuestos de OpenAlex,
   PubMed y S2 (`report-api.js:2311-2323`). Google no pide recursos que robots.txt
   prohíbe, así que al renderizar se queda en «cargando» o «no encontrado», y en esos
   estados la página se marca `noindex, nofollow` (`PublicPaperPage.jsx:246-247`).
4. **Nada enlaza a los papers.** `public/sitemap.xml` lista solo `/`, `/feed`,
   `/following` y `/research`; tres de ellas no son URLs canónicas, porque las dos
   protegidas rebotan al invitado a /feed. Y en el feed de invitado el título de la
   tarjeta es texto, no un enlace.

El mensaje compartido tampoco ayuda: `navigator.share({ title, url })` va sin `text`
(`PaperCard.jsx:1204`), y el portapapeles copia solo la URL (`:1213`), cuya clave no se
puede leer.

### Alcance y gravedad

Afecta a todo lo compartible: papers, listas, perfiles y entidades. Los enlaces
anteriores al 18-09 (`/#/public/paper/…`) no podrán tener nunca una vista previa propia,
porque el fragmento no llega al servidor. **Gravedad media.** No hay Search Console:
que Google no los tenga indexados se deduce del código y de la configuración, no de
una consulta.

### Qué haría

El arreglo de fondo es dar a `/public/{paper,list,user,entity}` una cabecera propia
servida desde el servidor. Una función de Vercel, cacheada en la CDN, que meta título,
descripción, og:*, canonical y JSON-LD en el `index.html` desplegado, con los datos de
una ruta de metadatos cacheada del Worker. Después, quitar el canonical y el `og:url`
fijos y el `noindex` durante la carga.

Coste y riesgos: cada fallo de caché gasta una consulta del presupuesto que el robots.txt
de la API protege. Hay que escapar el HTML y pasar el LaTeX a texto. Y el Worker tiene
que aceptar a un llamante de servidor que no manda `Origin`.

Parche barato mientras tanto: `text: paper.title` en `navigator.share`, y copiar
«título — URL».

---

## Fallo 6 — El «abstract» de un editorial es el editorial entero, y el lector de Europe PMC borra texto

### La cadena exacta del tester

La cadena «response.A particularly» sale del PMID **42774036**, un *Editorial* de
*Frontiers in Endocrinology* publicado hoy: «Molecular insights into the tumor
progression of endocrine and hormone-sensitive cancers», de Pidugu VK, Huang HC y
**Li WN**. Entra en la consulta de PubMed del invitado con Medicina.

Es muy probablemente la tarjeta del tester. De ella salen también el chip «Tumor
progression» del fallo 3 y el enlace «Li WN» del fallo 4.

### Qué hay detrás

- **PubMed y Europe PMC no tienen resumen** de ese editorial.
- **OpenAlex sí tiene algo, y no es un resumen.** `W7211952859` (tipo `editorial`)
  guarda en `abstract_inverted_index` **el texto entero**: 650 términos distintos, con
  los saltos de párrafo perdidos (`response.A`, `landscapes.A`, `interventions.The`,
  comprobado en la API).
- El feed de invitado enriquece después de pintar (`useGuestFeed.js:121`, `:132`).
  `PaperBuilder.merge` rellena el hueco con lo primero que llega
  (`PaperBuilder.js:145-151`), y para un editorial eso es OpenAlex: un «abstract» de
  **9137 caracteres**.
- **Nuestra unión no pega nada.** `PubmedAdapter.js:223-224` une los `AbstractText`
  con un espacio. El texto viene pegado de origen; lo nuestro es aceptarlo sin mirar el
  tipo, aunque ya sabemos que es un editorial (`PubmedAdapter.js:140` lo mapea a
  `letter`), ni la longitud.

Cifras del agente:

- Editoriales y cartas son un 10 % de lo que PubMed da hoy al invitado.
- De 60 editoriales de agosto, 40 no tienen resumen en ninguna parte.
- De esos 60, tres recibieron textos enteros de 5,7 k a 12,6 k caracteres, y varios
  recibieron basura como resumen: «CA Dobrev», «Lettre», «in volume 57, e8.».

### Más grave, y esto sí es nuestro: `stripMarkup` de Europe PMC borra texto

`europePmcRecord.js:30-41` quita las etiquetas con `/<[^>]*>/g` **antes** de decodificar
entidades. Eso produce dos fallos:

- **Pega los títulos de sección.** «BackgroundOur previous…» sale en 47 de 85 resúmenes.
- **Borra todo lo que hay entre un `<` literal y el siguiente `>`.** Reproducido con el
  módulo del repo sobre el PMID 42629277, en 12 de 85:
  - en origen: `…95% CI 0.925-1.000, P < .001) compared with PNI and GPS.<h4>Conclusions</h4>Pretransplant CALLY…`
  - en la tarjeta: `…95% CI 0.925-1.000, P ConclusionsPretransplant CALLY…`

  Desaparecen un valor p y una comparación.

Esto llega a la tarjeta cuando falta el resumen de PubMed, y en las tarjetas que vienen
de Europe PMC para Biología.

Otros dos detalles del adaptador de PubMed: descarta las etiquetas de sección
(BACKGROUND, METHODS…) y **concatena `OtherAbstract`**. El PMID 42775314 sale con su
traducción al serbio pegada detrás.

### Gravedad y qué haría

**Media en conjunto**, pero el borrado de Europe PMC es el más serio y el más barato de
arreglar:

- En `stripMarkup`, convertir `<h4>` y `<p>` en separadores, quitar solo etiquetas
  conocidas y decodificar después.
- No rellenar el resumen desde OpenAlex en Editorial, Letter, Comment y Erratum, o
  rechazar longitudes implausibles. Que quede ausente (invariante 3). Es un matiz de la
  regla documentada de «solo rellena huecos» (`PaperBuilder.js:145-148`), no una
  contradicción.
- En PubMed, conservar las etiquetas de sección y saltar `OtherAbstract`.

---

## Fallo 7 — «Humans», «Female» y «MEDLINE» son dos fugas distintas

- **«Humans», «Female», «Male», «Animals», «Mice»** son las *check tags* de MeSH que la
  NLM pone en casi todo. Salen de `MeshHeading > DescriptorName` en el XML de efetch
  (`PubmedAdapter.js:225-236`) y del `meshHeadingList` de Europe PMC
  (`europePmcRecord.js:59-67`, `:81`, unido en `europePmcService.js:154`). Se guardan
  como `categories`, y las cuatro primeras se pintan como chips (`paperTopicTags.js`,
  `PaperCard.jsx:1437-1460`). **No se lee `MajorTopicYN`.**
  - De 57 registros con MeSH, en **47 el primer descriptor es una check tag**, y los 57
    marcan sus temas principales.
  - Los registros de hoy casi no tienen MeSH todavía (la indexación tarda), así que el
    chip aparece sobre todo en papers de hace unas semanas.
- **«MEDLINE»** no es el estado del registro de PubMed: es el **concepto de OpenAlex
  `C2779473830`**. El enriquecimiento une todos los conceptos sin umbral de puntuación
  (`openAlexService.js:137-139`, `:158` → `PaperBuilder.js:239`). Aparece en el 27 % de
  las obras de agosto y en el 47 % de los editoriales.

Reproducido en Node con `buildPaperTopicTags` y la interfaz en español: una tarjeta con
MeSH `Humans`, `Female`, `Oncology` y los conceptos `Computer science` y `MEDLINE` pinta
exactamente esos cinco chips.

**Gravedad media. Qué haría:**

- Filtrar las check tags, que son una lista fija de la NLM, y preferir
  `MajorTopicYN="Y"`.
- Aplicar a los conceptos del enriquecimiento el umbral `score > 0.3` que el adaptador de
  OpenAlex ya usa (`OpenAlexAdapter.js:153`).
- Bloquear conceptos bibliográficos como MEDLINE o PubMed.

---

## Fallo 8 — Los chips en inglés: una parte es un fallo nuestro de una línea

| Qué ve el lector | ¿Traducido? | Dónde |
|---|---|---|
| La píldora de categoría de arriba | Sí, desde nuestra taxonomía | `PaperCard.jsx:1004-1022` |
| La misma píldora, en el caso de respaldo | No: nombre de campo de OpenAlex, a propósito | `areaAccent.js:170-178` |
| Chips de estado («Preprint», «Acceso abierto») | Sí | `paperStatus.js:77-126` |
| Chips de categorías arXiv y de la taxonomía | Sí | `categories.js:428-443` |
| **Chips cuya etiqueta inglesa SÍ resuelve a nuestra taxonomía** | **No, y podría** | `PaperCard.jsx:1444-1454` |
| Chips de MeSH, palabras clave y conceptos | No: texto del proveedor tal cual | `paperTopicTags.js` |

**El fallo nuestro:** `PaperCard.jsx:1444` resuelve el tema con
`resolvePaperTopic(tag.value, language)`. Usa la etiqueta resuelta solo en el `title`
(`:1452`), y el chip pinta `{tag.label}` (`:1454`). Reproducido: el chip dice «Oncology»
y su `title`, «Explorar Oncología»; el chip dice «Computer science» y su `title`,
«Explorar Ciencias de la Computación».

Medido por el agente:

- En las tarjetas de OpenAlex del invitado, es el caso del **46 % de los chips** (42 de
  91).
- En PubMed, 11 de 260.

Va contra `src/AGENTS.md` («resolve local topics from canonical IDs») y contra el
invariante 4.

**El resto es texto libre de verdad:**

- MeSH tiene traducción oficial al español (DeCS), indexada por el atributo `UI` del
  descriptor. Ese atributo viene en el XML y lo tiramos (`PubmedAdapter.js:225`).
- Las palabras clave de autor no se pueden traducir.

**Accesibilidad:** los chips y el abstract en inglés no llevan `lang="en"`; solo el
título lo lleva (`PaperCard.jsx:1552`). Es el punto 8 de la guía de accesibilidad y el
criterio 3.1.2.

**Gravedad:** media para los chips que ya resuelven, porque se arregla pintando
`topic.label` cuando viene de la taxonomía. Baja para el texto libre, que necesita una
tabla (DeCS).

---

## Fallo 9 — «Leer en simple» se promete en la bienvenida y pide cuenta sin avisar

### Qué se ve

La hoja de bienvenida, que el invitado no puede cerrar sin responder, abre con: «Un
feed de papers científicos para deslizar, con lo esencial de cada uno explicado en
claro…» (`GuestInterestsPrompt.jsx:30`; en inglés, «each one explained in plain
words», `:45`, casi el nombre del botón). En la tarjeta, «Leer en simple» no lleva
candado, `title` ni `aria-describedby` (comprobado en vivo:
`{ariaLabel: null, describedBy: null, title: null}`). Al pulsarlo sale el diálogo
genérico: «Haz que PaperTok sea tuyo. Da me gusta, guarda y sigue investigación, y
entrena un feed que aprende lo que lees.» No nombra la lectura en simple.

### Qué hay detrás

La puerta en sí es deliberada (`PaperCard.jsx:1828-1831`:
`if (publicMode) { requireAuthentication('paper_rewrite'); return; }`), y ya estaba
anotada en `docs/ACCESIBILIDAD-EVIDENCIA.md`. Lo que falla es que **el motivo se pierde
por el camino**:

- `GuestFeedPage.requestAccount(action)` lo usa para la analítica y llama a
  `onAuthRequired?.()` sin él (`GuestFeedPage.jsx:73-77`).
- `requestAuthentication()` de `App.jsx:180-183` no recibe argumentos.
- `AuthPrompt({ onClose })` (`src/components/Public/AuthPrompt.jsx:22`) solo tiene un
  texto.

Hay algo más que el tester no vio: **«cada uno» no es cierto ni con cuenta**. El botón
solo aparece si hay texto completo legible por la IA (arXiv, Europe PMC o PMC:
`paperRewriteService.js:53-67`, `aiExplanationAccess.js:22-38`), y hay cuota diaria.

### Alcance y gravedad

Todo invitado, en los dos idiomas, en cada tarjeta con texto completo, que incluye
toda tarjeta de arXiv. **Gravedad media:** es la promesa central de la bienvenida.

### Qué haría

Pasar el motivo por `requestAccount` → `App` → `AuthPrompt` y dar a cada acción su
texto («Para leerlo en simple necesitas una cuenta gratuita»). Avisar antes de pulsar
con una marca visible «con cuenta», enlazada por `aria-describedby`. El nombre
accesible no cambia, así que 2.5.3 sigue cumpliéndose. Y matizar la bienvenida: quitar
«cada uno» y decir que la lectura en simple va con cuenta.

---

## Fallo 10 — El buscador del Explorer no deja escribir y no dice por qué

### Qué se ve

Comprobado en vivo en `/explorer/concept/C2779256057` (Tumor progression) como
invitado. El campo tiene el placeholder «Buscar publicaciones de este tema…», está en
`readOnly` y no tiene `aria-describedby`. Tras enfocarlo, se escribió «cancer» y se
pulsó Intro: el valor sigue siendo `''` y se abre el diálogo genérico «Haz que
PaperTok sea tuyo…».

### Qué hay detrás

- Que no deje escribir es **por diseño**: decisión del 12-09 (`716051b`), comentada en
  `EntityExplorer.jsx:2493-2499`, con `readOnly` y `onMouseDown` que abre la puerta.
- Que no diga por qué se **confirma en todos los caminos**:
  - Con ratón, el diálogo genérico.
  - Con teclado, las letras y el retroceso no hacen nada ni anuncian nada; solo
    Intro o Espacio abren el diálogo (`handleActivationKey`, `:139-143`).
  - Ni el placeholder ni el `aria-label` («Buscar publicaciones en esta entidad»)
    mencionan la cuenta.
  - El campo no tiene estilo de solo lectura, así que parece un buscador normal.
- La única explicación está al pie de la lista: «Con una cuenta se abre entera, con su
  buscador y sus filtros.» (`ExplorerGuestGate.jsx:26`). No está enlazada al campo,
  falta cuando la entidad tiene dos elementos o menos o mientras carga, y en la
  pestaña de autores solo dice «Con una cuenta se abre entera.».

### Alcance y gravedad

Todo invitado en cualquier página de autor, tema, institución o proyecto, en las dos
pestañas. **Gravedad media** por accesibilidad: están en riesgo 3.3.2 (faltan las
instrucciones de un campo restringido), 4.1.2 (el rol dice campo de texto y el
comportamiento es de botón) y 1.3.1. No se incumple 2.1.1, porque el diálogo se abre
con Intro.

### Qué haría

Para el invitado, un botón con aspecto de campo que diga «Buscar (necesita cuenta)», o
el campo con un texto de ayuda visible enlazado por `aria-describedby`. En los dos
casos, el mismo diálogo con motivo del fallo 9. **Conflicto que hay que decidir:** el
mismo 12-09, `630bb99` quitó la lupa de la cabecera de invitado precisamente porque
«no buscaba: abría el mismo diálogo de cuenta». El Explorer se quedó con ese mismo
patrón, y `explorerGuestGate.test.js` fija hoy el `readOnly`.

---

## Fallo 11 — Rendimiento: tres cosas distintas, y el número no cuadra

Medido en producción con un invitado nuevo: perfil limpio, 1280×900, sin caché.

| Momento | Peticiones | De ellas, datos (API + terceros) |
|---|---|---|
| Primera visita, antes de tocar nada | **71** (953 KB): 34 scripts, 11 fuentes, 2 CSS, documento, manifest, favicons… | 20: 13 al Worker, 4 imágenes de arxiv.org, 1 Europe PMC, 1 OpenAIRE |
| Tras elegir Informática + Medicina | +10 | 10 |
| Segunda visita (con service worker) | 53 (todo lo propio sale del SW) | 6 |

**El «26» no lo reproduzco** con ningún corte limpio. Lo que sí se confirma es el
fondo: sobran peticiones al abrir, y la mayoría de las de datos no sirven para nada.

### 11a. Carga áreas que no elegiste — CONFIRMADO; es una decisión, pero cara

En la primera visita la pregunta de intereses es obligatoria: no tiene X, ni Escape,
ni cierre al pulsar fuera (`GuestInterestsPrompt.jsx:11-17`, `:99-104`). Aun así, el
feed de detrás, que asoma atenuado tras la hoja (el velo está al 50 %,
`GuestInterestsPrompt.css:19-21`), carga la muestra por defecto en cuanto abre la
página:
`GuestFeedPage.jsx:34-36` pasa `NO_AREAS`, y `buildGuestFeedPlan([])` devuelve
`GUEST_CATEGORIES` (`astro-ph.CO`, `quant-ph`, `cs.AI`, `bio.neuro`, `math.PR` y
`econ.GN`).

Medido: antes de que el invitado toque nada salen **7 peticiones de fuentes**
(arXiv, OpenAlex, bioRxiv, Europe PMC, OpenReview, Hugging Face y PubMed) y **13 de
enriquecimiento**:

- 5 lotes de OpenAlex y 1 de Europe PMC.
- Figuras: 1 petición más 4 imágenes de arxiv.org.
- 1 de OpenAIRE, que da 400; ver más abajo.
- KaTeX: 79 KB de JS, su CSS y 4 fuentes, por una fórmula en una tarjeta que está
  debajo del diálogo.

Al responder, `setPapers([])` lo tira todo (`useGuestFeed.js:195`) y se carga el plan
elegido. El comentario lo asume («the cards can fill in behind the sheet»), pero son
unas veinte peticiones por visitante nuevo para un fondo que se ve atenuado y no se
puede leer.

### 11b. «bioRxiv falla tras 6 s en cada carga» — CONFIRMADO; el fallo es de bioRxiv y nosotros lo repetimos

- Con Informática + Medicina **no se pide bioRxiv**. Entra solo con la muestra por
  defecto (`bio.neuro`) o si se elige Biología.
- El upstream está roto hoy. De 6 llamadas directas a `api.biorxiv.org/details`
  (neurociencia, 180 días), **4 se colgaron más de 20 s**, 1 contestó en 2,2 s y 1 en
  13,2 s. Es el mismo patrón bimodal medido el 01-09.
- El Worker corta a los 6 s (`SOURCE_UPSTREAM_TIMEOUT_MS = 6000`, `report-api.js:80`)
  y devuelve 502 `{"code":"UPSTREAM_TIMEOUT"}` a los 6,08 s. Pasó en **2 de 3**
  peticiones en frío.
- **El fallo no se cachea.** `cacheResponse` solo guarda los 200
  (`report-api.js:592-618`), así que mientras bioRxiv está caído, cada visita con el
  borde frío paga sus 6 s y la siguiente vuelve a pagarlos. El éxito se guarda 10 min
  (`report-api.js:176`). De ahí «en cada carga».
- El feed no espera: el cliente corta a los 3,5 s (`DOMAIN_SOURCE_BUDGET_MS`,
  `domainSourceService.js:18`). Pero la petición sigue abierta hasta los 6 s y deja
  su error en DevTools, que es lo que vio el tester.
- Colateral: la ruta devuelve **lo más viejo** de la ventana. Con cursor 0 da el
  primer día de los 180, así que las 30 fichas son del 27-03-2026. El modo «recent»
  enseña bioRxiv de hace seis meses.

### 11c. Una petición que falla siempre: OpenAIRE con `pid`

`getProjectForPaper` consulta OpenAIRE con `&pid=<arXiv id>` cuando el paper no tiene
DOI, y también como segundo intento (`openAireService.js:170-175`, `:183`). La API
responde **400 «Parameter pid is not supported»**, así que:

- Cada tarjeta de arXiv sin DOI gasta una petición condenada.
- El fallo no se cachea: `if (!response.ok) return null`, `:178`.
- La insignia de proyecto no puede salir nunca para un paper que solo tiene arXiv.

### Gravedad y qué haría

**Media.** El feed no se bloquea, porque los presupuestos del cliente funcionan, pero
cada visitante nuevo paga una muestra que no ve, y bioRxiv deja errores visibles.
Propuestas:

1. **El fondo de la bienvenida:** servirlo de una instantánea estática y cacheable, o
   de una sola fuente sin enriquecer, o no cargarlo.
2. **Los fallos de bioRxiv:** guardarlos poco tiempo en la caché de borde, para que
   una caída no la pague cada visita. El Worker ya tiene `DEGRADED_CACHE_SECONDS =
   120` para respuestas degradadas (`report-api.js:116`). Y pedir la ventana por el
   final, no por el principio.
3. **OpenAIRE:** usar un parámetro que exista (`originalId`, o `doi` cuando lo haya),
   o no preguntar sin DOI.

---

## Fallo 12a — Capítulos como «Preprint»: ya no en PubMed, sí en arXiv y OpenAlex

- **PubMed está arreglado** desde `8c3e743` (11-09), que está en producción. Los
  capítulos del Bookshelf (StatPearls, GeneReviews) y los de Crossref no llevan el chip.
- **arXiv sí.** `arxivService.js:122` da por publicado un paper solo si tiene DOI,
  `journal-ref` o un comentario que case `/(accepted|published|appears|to appear) in/`.
  Ejemplos que se escapan:
  - 2607.02734, «Accepted for publication as a book chapter (Taylor & Francis, 2026)».
  - 2608.12077, «To appear as a chapter in the book…».
  - «Accepted at [congreso]» tampoco casa (2606.06074).

  De 31 capítulos recientes en las seis categorías de Informática del invitado, **23
  llevan «Preprint»**, y unos 16 dicen en su propio comentario que ya están aceptados o
  publicados.
- **OpenAlex, en el Explorer y en la página pública del paper:** un capítulo cuya copia
  principal está en un repositorio sale como preprint (`openAlexService.js:1756`,
  `OpenAlexAdapter.js:156`). Pasa en 8 de 100 capítulos al azar. Al feed de invitado no
  llega, porque su búsqueda pide solo artículos y ponencias.

**Gravedad baja. Qué haría:** ampliar la expresión regular de arXiv (`accepted for`,
`to appear as`, `accepted at`) y, en OpenAlex, derivar el estado del tipo de obra, como
ya hace el mapeador del enriquecimiento (`openAlexService.js:164-169`).

Colateral: el adaptador de Semantic Scholar marca como «Preprint» cualquier revisión
(`SemanticScholarAdapter.js:68`). El PMID 30617335 es de *Nature Medicine*.

---

## Fallo 12b — No hay 404, y faltan h1 donde más importa

### 404: CONFIRMADO

`App.jsx:555` es `<Route path="*" element={<Navigate to="/feed" replace />} />`, y no
existe ninguna vista de «no encontrado». Comprobado en vivo:
`/esto-no-existe-<ts>` acaba en `/feed` sin aviso. En el servidor, todo devuelve 200
(`curl -sI https://papertok.app/esto-no-existe` → `HTTP/2 200`). El único 404 real es
el de un asset.

Los ids falsos sí tienen pantalla propia, pero con estado 200:

- Paper: «No encontramos este paper», con h1 y `noindex`, comprobado en vivo.
- Perfil y lista: lo mismo.
- Explorer: solo un h2 «Entity not found», sin `<main>`.

### h1: PARCIALMENTE CONFIRMADO

La mayoría de rutas tiene h1 (con sesión, el del feed es visualmente oculto). **Faltan
justo en las dos puertas públicas:**

| Ruta | h1 |
|---|---|
| `/feed` de invitado, que es también `/` y toda ruta protegida sin sesión | **Ninguno**, comprobado en vivo. `GuestFeedPage` tiene su propio `<main>` y no pasa `landmark` a `FeedContainer` |
| `/public/paper/:key` cargado | **Ninguno**: el título es el `<h2 className="pc-title">` de la tarjeta (`PaperCard.jsx:1552`) |
| `/search` | **Ninguno, y sin `<main>`** |
| Explorer en error o no encontrado | **Ninguno** (h2 en `EntityExplorer.jsx:1710`) |
| Explorer cargado | Sí, comprobado en vivo: «Tumor progression» |

WCAG 2.2 AA no exige un h1 literalmente: 1.3.1 se cumple porque los h2 son encabezados
reales, y 2.4.2 va por el `<title>`. Pero el repo trata su ausencia como defecto: la
regla `page-has-heading-one` se cerró el 18-09 y la evidencia marca «No cumple». El test
`accessibilityStructure.test.js` no mira ni la ruta de invitado ni la del paper, y la
pasada de axe del 18-09 solo cubrió rutas con sesión. **Gravedad baja.**

### Qué haría

- Una ruta `NotFound` bilingüe con `<main>`, h1, enlace al feed y `noindex`. Antes, una
  ruta explícita `/` → `/feed`, porque hoy `/` depende del comodín.
- Para un 404 HTTP de verdad, estrechar la reescritura de `vercel.json` a los prefijos
  declarados y servir un `404.html`. Añadir un test que compare las rutas de `App.jsx`
  con `vercel.json`.
- El h1 del invitado dentro del `<main>` de `GuestFeedPage`, sin anidar dos `<main>`.
  El test `:229-251` existe justo para impedirlo.
- El título del paper como h1 en `/public/paper`.

---

## Hallazgos colaterales, no reportados

- **OpenAIRE `pid` → 400 en cada tarjeta de arXiv sin DOI** (fallo 11c).
- **bioRxiv devuelve lo más antiguo de su ventana de 180 días** (fallo 11b).
- **Durante la sonda, `/arxiv` dio un 502 a los 5,2 s una vez**, en la fase de elegir
  intereses. Al repetirlo en frío contestó en 0,5 s: fue transitorio. Basta para que la
  carrera del fallo 1 cambie de ganador.
- **Semantic Scholar marca como «Preprint» cualquier revisión**
  (`SemanticScholarAdapter.js:68`).
- **El id de autor de Semantic Scholar bloquea que se le añada el de OpenAlex**
  (`PaperBuilder.js:222`), y el enlace solo acepta ids de OpenAlex. Leído en el código.
- **La página de autor manda `id_list=pmid:…` a arXiv** para poner primero el paper de
  origen (`EntityExplorer.jsx:~1200`). Gasta un turno de arXiv para nada.
- **Research comparte el PDF o la página externa**, nunca una URL de PaperTok
  (`ScientificReport.jsx:465-471`).
- **La imagen social** se declara de 1200×630 en el hook y mide 2400×1260; pesa 682 KB.
  Se dice que WhatsApp descarta `og:image` por encima de unos 300 KB, pero no está
  documentado ni comprobado aquí.
- **Documentación desfasada:** `docs/PUBLIC_DISCOVERY.md` sigue hablando de `app.html`, de
  la landing en `/`, de URLs con `#` y de GitHub Pages. Y el comentario de
  `worker/report-api.js:206-234` cuenta `/related` entre las rutas «que lee el feed de
  invitado», cuando está protegida (`:197`).
- **El estado de error de la hoja de conexiones no tiene región viva**, y afecta también a
  usuarios con sesión (fallo 2).

## Cómo reproducir

- **Composición y censo de peticiones del invitado** (fallos 1 y 11). La sonda nueva, sin
  trackear, `scripts/diagnostics/guest-feed-composition-probe.mjs`, repite las tres fases
  contra producción y escribe `report.json`:

  ```bash
  node scripts/diagnostics/guest-feed-composition-probe.mjs --areas=cs,med
  ```

  Es tráfico real de invitado: unas 70 peticiones de assets y 25-30 al Worker. No
  escribe nada y no hace falta cuenta. Después de un arreglo del fallo 1, lo esperado es
  que `snapshots[*].papers` mezcle fuentes de las dos áreas y que la fase C no sea
  monocolor.
- **Wikipedia** (fallo 3): la petición de `searchWikipedia` a mano,
  `es.wikipedia.org/w/api.php?action=query&generator=search&gsrsearch=Tumor+progression&gsrlimit=3&prop=pageprops`.
- **Autores** (fallo 4):
  `api.openalex.org/authors?search=Li%20WN`, y en Node
  `matchesAuthorName('Li WN', 'Po-Wn Li')` devuelve `true`.
- **Europe PMC** (fallo 6): `mapEuropePmcRecord` sobre el registro `EXT_ID:42629277`.
- **Chips** (fallos 7 y 8): `buildPaperTopicTags` con `categories: ['Humans','Female','Oncology']`
  y los conceptos `Computer science` y `MEDLINE`, en `es`.
- **Rastreadores** (fallo 5): `curl -A 'WhatsApp/2.23.20.0' https://papertok.app/public/paper/<clave>`
  y `curl https://api.papertok.app/robots.txt`.
- **bioRxiv** (fallo 11): `curl` a `api.biorxiv.org/details/biorxiv/<-180d>/<hoy>/0/json?category=neuroscience`,
  varias veces; y la ruta del Worker con un `limit` distinto de 10, para caer en frío.

El resto de sondas, las de acciones de invitado y los muestreos de PubMed, OpenAlex y
Wikipedia, vivieron en el scratchpad de la sesión y no se conservan.

## Lo que no se ha verificado

- **Con sesión:** nada. El feed con sesión (`FeedContext`) no se ha auditado para el
  fallo 1. Ni Scopus ni el aterrizaje tras iniciar sesión desde «Leer en simple».
- **Dispositivos reales:** ni WhatsApp ni X de verdad (solo sus agentes con curl, que
  reciben los mismos bytes), ni táctil, ni lector de pantalla. Lo del lector de pantalla
  en los fallos 2 y 10 se deduce del marcado.
- **Google:** no hay Search Console. «No indexa los papers» se deduce del código y de la
  configuración.
- **La sesión exacta del tester:** no se puede recrear, porque PubMed da siempre los 25
  más nuevos. El PMID 42774036 casa literalmente con tres de sus citas. El «26» del fallo
  11 no sale en ningún corte limpio.
- **Cajas de Wikipedia de instituciones y revistas:** usan el mismo resolutor, pero no se
  han medido.
- **El complemento de Semantic Scholar en la página de autor:** dio 429 en las dos
  pruebas; se ha leído en el código.

## Orden que propondría

1. **Fallo 3 (Wikipedia por identidad).** Es el de más daño por línea cambiada: OpenAlex
   ya da el Wikidata, y hoy la versión española enseña canciones y caras donde debería
   haber conceptos.
2. **El `stripMarkup` de Europe PMC (fallo 6).** Es pequeño, y está borrando resultados
   de los resúmenes.
3. **Fallo 1 (componer por cupos) y darle a `med.*` una fuente de dominio.** Es la
   primera pantalla, y el reparto se puede probar en Node con las funciones reales y
   fuentes falsas con tiempos distintos, como en la reproducción del fallo 1.
4. **Fallos 2, 9 y 10 juntos:** un diálogo de cuenta con motivo, `Conexiones` con puerta,
   y el campo del Explorer con explicación. Antes hace falta una decisión de producto:
   la regla de `630bb99` (fuera la lupa que no busca) contra el `readOnly` del Explorer.
5. **Fallos 7 y 8, los chips:** pintar `topic.label`, filtrar las *check tags*, poner
   umbral a los conceptos y añadir `lang="en"`.
6. **Fallo 4, identidad de autor.** Es el más largo: el comparador, conservar ORCID y
   afiliación, desambiguar por el DOI del paper y limitar la lista a la identidad.
7. **Fallo 11:** cachear los fallos de bioRxiv, corregir el parámetro de OpenAIRE y
   decidir qué carga el fondo de la bienvenida.
8. **Fallo 5:** el parche barato del texto al compartir ya; la cabecera por ruta es
   infraestructura (una función de Vercel) y conviene decidirla aparte.
9. **Fallo 12:** la ruta `NotFound`, los h1 que faltan y la expresión regular de arXiv.
