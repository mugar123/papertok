# Share card assets

The fonts and etchings `worker/share-card-render.ts` draws a profile's preview card with.
wrangler bundles them as data (`[[rules]]` in `wrangler.toml`).

| File | Source |
| --- | --- |
| `newsreader-display-400.ttf` | [Newsreader](https://github.com/google/fonts/tree/main/ofl/newsreader) variable font, instanced at weight 400 and optical size 72 |
| `newsreader-text-400.ttf` | The same font, instanced at weight 400 and optical size 16 |
| `inter-700-wordmark.ttf` | `@fontsource/inter` Latin 700, cut to the letters of "PaperTok" |
| `ibm-plex-mono-600.ttf` | `@fontsource/ibm-plex-mono` Latin 600, cut to printable ASCII plus `·`, `–`, `—`, `’` and `…` |
| `microscope.png`, `scrolls.png`, `lab.png` | `src/assets/welcome/`, recoloured in navy ink (`#1d2b53`) with the original alpha |

satori reads TrueType but not WOFF2, and it cannot use a variable font, so the fonts are
static instances. The two Newsreader files cover the Unicode ranges `DRAWABLE_RANGES` lists
in `worker/share-card.ts`: Basic Latin, Latin-1, Latin Extended-A and B, combining marks,
Latin Extended Additional and general punctuation. A name with any other character gets its
type's static image instead of a card. Change the ranges and the fonts together.

To rebuild them, with `fonttools` installed:

```python
from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont
from fontTools import subset

ranges = "U+0020-007E,U+00A0-024F,U+0300-036F,U+1E00-1EFF,U+2010-2027,U+2030-203A,U+20AC"
for opsz, name in [(72, "display"), (16, "text")]:
    font = instantiateVariableFont(TTFont("Newsreader[opsz,wght].ttf"), {"wght": 400, "opsz": opsz})
    options = subset.Options()
    options.layout_features = ["kern", "liga", "calt", "ccmp", "locl", "mark", "mkmk"]
    subsetter = subset.Subsetter(options)
    subsetter.populate(unicodes=subset.parse_unicodes(ranges))
    subsetter.subset(font)
    font.save(f"newsreader-{name}-400.ttf")
```

All three fonts are under the SIL Open Font License 1.1; the licences are in the `OFL-*.txt`
files beside them.
