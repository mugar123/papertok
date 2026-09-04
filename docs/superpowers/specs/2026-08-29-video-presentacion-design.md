# Vídeo de presentación de PaperTok — diseño

Fecha: 2026-08-29

## Objetivo

Producir un vídeo promocional de PaperTok de ~80-85 s, 1920×1080 a 60 fps, para
publicar en X y LinkedIn. La referencia de estilo es el anuncio de ChatGPT Work de
OpenAI (100 s, 1080p60), analizado fotograma a fotograma antes de escribir esto.

## Lectura de la referencia

El anuncio de OpenAI no es una grabación de pantalla: es interfaz **reconstruida** en
componentes. El composer aparece flotando sin navegador alrededor, la ventana de app
lleva sombra propia sobre un fondo estrellado, y el móvil tiene un marco dibujado.

Su estructura es un sándwich repetido seis veces: cartela tipográfica en negro sobre
blanco cálido, con una palabra en color, seguida de una escena de producto. Las
cartelas **se escriben letra a letra**; se comprueba en los fotogramas cortados a media
palabra (`Introducing ChatGPT Wo`, `Turn rough i`, `even when you're awa`). Ese
typewriter es la firma del vídeo, y se aplica también al texto dentro del composer y a
las respuestas del modelo.

Las seis escenas siguen un solo caso de uso de punta a punta (el diseño de una lámpara),
no un catálogo de funciones.

## Decisiones

1. **Remotion**, no Claude Design. El vídeo es interfaz en componentes animados, es
   decir React renderizado a mp4. Claude Design produce lienzos estáticos: sirve para
   maquetar fotogramas clave, no para producir el entregable.
2. **Recorrido de funciones** como eje narrativo, por decisión del usuario. Queda
   registrada la reserva: la referencia funciona porque hay una sola historia, y un
   catálogo pierde ese hilo. Se compensa con el orden de las escenas (ver Guion).
3. **Producción híbrida**: capturas reales de la app en producción como base, más
   reconstrucción en componentes de los momentos donde el movimiento es el mensaje.
4. **Cartelas en inglés.**
5. **Sin audio en la v1.** El montaje no depende de una pista: si más adelante aparece
   música con licencia, se añade sin recortar ni reordenar escenas.
6. **Tipografías de la app, no las de la referencia.** La de OpenAI es OpenAI Sans,
   propietaria; además, usar la tipografía de otra marca haría que el vídeo se leyera
   como suyo. PaperTok ya usa **Inter**, del mismo género (grotesca neutra). Lo que
   produce el efecto de la referencia es el tratamiento, no la fuente: peso 600-700,
   cuerpo grande, tracking -0.02em, dos líneas centradas y el texto escribiéndose.
   **Newsreader**, la serif de la app, se reserva para la apertura de arXiv: es el
   idioma nativo del paper académico y marca el contraste entre el antes y PaperTok.

## Paleta

Tomada de `src/styles/variables.css`, sin inventar valores:

- Tinta / texto de cartelas: `--accent-primary` = `#111318`
- Palabra destacada de cada cartela: `--accent-secondary` = `#1a5fd0`
- Fondo de cartelas: blanco cálido de la app

El azul cumple el papel que en la referencia cumple el verde de «Introducing ChatGPT
**Work**»: una sola palabra en color por cartela.

## Guion

### Apertura — arXiv (0:00-0:09)

Listado real de arXiv, capturado a escala alta. Plano fijo, sin movimiento, sostenido
dos segundos más de lo cómodo: la incomodidad es el argumento. Texto pequeño en
Newsreader, abajo a la izquierda, escribiéndose:

> **This is where science gets published.**
>
> *(beat)*
>
> **It's just not where anyone reads it.**

El texto no ataca a arXiv: afirma que es un archivo, no un lugar donde se pasa el rato.
arXiv es marca de terceros; el vídeo no debe insinuar respaldo ni menosprecio.

### El corte (0:09-0:13)

Zoom continuo hacia el logotipo `arXiv`. Empieza sobre la captura real y, cuando el
encuadre ya solo muestra el logotipo, cruza a un SVG vectorial y continúa hasta que el
trazo de la **X** llena el cuadro. Negro. Medio segundo de silencio.

El cruce a vectorial no es un adorno: un zoom de ~40× sobre un PNG se pixela a los dos
tercios del movimiento. Alternativa aceptable si el cruce se complica: capturar arXiv
con `deviceScaleFactor` 4-5 en CDP.

### Cartelas y escenas

| # | Cartela (palabra en azul) | Escena |
|---|---|---|
| 1 | Introducing **PaperTok** | Sobre el negro; el negro se abre a blanco |
| 2 | Science, one **swipe** at a time | Feed vertical: tarjeta que sube, resumen, like |
| 3 | Read it like it was **written for you** | Lector: selección, anotación, respuesta IA escribiéndose |
| 4 | Keep what **matters** | Guardar en lista; rejilla de listas |
| 5 | Follow the **thread** | Explorador: autor → conceptos → citas |
| 6 | A week of reading, **one report** | /research: filtros, mapa mundial, informe generándose |
| 7 | Put science back in your **feed** | Logo PaperTok sobre blanco. Fin |

