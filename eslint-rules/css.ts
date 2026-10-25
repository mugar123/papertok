import { globSync, readFileSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import type { CSSRuleDefinition, CSSSourceCode } from '@eslint/css'

type CssNode = NonNullable<ReturnType<CSSSourceCode['getParent']>>
type Rule = Extract<CssNode, { type: 'Rule' }>
type Declaration = Extract<CssNode, { type: 'Declaration' }>
type StyleSheet = Extract<CssNode, { type: 'StyleSheet' }>

const reasoned = (key: string) => ({
  type: 'array',
  items: {
    type: 'object',
    properties: { [key]: { type: 'string' }, reason: { type: 'string', minLength: 1 } },
    required: [key, 'reason'],
    additionalProperties: false,
  },
})

/** Blank out comments, keeping offsets, so prose that names a pattern is not a use of it. */
const withoutComments = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, comment => comment.replace(/[^\n]/g, ' '))

const normalise = (text: string) => text.trim().replace(/\s+/g, ' ')

/** The selector of the rule a declaration sits in, or undefined inside an at-rule such as @font-face. */
function selectorOf(sourceCode: CSSSourceCode, declaration: Declaration) {
  const owner = sourceCode.getParent(sourceCode.getParent(declaration)!)
  return owner?.type === 'Rule' ? normalise(sourceCode.getText(owner.prelude)) : undefined
}

export const noFocusRingRemoval: CSSRuleDefinition<{ RuleOptions: [{ allowed: Array<{ selector: string; reason: string }> }] }> = {
  meta: {
    type: 'problem',
    docs: { description: 'Disallow switching the focus ring off without a recorded replacement' },
    schema: [{ type: 'object', properties: { allowed: reasoned('selector') }, additionalProperties: false }],
    defaultOptions: [{ allowed: [] }],
    messages: {
      removed: '`{{selector}}` switches the focus ring off: keep the ring, or draw a visible replacement and allowlist the selector with what draws it, because an unlayered `outline: none` beats the global :focus-visible ring (WCAG 2.4.7).',
    },
  },
  create(context) {
    const allowed = new Set(context.options[0].allowed.map(entry => normalise(entry.selector)))
    return {
      Declaration(node) {
        const property = node.property.toLowerCase()
        const value = normalise(context.sourceCode.getText(node.value)).toLowerCase()
        const removes = property === 'outline' ? ['none', '0', '0px'].includes(value)
          : property === 'outline-style' && value === 'none'
        if (!removes) return
        const selector = selectorOf(context.sourceCode, node) ?? ''
        if (!allowed.has(selector)) context.report({ node, messageId: 'removed', data: { selector } })
      },
    }
  },
}

export const noBrandOrangeFocusRing: CSSRuleDefinition<{ RuleOptions: [] }> = {
  meta: {
    type: 'problem',
    docs: { description: 'Disallow --brand-orange as an outline colour' },
    schema: [],
    messages: {
      brandOrange: 'Paint the ring with var(--focus-ring), not --brand-orange, which is #ff9d00 in both themes and 2.08:1 on a white page, below the 3:1 a focus indicator needs (WCAG 1.4.11).',
    },
  },
  create(context) {
    return {
      Declaration(node) {
        if (/^outline(-color)?$/i.test(node.property) && /var\(\s*--brand-orange\s*\)/.test(context.sourceCode.getText(node.value))) {
          context.report({ node, messageId: 'brandOrange' })
        }
      },
    }
  },
}

export const focusRingUnlayered: CSSRuleDefinition<{ RuleOptions: [] }> = {
  meta: {
    type: 'problem',
    docs: { description: 'Keep the global :focus-visible rule outside every cascade layer' },
    schema: [],
    messages: {
      layered: 'Move this :focus-visible rule out of @layer, because Tailwind puts `outline-none` in @layer utilities, which beats any rule in an earlier layer, and the ring would vanish from every primitive carrying it (WCAG 2.4.7).',
    },
  },
  create(context) {
    return {
      Rule(node) {
        if (normalise(context.sourceCode.getText(node.prelude)) !== ':focus-visible') return
        for (let parent = context.sourceCode.getParent(node); parent; parent = context.sourceCode.getParent(parent)) {
          if (parent.type === 'Atrule' && parent.name.toLowerCase() === 'layer') {
            context.report({ node, messageId: 'layered' })
            return
          }
        }
      },
    }
  },
}

