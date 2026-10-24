import type { ESLint } from 'eslint'
import {
  darkThemeParity, definedCustomProperties, focusRingUnlayered, noBrandOrangeFocusRing,
  noExternalCssUrls, noFocusRingRemoval, noRetiredColours, tokenContrast,
} from './css.ts'
import { patternedButtons } from './patternedButtons.ts'

/** PaperTok's structural invariants, the ones a stylesheet or a component can break without failing a build. */
const papertok: ESLint.Plugin = {
  meta: { name: 'papertok' },
  rules: {
    'no-focus-ring-removal': noFocusRingRemoval,
    'no-brand-orange-focus-ring': noBrandOrangeFocusRing,
    'focus-ring-unlayered': focusRingUnlayered,
    'token-contrast': tokenContrast,
    'dark-theme-parity': darkThemeParity,
    'defined-custom-properties': definedCustomProperties,
    'no-retired-colours': noRetiredColours,
    'no-external-css-urls': noExternalCssUrls,
    'patterned-buttons': patternedButtons,
  },
}

export default papertok