### Por qué este orden

Es la curva real de un usuario —descubre, lee, guarda, tira del hilo, sintetiza—, no una
lista de casillas: el producto parece abrirse en vez de enumerarse. El arco cierra donde
abrió: empieza en un listado que nadie lee y termina en un feed que sí.

Duración estimada 80-85 s, siete bloques de ~11 s. Si hiciera falta alargar, la escena 6
es la única que admite más metraje sin dañar el ritmo: un informe generándose aguanta
plano largo, un swipe no.

## Producción plano a plano

Principio rector: **la captura da fidelidad, el texto superpuesto da movimiento.** Cada
pantalla se captura *sin* su texto protagonista, y ese texto se escribe encima como texto
real de Remotion. Así el typewriter es genuino y no un vídeo de un vídeo.

| Plano | Captura real | Reconstruido |
|---|---|---|
| arXiv | Listado a escala 3× o más | El zoom abandona la captura y pasa a SVG |
| Cartelas 1-7 | — | Todo: texto puro, Inter 700, tracking -0.02em |
| Feed | Dos tarjetas de paper | El swipe: las capturas se mueven con un muelle |
| Lector | El paper **sin** la respuesta IA | Selección, anotación y respuesta escribiéndose |
| Listas | Modal de guardar y rejilla | El clic y la transición entre ambos |
| Explorador | Entidad de autor y conceptos | El recorrido del encuadre entre las tres |
| Research | Informe con el mapa mundial | Filtros aplicándose; informe apareciendo por bloques |
| Cierre | — | Logo |

Todo plano de app se compone sobre fondo con sombra propia y encuadre animado suave.

### Capturas

Producción: <https://mugar123.github.io/papertok/#/>. La app usa HashRouter, así que la
navegación durante la captura es cambiar el hash y recargar.

**El login lo hace el usuario.** El feed y el lector exigen sesión iniciada. Se usa el
arnés de Chrome dedicado por CDP en el puerto 9223: el usuario se autentica en esa
ventana y a partir de ahí la captura es automática. No se piden ni se manejan
credenciales.

## Estructura del proyecto

Remotion vive en `video/`, **con su propio `package.json`, aislado del proyecto
principal**. Tres razones concretas:

- Añadir Remotion al `package.json` raíz mete decenas de MB y un binario de Chrome en el
  `npm ci` de CI.
- `wrangler` sube el árbol entero al desplegar el Worker.
- `npm run lint` ejecuta `eslint .`, que recorrería `video/`: hay que excluirlo
  explícitamente en `eslint.config`.

`npm test` no se ve afectado: busca solo en `src worker proxy`.

```
video/
  package.json          remotion, aislado del raíz
  remotion.config.ts
  src/
    Root.tsx            composición 1920×1080 @60fps
    script.ts           guion completo: textos y tiempos, fuente única
    theme.ts            #111318, #1a5fd0, Inter, Newsreader
    components/
      Typewriter.tsx
      Screenshot.tsx    captura + sombra + encuadre animado
    scenes/             una por bloque del guion
  public/shots/         PNG capturados
  out/                  ignorado por git
```

Las fuentes se cargan con `@remotion/google-fonts`, de modo que Inter y Newsreader se
empaquetan y el render no depende de la red.

## Verificación

El asistente no puede reproducir vídeo. La verificación se hace con `remotion still`,
que extrae fotogramas sueltos como PNG: esos sí se pueden mirar. Cada escena se valida
revisando sus fotogramas clave, igual que se analizó la referencia. El usuario ve el
movimiento en vivo con `npx remotion studio`, sin esperar a ningún render.

Salida final: `remotion render`, H.264 1080p60 con `faststart`, que es lo que esperan X
y LinkedIn.

## Licencia

Remotion no es MIT. Es gratuito para individuos y equipos pequeños y exige licencia de
pago por encima de cierto tamaño de empresa. PaperTok como proyecto personal cae en el
tramo gratuito; si en el futuro lo explota una empresa, hay que revisar sus términos
antes de seguir usándolo.

## Riesgos

1. **El zoom se pixela** si el cruce a vectorial no se resuelve. Mitigación descrita
   arriba; se valida con `remotion still` en el fotograma más ampliado antes de montar
   el resto.
2. **Las capturas envejecen.** Son PNG congelados: cualquier rediseño de la app los deja
   obsoletos sin que nada falle. Viven en `video/public/shots/` y se regeneran a mano.
3. **Deriva entre la app y el vídeo.** Es el precio del híbrido y se acepta a conciencia:
   el vídeo es una pieza de marketing con fecha, no un test de regresión visual.