const LIGHT = ':root'
const DARK = ":root[data-theme='dark']"

/** The custom properties of the top-level `:root` and dark blocks, by name. */
function themeBlocks(sourceCode: CSSSourceCode, stylesheet: StyleSheet) {
  const blocks = new Map<string, { rule: Rule; tokens: Map<string, Declaration> }>()
  for (const child of stylesheet.children) {
    if (child.type !== 'Rule') continue
    const selector = normalise(sourceCode.getText(child.prelude)).replace(/"/g, "'")
    if (selector !== LIGHT && selector !== DARK) continue
    const tokens = new Map<string, Declaration>()
    for (const item of child.block.children) {
      if (item.type === 'Declaration' && item.property.startsWith('--')) tokens.set(item.property, item)
    }
    blocks.set(selector, { rule: child, tokens })
  }
  return blocks
}

const valueOf = (sourceCode: CSSSourceCode, declaration: Declaration) => sourceCode.getText(declaration.value).trim()

/** WCAG 2.x relative luminance of a #rrggbb colour. */
function luminance(hex: string) {
  const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map(c => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

function contrast(a: string, b: string) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

export const tokenContrast: CSSRuleDefinition<{
  RuleOptions: [{ checks: Array<{ ratio: number; pairs: Array<[string, string]> }> }]
}> = {
  meta: {
    type: 'problem',
    docs: { description: 'Require colour token pairs to meet a contrast ratio in both themes' },
    schema: [{
      type: 'object',
      properties: {
        checks: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              ratio: { type: 'number' },
              pairs: { type: 'array', items: { type: 'array', items: { type: 'string' }, minItems: 2, maxItems: 2 } },
            },
            required: ['ratio', 'pairs'],
            additionalProperties: false,
          },
        },
      },
      additionalProperties: false,
    }],
    defaultOptions: [{ checks: [] }],
    messages: {
      missingBlock: 'Define the `{{block}}` block here, because the theme contrast is measured on it.',
      unmeasurable: 'Write {{token}} in {{theme}} as a #rrggbb literal, because its contrast cannot be measured otherwise.',
      low: '{{theme}} {{foreground}} on {{background}} is {{actual}}:1; choose values that reach {{required}}:1 so the pair stays legible (WCAG 1.4.3, 1.4.11).',
    },
  },
  create(context) {
    const { sourceCode } = context
    return {
      StyleSheet(node) {
        const blocks = themeBlocks(sourceCode, node)
        const light = blocks.get(LIGHT)
        const dark = blocks.get(DARK)
        for (const [block, found] of [[LIGHT, light], [DARK, dark]] as const) {
          if (!found) context.report({ loc: node.loc!, messageId: 'missingBlock', data: { block } })
        }
        if (!light || !dark) return
        for (const [theme, own] of [[LIGHT, light], [DARK, dark]] as const) {
          const measured = new Map<string, string | undefined>()
          const hex = (token: string) => {
            if (measured.has(token)) return measured.get(token)
            // Dark redefines only what changes; anything else falls through to light.
            const found = own.tokens.get(token) ?? light.tokens.get(token)
            const value = found && valueOf(sourceCode, found)
            const literal = value && /^#[0-9a-f]{6}$/i.test(value) ? value : undefined
            if (!literal) context.report({ loc: (found ?? own.rule).loc!, messageId: 'unmeasurable', data: { token, theme } })
            measured.set(token, literal)
            return literal
          }
          for (const { ratio, pairs } of context.options[0].checks) {
            for (const [foreground, background] of pairs) {
              const [fg, bg] = [hex(foreground), hex(background)]
              if (!fg || !bg) continue
              const actual = contrast(fg, bg)
              if (actual >= ratio) continue
              context.report({
                loc: (own.tokens.get(foreground) ?? own.tokens.get(background) ?? own.rule).loc!,
                messageId: 'low',
                data: { theme, foreground, background, actual: actual.toFixed(2), required: String(ratio) },
              })
            }
          }
        }
      },
    }
  },
}

