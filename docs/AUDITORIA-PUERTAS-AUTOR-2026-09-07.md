# Las dos puertas a la página de autor — de dónde salen y a cuántos autores tocan (2026-09-07)

Continuación de `docs/AUDITORIA-ANIMACIONES-AUTOR-2026-09-07.md` §2, que midió que
la puerta por nombre tarda **2513 ms** hasta el héroe frente a **871 ms** la puerta
por id, y dejó fuera la causa por no ser un problema de animación.

Medido por CDP contra un **build de producción** (`npm run build` +
`vite preview --port 5174`) con un Chrome headless que reutiliza un **perfil con
sesión real de Firebase** (`PROFILE_DIR=~/.papertok-probe-profile`). Sonda nueva:
`scripts/diagnostics/author-door-census.mjs`.

---

## Resumen

1. **La puerta lenta es la mayoría, y crece al bajar.** 57 % de los enlaces de
   autor en la primera página, **92 %** tras ocho páginas. El primer autor
   clicable del feed fue el lento en las dos corridas.
2. **El id no está en la ficha y tampoco está en el paper.** No es un problema de
   propagación: la petición de enriquecimiento del feed **no pide `authorships`**,
   así que los ids nunca llegan al navegador. Y aunque llegaran, `PaperBuilder.merge`
   **no toca `authors`** en ningún caso.
3. **Resolver el id antes de navegar arregla una minoría.** Convertiría 9 de 24
   enlaces lentos en la primera página (37 %) y **2 de 56** tras bajar (3,6 %):
   el grueso del feed son preprints de arXiv de hoy que **OpenAlex todavía no ha
   indexado**, así que no hay id que resolver, ni antes ni después de navegar.
4. Para ese grueso el coste no es el id que falta sino **dos peticiones
   condenadas a fallar** antes de la única que puede funcionar.

---

## 1. Cuántos autores caen en cada puerta

`.pc-author-link[href*="?name="]` es la puerta rápida (por id de OpenAlex) y
`[href*="arxivId="]` la lenta (por nombre). Cuenta sobre el DOM montado, con el
feed real del usuario (preferencias de física), y sobre el snapshot que el feed
escribe en `localStorage`, que guarda la página entera y no sólo las tarjetas
montadas.

| Corrida | Papers | Enlaces | Rápida | **Lenta** |
|---|---|---|---|---|
| Primer pintado (3 tarjetas) | 3 | 5 | 0 | **5 (100 %)** |
| Primera página, sin bajar | 18 | 42 | 18 (43 %) | **24 (57 %)** |
| Tras ocho páginas (`SCROLL=8`) | 23 | 61 | 5 (8 %) | **56 (92 %)** |

En las dos corridas el primer enlace de autor de la primera tarjeta era
`#/explorer/author/Romain%20Grane?arxivId=2609.05134`: la puerta lenta.

La proporción se mueve con la composición del feed:

| Corrida | arxiv | openalex | nasa-ads |
|---|---|---|---|
| Primera página | 7 | 10 | 1 |
| Tras ocho páginas | 20 | 3 | 0 |

Las páginas siguientes son casi enteramente arXiv del día (`2609.049xx`), y arXiv
es la fuente que nunca trae id.

> Una carga, un usuario, un juego de preferencias, dos corridas el mismo día. La
> dirección (mayoría lenta, y peor al bajar) es sólida; el número exacto se
> vuelve a medir con la sonda.

---

## 2. De dónde viene que la ficha no traiga id

Tres causas distintas, y sólo una es nuestra.

### 2.1 arXiv nunca trae id — y el enriquecimiento no lo pide

`src/services/adapters/ArxivAdapter.js:48-54` construye cada autor con `id: null`
a mano. Eso es correcto: el Atom de arXiv no tiene ids de autor.

Lo que falla es que el enriquecimiento posterior tampoco los trae, por **dos
agujeros independientes**:

- **`OPENALEX_ENRICHMENT_SELECT` (`src/services/openAlexService.js:50-69`) no
  incluye `authorships`.** La petición que el feed ya hace por cada paper trae
  conceptos, topics, citas, localizaciones y el abstract invertido — pero no los
  autores. Confirmado en vivo: de 18 papers del snapshot, **5 traían blob de
  OpenAlex y ninguno traía autores** (`papersWhoseBlobHasAuthors: 0`); las claves
  del blob son exactamente las del `select`.
- **`PaperBuilder.merge` (`src/services/PaperBuilder.js:120-275`) no toca
  `merged.authors`.** Copia arxivId, doi, journal, instituciones, topics,
  métricas… y salta autores. Aunque el `select` los trajera, se quedarían dentro
  de `paper.openAlex` sin llegar a la ficha.

