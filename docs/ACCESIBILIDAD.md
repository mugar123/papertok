# Instrucciones permanentes para Codex: web accesible según WCAG 2.2

## Propósito y uso

Este documento contiene las instrucciones permanentes de accesibilidad para el agente que diseñe, programe, revise o modifique esta web.

Si el proyecto usa Codex, coloca este archivo en la raíz del repositorio con el nombre `AGENTS.md` o incorpora su contenido al `AGENTS.md` existente. Si ya hay instrucciones del proyecto, consérvalas y añade estas reglas sin borrar ninguna obligación previa.

La accesibilidad es un requisito funcional y de calidad de toda la web, no una tarea final ni un informe separado. Debe tenerse en cuenta en los requisitos, la arquitectura, el diseño visual, los componentes, el contenido, el código, las pruebas y cada nueva modificación.

## Norma de referencia y objetivo

- Usa **WCAG 2.2** como referencia principal.
- El objetivo por defecto es la conformidad con **todos los criterios de conformidad de nivel A y AA** aplicables.
- Cuando el producto lo permita, aplica también mejoras de nivel AAA, pero no presentes el nivel AAA como requisito cumplido si no se ha verificado.
- La referencia normativa es el original en inglés de W3C: `WCAG-2.2-original-ingles-W3C-2024-12-12.pdf` y <https://www.w3.org/TR/WCAG22/>.
- `WCAG-2.2-traduccion-espanol-no-oficial-2024-12-12.pdf` es una traducción de trabajo. Sirve para facilitar la lectura, pero, ante cualquier diferencia, prevalece el texto oficial de W3C.
- Esta guía no sustituye el texto completo de WCAG 2.2 ni sus documentos de comprensión y técnicas. Consulta el criterio exacto cuando una decisión dependa de una excepción o de una interpretación.

No declares que la web es accesible, que cumple WCAG o que tiene conformidad AA basándote únicamente en Lighthouse, axe, WAVE, validadores automáticos o la ausencia de errores en consola. Las herramientas automáticas son una ayuda; no comprueban todo el contenido, el orden de lectura, la comprensión, la interacción real, el teclado ni la experiencia con tecnologías de apoyo.

## Regla de actuación en cada tarea

Antes de cambiar nada:

1. Inspecciona la estructura existente, las rutas, los estados, los componentes reutilizables, los formularios, los diálogos, los menús y los flujos principales.
2. Identifica qué criterios WCAG 2.2 pueden afectar a la tarea y conviértelos en criterios de aceptación verificables.
3. Reutiliza patrones accesibles ya existentes y corrige el componente común en lugar de parchear cada pantalla.
4. Implementa la solución accesible junto con la funcionalidad visual.
5. Ejecuta las comprobaciones automáticas y las pruebas manuales proporcionales al cambio.
6. Registra los criterios comprobados, la evidencia, los defectos restantes y las limitaciones de la prueba.

Si una petición de diseño contradice la accesibilidad, conserva la accesibilidad y explica el conflicto. No ocultes el problema con `aria`, CSS o una excepción inventada. Si falta una decisión de producto, formula una pregunta concreta, pero no rebajes silenciosamente el objetivo AA.

## Reglas no negociables de diseño y código

### Estructura semántica

- Usa HTML semántico nativo: `header`, `nav`, `main`, `aside`, `footer`, `section`, `article`, `form`, `button`, `a`, listas, tablas y encabezados.
- Mantén una jerarquía de encabezados lógica y coherente. La apariencia visual no debe decidir por sí sola la semántica.
- Cada página debe tener un título descriptivo, un elemento `main` identificable y un atributo `lang` correcto en el elemento `html`.
- Proporciona un mecanismo para saltar bloques repetidos, como un enlace visible al recibir el foco hacia el contenido principal.
- El orden del DOM y el orden de lectura deben ser comprensibles y coincidir con el orden visual y de interacción.
- No uses `div` o `span` con eventos de clic como sustitutos de botones o enlaces.
- Un enlace navega a otra ubicación; un botón ejecuta una acción. Conserva esa diferencia.
- Usa ARIA solo cuando sea necesario, con roles, nombres, estados y propiedades válidos. No sustituyas una semántica nativa correcta por ARIA y no añadas roles contradictorios.