const COLOUR = /#[0-9a-f]{3,8}\b|rgba?\(/i

export const darkThemeParity: CSSRuleDefinition<{ RuleOptions: [{ shared: Array<{ name: string; reason: string }> }] }> = {
  meta: {
    type: 'problem',
    docs: { description: 'Require every literal colour token to have a dark value, and the dark block to add none' },
    schema: [{ type: 'object', properties: { shared: reasoned('name') }, additionalProperties: false }],
    defaultOptions: [{ shared: [] }],
    messages: {
      missingBlock: 'Define the `{{block}}` block here, because the dark palette is checked against the light one.',
      noDarkValue: 'Give {{name}} a value in the dark block, or list it as shared with its reason, because a light colour left on the ink page fails silently.',
      darkOnly: 'Define {{name}} in :root as well, because a token only the dark block defines is undefined in the light theme.',
      sharedRedefined: 'Remove {{name}} from the dark block or from the shared list, because the list records it as the same in both themes: {{reason}}.',
    },
  },
  create(context) {
    const shared = new Map(context.options[0].shared.map(entry => [entry.name, entry.reason]))
    return {
      StyleSheet(node) {
        const blocks = themeBlocks(context.sourceCode, node)
        const light = blocks.get(LIGHT)
        const dark = blocks.get(DARK)
        for (const [block, found] of [[LIGHT, light], [DARK, dark]] as const) {
          if (!found) context.report({ loc: node.loc!, messageId: 'missingBlock', data: { block } })
        }
        if (!light || !dark) return
        for (const [name, declaration] of light.tokens) {
          const value = valueOf(context.sourceCode, declaration)
          // A value built out of other tokens follows them; only literals need a second definition.
          if (!COLOUR.test(value.replace(/var\([^)]*\)/g, ''))) continue
          if (!shared.has(name) && !dark.tokens.has(name)) context.report({ node: declaration, messageId: 'noDarkValue', data: { name } })
        }
        for (const [name, declaration] of dark.tokens) {
          if (!light.tokens.has(name)) context.report({ node: declaration, messageId: 'darkOnly', data: { name } })
          const reason = shared.get(name)
          if (reason) context.report({ node: declaration, messageId: 'sharedRedefined', data: { name, reason } })
        }
      },
    }
  },
}

const DEFINITION = /(--[\w-]+)\s*:/g
const definedIn = (text: string) => [...withoutComments(text).matchAll(DEFINITION)].map(match => match[1])

/** Custom properties each stylesheet defines, re-read only when a file changes, so an editor session stays current. */
const definitionsByFile = new Map<string, { mtimeMs: number; names: string[] }>()

function definedAcross(root: string) {
  const names = new Set<string>()
  for (const file of globSync('src/**/*.css', { cwd: root })) {
    const path = resolve(root, file)
    const { mtimeMs } = statSync(path)
    let cached = definitionsByFile.get(path)
    if (cached?.mtimeMs !== mtimeMs) {
      cached = { mtimeMs, names: definedIn(readFileSync(path, 'utf8')) }
      definitionsByFile.set(path, cached)
    }
    for (const name of cached.names) names.add(name)
  }
  return names
}