Así que la hipótesis «el id está en el paper y no se propaga» **es falsa hoy**:
el id ni siquiera se pide. Haría falta cerrar los dos agujeros, no uno.

### 2.2 OpenAlex no tiene el paper

Los preprints frescos no están indexados. Comprobado contra la API con el filtro
que usa el propio enriquecimiento (`locations.landing_page_url`):

| Lote | En OpenAlex |
|---|---|
| 5 papers de arXiv con `enrichedBy: openalex` | 5 de 5, y **16 de 16 autorías con id** |
| 18 preprints `2609.*` de la segunda página | **0 de 18** |

De esos 18, sólo uno (`2609.04966`) existe en OpenAlex, y únicamente por su DOI
de revista — una vía que `getOpenAlexEnrichmentId` (`src/utils/feedEnrichment.js:3-19`)
no prueba nunca: sólo mira `paper.id` y `paper.arxivId`.

### 2.3 OpenAlex tiene el paper pero no ha desambiguado al autor

Tres papers con `primary: 'openalex'` repartían puerta lenta. No es un fallo
nuestro: la API devuelve `author.id: null` en sus autorías.

```
W3105998192  authorships 29  con id 0   (primero: {"id": null, "display_name": "Do, Tuan"})
W2323460674  authorships  2  con id 0
W1973727784  authorships  3  con id 0
```

---

## 3. ¿Se puede resolver el id antes de navegar?

**En parte, y menos de lo que parece.** Repartiendo los enlaces lentos por causa:

| Causa | Primera página | Tras ocho páginas | ¿Se puede resolver antes? |
|---|---|---|---|
| OpenAlex tiene el paper y los ids | **9 / 24 (37 %)** | **2 / 56 (3,6 %)** | Sí, y **sin una sola petición nueva** |
| Sólo alcanzable por DOI de revista | 0 | 3 / 56 (5,4 %) | Sí, ampliando el resolutor de id |
| OpenAlex no tiene el paper | 7 / 24 | 51 / 56 | **No.** No hay id que resolver |
| OpenAlex no desambiguó al autor | 8 / 24 | 3 / 56 | **No.** Aguas arriba |

El primer caso es gratis en peticiones: el feed **ya hace** esa llamada a
`/works`, y OpenAlex cobra por llamada, no por campo — el argumento que el propio
código usa (`openAlexService.js:63-67`) para llevar el abstract invertido de
gorra. Medido el coste en bytes sobre diez works:

| `select` | Bytes | Por work |
|---|---|---|
| Actual | 94 641 | 9 464 |
| Actual + `authorships` | 151 373 | 15 137 (**+60 %**) |

+5,7 KB por paper, +85 KB por página de quince. Es la decisión que hay que tomar,
no un detalle de implementación.

### Lo que de verdad domina: dos peticiones condenadas

Para el caso mayoritario (paper que OpenAlex no tiene),
`getAuthorProfileExact` (`openAlexService.js:464-537`) hace, en serie:

1. `works/doi:10.48550/arxiv.<id>` → **404**
2. `works?filter=doi:10.48550/arxiv.<id>` → 200 con cero resultados
3. sólo entonces, `getAuthorProfile(<nombre>)`, que es lo único que podía funcionar

El feed ya sabe que ese paper no está en OpenAlex — acaba de intentar
enriquecerlo y no ha vuelto nada. Ese saber no viaja con el enlace.

### Tres puertas medidas de nuevo, la misma sesión

Para que los tres números sean comparables entre sí (el de la auditoría de
animaciones se midió antes, con la caché en otro estado):

| Ruta | Esqueleto | **Héroe vivo** | Tarjeta ORCID | Filas | Peticiones a `/works` |
|---|---|---|---|---|---|
| Por id `A5006398227?name=…` | 400 ms | **433 ms** | 929 ms | 3957 ms | 2 |
| Por nombre, OpenAlex **sí** tiene el paper (`Gavrilik?arxivId=2309.03290`) | 415 ms | **2462 ms** | 2706 ms | 6326 ms | 4 |
| Por nombre, OpenAlex **no** tiene el paper (`Grane?arxivId=2609.05134`) | 458 ms | **1848 ms** | 2038 ms | 2841 ms | 3 |

La puerta lenta no cuesta lo mismo siempre: el caso indexado es el **peor**
(2462 ms) porque sus tres viajes tienen éxito y traen 14-16 KB cada uno; el caso
no indexado falla barato (404 en ~275 ms, búsqueda vacía en ~167 ms) y aterriza
antes, en 1848 ms. Aun así, ambos están lejos de los 433 ms del id.