### Teclado y foco

- Toda función debe poder utilizarse con teclado, sin exigir ratón, arrastre, precisión visual o gestos.
- Comprueba `Tab`, `Shift+Tab`, `Enter`, `Space`, flechas y `Escape` cuando sean relevantes.
- El orden del foco debe ser lógico. No uses `tabindex` positivo y no dejes controles interactivos fuera del recorrido.
- El indicador de foco debe ser siempre visible y tener suficiente contraste. No uses `outline: none` sin proporcionar un indicador equivalente claramente visible.
- El foco nunca debe quedar atrapado. Los diálogos deben gestionar el foco al abrirse, mantenerlo dentro mientras están abiertos, cerrarse de forma accesible y devolverlo al elemento que los abrió.
- El contenido creado por el autor, incluidos encabezados fijos, barras, banners, menús y ventanas flotantes, no debe ocultar el foco. Cumple como mínimo el criterio 2.4.11, `Focus Not Obscured (Minimum)`.
- No cambies de contexto al recibir el foco ni al modificar un campo sin avisar y sin una acción explícita del usuario.
- En aplicaciones de una sola página, mueve el foco de forma predecible al cambiar de ruta o de vista y anuncia el nuevo título o encabezado.

### Contraste, color y presentación

- Texto normal: contraste mínimo de 4,5:1. Texto grande: mínimo de 3:1.
- Componentes de interfaz, indicadores de foco, bordes necesarios y gráficos esenciales: mínimo de 3:1 frente a colores adyacentes cuando el criterio sea aplicable.
- No comuniques información, estados o errores usando solo color. Añade texto, iconos con nombre accesible, patrones u otra señal perceptible.
- El contenido debe seguir siendo utilizable al aumentar el texto hasta el 200 % y al ampliar la página hasta el 400 % o una anchura equivalente de 320 píxeles CSS, sin pérdida de contenido ni funcionalidad salvo excepciones justificadas de contenido bidimensional.
- Permite el espaciado de texto exigido por WCAG 1.4.12 sin recortes ni solapamientos.
- Evita texto incrustado en imágenes. Si es imprescindible, proporciona el texto equivalente y contrasta la imagen.
- Respeta `prefers-reduced-motion`. No uses animaciones, parpadeos o desplazamientos que puedan provocar malestar, distracción o convulsiones.
- El contenido que aparece al pasar el puntero o recibir el foco debe poder permanecer visible, ser descartable y poder alcanzarse sin que desaparezca al intentar interactuar con él.

### Imágenes, iconos, audio y vídeo

- Toda imagen informativa debe tener un texto alternativo que transmita su propósito.
- Las imágenes decorativas deben usar `alt=""` y no generar ruido para el lector de pantalla.
- Las imágenes complejas necesitan una descripción suficiente en el contenido o un enlace a una descripción ampliada.
- Los iconos que funcionan como controles deben tener un nombre accesible. Un icono sin texto visible no puede quedarse sin etiqueta.
- Los controles multimedia deben ser accesibles por teclado y tener nombres y estados comprensibles.
- El vídeo pregrabado debe tener subtítulos; proporciona transcripción y audiodescripción cuando el criterio aplicable lo requiera.
- No reproduzcas automáticamente audio con duración superior a tres segundos sin un mecanismo accesible para pausarlo, detenerlo o controlar su volumen de forma independiente.

### Formularios y errores

