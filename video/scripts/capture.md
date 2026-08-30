# Registro de capturas — 2026-08-30

Todas via CDP (puerto 9223, perfil `/tmp/papertok-capture-profile`) con
`scripts/capture.mjs` (navega y captura) y `scripts/shot.mjs` (interactúa y
captura sin recargar). Viewport CSS 1600×1000 salvo indicación. La app usa
HashRouter: navegar exige recargar (`location.href=…; location.reload()`),
un cambio de hash sin recarga rompe la SPA («Something went wrong»).

| Fichero | URL / interacción | Scale | Dimensiones |
|---|---|---|---|
| `arxiv-list.png` | <https://arxiv.org/list/cs.LG/recent> (Chrome headless, `--force-device-scale-factor=4`, viewport 1600×1000) | 4 | 6400×4000 |
| `feed-a.png` | `#/public/paper/YXJ4aXY6MTcwNi4wMzc2Mg` (arxiv:1706.03762, «Attention Is All You Need»), sesión iniciada | 2 | 3200×2000 |
| `feed-b.png` | `#/public/paper/` de arxiv:2005.14165 («Language Models are Few-Shot Learners») | 2 | 3200×2000 |
| `reader-clean.png` | Desde feed-b: botón «Read article» → PdfModal con el PDF de arXiv, página 1. Sin respuesta IA | 2 | 3200×2000 |
| `lists-modal.png` | Desde feed-b: botón «Save» → modal «Save and organize» | 2 | 3200×2000 |
| `lists-grid.png` | `#/lists` («My lists»: Favorites 9, Read later 0, Reading history 3) | 2 | 3200×2000 |
| `explorer-author.png` | `#/explorer/author/Kenneth%20P.%20Bogart?arxivId=openalex:W2340364767` | 2 | 3200×2000 |
| `explorer-concepts.png` | `#/explorer/topic/T10682` (Quantum Computing Algorithms and Architecture), llegado desde búsqueda «Quantum computing» → Topics | 2 | 3200×2000 |
| `research-report.png` | `#/research` con panel Refine abierto, países United States y Spain seleccionados (mapa coloreado), viewport 1600×2400 | 2 | 3200×4800 |

Notas:
- La clave de `#/public/paper/` es base64url de `arxiv:<id>` (`Buffer.from('arxiv:1706.03762').toString('base64url')`).
- El banner de analítica se descartó con «Dismiss and do not allow» (persistente en el perfil).
- El feed «For you» de la cuenta mostraba libros antiguos sin figuras; por eso
  feed-a/feed-b son páginas públicas de paper (idéntico layout de tarjeta, con
  figuras flotantes).