### Un efecto que no es de velocidad

La búsqueda por nombre puede aterrizar en la persona equivocada. `A. M. Gavrilik`
devuelve **tres** entidades distintas en OpenAlex (92 works/h15, 9 works/h1,
1 work/h0). Cuando la autoría del paper resuelve, el emparejamiento es exacto;
cuando se cae al buscador de nombres —el caso mayoritario— no hay nada que
garantice cuál de las tres se abre.

---

## 4. Qué NO se ha hecho

Cuando se escribió esta sección, nada de código de producción: era sólo la
investigación que pedía el encargo. Al día siguiente se implementó — ver §6.
La pista desde la tarjeta («este paper no está en OpenAlex», que el feed ya
sabe) se descartó a favor de la búsqueda en paralelo, que deja el caso en un
viaje sin cambiar el contrato de la URL ni arriesgarse a que la señal mienta.

## 5. Cómo repetir la medida

```bash
npm run build && npx vite preview --port 5174 --strictPort
# El usuario abre esta ventana y entra él; nunca se le piden credenciales.
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --remote-debugging-port=9223 --user-data-dir="$HOME/.papertok-probe-profile" \
  --no-first-run --no-default-browser-check http://localhost:5174
# Cerrarla — Chrome bloquea el --user-data-dir — y medir:
PROFILE_DIR="$HOME/.papertok-probe-profile" ORIGIN=http://localhost:5174 \
  node scripts/diagnostics/author-door-census.mjs 20000
SCROLL=8 PORT=9232 PROFILE_DIR="$HOME/.papertok-probe-profile" ORIGIN=http://localhost:5174 \
  node scripts/diagnostics/author-door-census.mjs 15000
```

---

## 6. Después (2026-09-08)

Implementado en `fix/puerta-autor-openalex-id`: el enriquecimiento pide
`authorships`, `PaperBuilder.merge` injerta los ids sobre los autores que la
tarjeta ya muestra, el resolutor de id prueba el DOI de revista, y
`getAuthorProfileExact` pierde su petición de repuesto y lanza la búsqueda por
nombre en paralelo.

### El mecanismo, comprobado

| | Antes | Después |
|---|---|---|
| Papers enriquecidos cuyo blob traía autores | **0 de 5** | **8 de 8** |
| Enlaces de autor por la puerta rápida | 18 de 42 (43 %) | **41 de 47 (87 %)** |

> El feed no reparte la misma página en dos cargas — la del «antes» traía siete
> papers de arXiv del día y la del «después» ninguno — así que **el 43 % → 87 %
> no es una comparación de igual a igual**. Lo que sí es prueba directa es la
> primera fila: ningún blob traía autores y ahora los traen todos. Los seis
> lentos que quedan son los dos casos que no dependen de nosotros: OpenAlex sin
> el paper, u OpenAlex sin desambiguar la autoría.

### La cadena del Explorer, A/B limpio

Las dos implementaciones importadas en Node contra la API real, un proceso por
medida y alternando cuál va primero (sin sesión, sin app, sin el Worker de por
medio: mide la forma de la cadena, no la latencia dentro de la aplicación).
Identidad resuelta **idéntica** en los cuatro pares.

| Caso | Antes | Después |
|---|---|---|
| Indexado — Gavrilik (viejo primero) | 992 ms | **521 ms** |
| No indexado — Grane (viejo primero) | 651 ms | **431 ms** |
| No indexado — Cuello (nuevo primero) | 1117 ms | **599 ms** |
| Indexado — Kamionkowski (nuevo primero) | 812 ms | **484 ms** |

### En vivo, con sesión

Mismo origen y mismo perfil que la corrida del 07-09. Héroe vivo:

| Ruta | Antes | Después |
|---|---|---|
| Nombre, paper indexado (`Gavrilik?arxivId=2309.03290`) | 2462 ms | **958 / 821 / 1172 ms** |
| Nombre, paper no indexado (`Grane?arxivId=2609.05134`) | 1848 ms | **792 / 774 / 815 ms** |

La primera muestra de Grane dio 2018 ms y las tres siguientes 774-815: era la
caché de OpenAlex en frío, no la ruta.

> Estas tres corridas se midieron sobre un `dist` del árbol compartido que
> llevaba también trabajo en vuelo de otra sesión sobre las animaciones del
> Explorer. Afecta al movimiento, no a cuándo llegan los datos, pero queda
> dicho.