- Cada campo debe tener una etiqueta visible y asociada programáticamente.
- Agrupa los campos relacionados con `fieldset` y `legend` cuando corresponda.
- Proporciona instrucciones, formato esperado, unidades, campos obligatorios y restricciones antes o junto al campo.
- Usa `autocomplete` e identifica programáticamente el propósito de los campos de información personal cuando sea aplicable.
- Asocia cada error al campo correspondiente y describe el problema en texto claro.
- Ofrece sugerencias de corrección cuando sean conocidas y conserva los valores introducidos cuando sea seguro hacerlo.
- Los mensajes de error y confirmación deben anunciarse sin mover inesperadamente el foco ni depender solo de color.
- Antes de enviar datos jurídicos, financieros, compromisos, compras o cambios importantes, permite revisar, corregir y confirmar la información.
- No pidas al usuario que vuelva a introducir información que ya proporcionó si puede rellenarse, seleccionarse o reutilizarse de forma segura.
- La autenticación no debe exigir recordar, transcribir o resolver una prueba cognitiva si existe una alternativa accesible. Evita CAPTCHA inaccesibles y proporciona métodos alternativos.

### Componentes dinámicos y estados

- Todo componente debe exponer correctamente su nombre, rol, estado, valor y relaciones a las tecnologías de apoyo.
- Los botones de menú, acordeones, pestañas, selectores, interruptores y desplegables deben anunciar si están abiertos, cerrados, seleccionados, deshabilitados o cargando.
- Los cambios de estado, resultados de búsqueda, validaciones, cargas y confirmaciones deben comunicarse mediante texto accesible o regiones de estado apropiadas, sin anunciar cada cambio irrelevante.
- No elimines del DOM el contenido que un usuario pueda necesitar mientras todavía deba leerlo o interactuar con él.
- Evita actualizaciones automáticas inesperadas. Proporciona pausa, detención, control del tiempo o aviso cuando el contenido cambie por sí solo.
- Los menús, tooltips, modales y popovers deben poder abrirse, recorrerse y cerrarse con teclado y deben tener un comportamiento comprensible para lectores de pantalla.

### Táctil, puntero y movimiento

- Proporciona alternativas a las funciones que exigen arrastrar. Cumple el criterio 2.5.7, `Dragging Movements`.
- Los objetivos de puntero deben medir como mínimo 24 por 24 píxeles CSS, salvo las excepciones previstas por WCAG 2.2. Cuando sea viable, usa objetivos mayores y separados.
- No dependas de un gesto multipunto, una trayectoria concreta o la inclinación del dispositivo si existe una alternativa con un solo puntero.
- Permite cancelar acciones iniciadas con el puntero y no ejecutes acciones irreversibles solo al pulsar accidentalmente.
- El texto visible de un control debe formar parte de su nombre accesible.

### Contenido, idioma y ayuda

- Declara correctamente el idioma de la página y marca los cambios de idioma dentro del contenido.
- Los enlaces deben describir su destino incluso fuera de contexto cuando sea necesario; no uses enlaces ambiguos como "aquí" repetidos.
- Mantén ayudas, contacto, soporte, búsqueda y otros mecanismos recurrentes en la misma posición relativa cuando aparezcan en varias páginas. Cumple el criterio 3.2.6, `Consistent Help`.
- Escribe mensajes, títulos, etiquetas y errores en lenguaje claro. No dependas de instrucciones basadas solo en forma, color, posición, tamaño o sonido.
- Las tablas necesitan encabezados identificables, relación clara entre encabezados y celdas y una estructura que siga siendo comprensible con lector de pantalla.

## Criterios específicos de WCAG 2.2 que deben comprobarse

Además de la revisión general, verifica expresamente los criterios nuevos o modificados relevantes de WCAG 2.2:

- 2.4.11 `Focus Not Obscured (Minimum)` - el foco no queda oculto por contenido creado por el autor.
- 2.5.7 `Dragging Movements` - toda función de arrastre tiene una alternativa que no requiere arrastrar.
- 2.5.8 `Target Size (Minimum)` - los objetivos de puntero cumplen 24 por 24 píxeles CSS o una excepción válida.
- 3.2.6 `Consistent Help` - la ayuda repetida aparece de forma consistente.
- 3.3.7 `Redundant Entry` - no se solicita de nuevo información ya disponible salvo necesidad justificada.
- 3.3.8 `Accessible Authentication (Minimum)` - la autenticación no exige una prueba cognitiva innecesaria.
- 4.1.3 `Status Messages` - los mensajes de estado pueden determinarse programáticamente sin recibir el foco.