export const definedCustomProperties: CSSRuleDefinition<{
  RuleOptions: [{ injected: Array<{ name: string; setBy: string; reason: string }> }]
}> = {
  meta: {
    type: 'problem',
    docs: { description: 'Require every var() without a fallback to name a property something defines' },
    schema: [{
      type: 'object',
      properties: {
        injected: {
          type: 'array',
          items: {
            type: 'object',
            properties: { name: { type: 'string' }, setBy: { type: 'string' }, reason: { type: 'string', minLength: 1 } },
            required: ['name', 'setBy', 'reason'],
            additionalProperties: false,
          },
        },
      },
      additionalProperties: false,
    }],
    defaultOptions: [{ injected: [] }],
    messages: {
      undefined: 'Define {{name}} in a stylesheet (design tokens live in src/styles/variables.css), give the var() a fallback, or allowlist where it is set at runtime, because a var() nothing defines drops its declaration silently.',
      notInjected: 'Set {{name}} in {{setBy}} or drop its allowlist entry, because the entry says that file sets it and it does not, so it would hide a missing property.',
    },
  },
  create(context) {
    const text = context.sourceCode.text
    const defined = new Set([...definedAcross(context.cwd), ...definedIn(text)])
    const injected = new Map(context.options[0].injected.map(entry => [entry.name, entry.setBy]))
    const verified = new Map<string, boolean>()
    // A package sets its own properties (Base UI, cmdk); only a path in this repository can be read back.
    const setsIt = (name: string, setBy: string) => !setBy.startsWith('src/')
      || new RegExp(`['"]${name}['"]`).test(readFileSync(resolve(context.cwd, setBy), 'utf8'))
    return {
      StyleSheet() {
        for (const match of withoutComments(text).matchAll(/var\(\s*(--[\w-]+)\s*\)/g)) {
          const name = match[1]
          if (defined.has(name)) continue
          const loc = {
            start: context.sourceCode.getLocFromIndex(match.index),
            end: context.sourceCode.getLocFromIndex(match.index + match[0].length),
          }
          const setBy = injected.get(name)
          if (setBy === undefined) {
            context.report({ loc, messageId: 'undefined', data: { name } })
            continue
          }
          if (!verified.has(name)) verified.set(name, setsIt(name, setBy))
          if (!verified.get(name)) context.report({ loc, messageId: 'notInjected', data: { name, setBy } })
        }
      },
    }
  },
}

export const noRetiredColours: CSSRuleDefinition<{ RuleOptions: [{ retired: Array<{ hex: string; reason: string }> }] }> = {
  meta: {
    type: 'problem',
    docs: { description: 'Disallow colours the palette has retired, as hex or rgb()' },
    schema: [{ type: 'object', properties: { retired: reasoned('hex') }, additionalProperties: false }],
    defaultOptions: [{ retired: [] }],
    messages: {
      retired: 'Replace {{colour}} with a token from src/styles/variables.css, because the colour is retired: {{reason}}.',
    },
  },
  create(context) {
    const patterns = context.options[0].retired.map(({ hex, reason }) => {
      const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16))
      return { reason, pattern: new RegExp(`${hex}\\b|rgba?\\(\\s*${r}\\s*,\\s*${g}\\s*,\\s*${b}\\b`, 'gi') }
    })
    return {
      StyleSheet() {
        const { text } = context.sourceCode
        for (const { reason, pattern } of patterns) {
          for (const match of text.matchAll(pattern)) {
            context.report({
              loc: {
                start: context.sourceCode.getLocFromIndex(match.index),
                end: context.sourceCode.getLocFromIndex(match.index + match[0].length),
              },
              messageId: 'retired',
              data: { colour: match[0], reason },
            })
          }
        }
      },
    }
  },
}

const EXTERNAL = /url\(\s*['"]?(?:[a-z][\w+.-]*:)?\/\/|@import\s+['"](?:[a-z][\w+.-]*:)?\/\//gi

export const noExternalCssUrls: CSSRuleDefinition<{ RuleOptions: [] }> = {
  meta: {
    type: 'problem',
    docs: { description: 'Disallow stylesheets that load from another origin' },
    schema: [],
    messages: {
      external: 'Self-host this asset (an npm package such as @fontsource, or a file under public/), because a URL to another origin makes every page load contact a third party, which the privacy page rules out.',
    },
  },
  create(context) {
    return {
      StyleSheet() {
        for (const match of withoutComments(context.sourceCode.text).matchAll(EXTERNAL)) {
          context.report({
            loc: {
              start: context.sourceCode.getLocFromIndex(match.index),
              end: context.sourceCode.getLocFromIndex(match.index + match[0].length),
            },
            messageId: 'external',
          })
        }
      },
    }
  },
}