Considera también 2.4.12 `Focus Not Obscured (Enhanced)` y 2.4.13 `Focus Appearance` como mejoras recomendables de nivel AAA cuando el proyecto pueda asumirlas. El criterio 4.1.1 `Parsing` figura como obsoleto y eliminado en WCAG 2.2; aun así, el código debe ser válido, semántico y compatible con navegadores y tecnologías de apoyo.

## Proceso mínimo de pruebas

### Pruebas automáticas

Ejecuta, según el stack del proyecto:

- análisis con axe-core u otra herramienta equivalente;
- comprobación de nombres, roles, estados y relaciones ARIA;
- contraste de colores y estados de foco;
- validación de HTML, CSS y errores de consola relevantes;
- pruebas de rutas, formularios, estados de error, diálogos, menús y contenido cargado dinámicamente;
- pruebas automatizadas de regresión para cada defecto de accesibilidad corregido.

Trata los resultados automáticos como indicios que deben confirmarse. Un resultado "cero errores" no demuestra conformidad.

### Pruebas manuales y con tecnologías de apoyo

- Recorre cada flujo principal usando únicamente teclado, desde el principio hasta el final.
- Verifica el orden, la visibilidad, el contraste y la ausencia de trampas de foco.
- Prueba zoom, reflujo, orientación, ventanas estrechas, teclado virtual y tamaños de texto grandes.
- Comprueba estados de carga, éxito, error, validación, modal, menú, pestaña, acordeón y contenido vacío.
- Prueba al menos un lector de pantalla real en las plataformas que el proyecto deba soportar. Si no se ha podido hacer esta prueba, declara expresamente la limitación y no afirmes que la experiencia con lector de pantalla está verificada.
- Comprueba la web con contenido real, no solo con textos de prueba. Revisa nombres de personas, fechas, enlaces, tablas, imágenes, mensajes y datos largos.
- Si se usa una biblioteca o un componente de terceros, verifica su comportamiento real; no des por válida su accesibilidad por la documentación del proveedor.

## Evidencia y criterio de finalización

Para cada entrega, genera o actualiza una matriz con al menos estas columnas:

| Página o flujo | Componente | Criterio WCAG | Resultado | Evidencia | Defecto o limitación | Reprueba |
|---|---|---|---|---|---|---|

Usa `Cumple`, `No cumple`, `No aplicable` o `No verificado`. Justifica siempre `No aplicable` y `No verificado`. La evidencia puede ser una prueba automatizada, una ruta reproducible, una captura, un resultado de teclado, un caso de lector de pantalla o una prueba de código, pero debe permitir repetir la comprobación.

No cierres una tarea como terminada si:

- queda un incumplimiento de nivel A o AA en una ruta o estado que forma parte del alcance;
- existe un control esencial sin nombre accesible o sin operación por teclado;
- el foco puede perderse, quedar oculto o quedar atrapado;
- un formulario no identifica correctamente sus campos o errores;
- el contenido esencial desaparece con zoom, reflujo o texto ampliado;
- se ha usado una auditoría automática como única evidencia;
- no se ha indicado qué páginas, estados, navegadores, tecnologías de apoyo o contenidos quedaron fuera de la prueba.

Al terminar cada cambio, informa brevemente de los criterios afectados, las pruebas ejecutadas, los defectos corregidos y cualquier riesgo pendiente. La accesibilidad debe seguir siendo un criterio de aceptación en todas las tareas posteriores, aunque la petición del usuario se centre en otra parte de la web.

## Principio final para el agente

Diseña para personas reales y para distintas formas de navegar, percibir, entender e interactuar. La solución correcta es la que mantiene la funcionalidad, la información y la autonomía del usuario sin exigir una única capacidad sensorial, motora o cognitiva.
