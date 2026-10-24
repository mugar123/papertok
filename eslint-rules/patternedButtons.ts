import { relative, sep } from 'node:path'
import type { Rule } from 'eslint'

const filesByName = { type: 'object', additionalProperties: { type: 'array', items: { type: 'string' } } }

/** Patterned Button variants and their class, each allowed only in the listed files (paths from the repository root). */
export const patternedButtons: Rule.RuleModule = {
  meta: {
    type: 'problem',
    docs: { description: 'Restrict the patterned Button variants and their class to the files design.md allows' },
    schema: [{ type: 'object', properties: { variants: filesByName, classes: filesByName }, additionalProperties: false }],
    defaultOptions: [{ variants: {}, classes: {} }],
    messages: {
      patterned: 'Use a plain Button variant instead of `{{pattern}}` here, or allow this file in eslint.config.ts and design.md together, because a pattern on every screen stops drawing the eye (design.md, Rule 5).',
    },
  },
  create(context) {
    const file = relative(context.cwd, context.filename).split(sep).join('/')
    const { variants, classes } = context.options[0] as { variants: Record<string, string[]>; classes: Record<string, string[]> }
    const classPatterns = Object.entries(classes).map(([name, files]) => ({ name, files, pattern: new RegExp(`(?<![\\w-])${name}(?![\\w-])`) }))
    const checkClasses = (node: Rule.Node, text: string) => {
      for (const { name, files, pattern } of classPatterns) {
        if (pattern.test(text) && !files.includes(file)) context.report({ node, messageId: 'patterned', data: { pattern: name } })
      }
    }
    return {
      'JSXAttribute[name.name="variant"] Literal'(node: Rule.Node) {
        if (node.type !== 'Literal' || typeof node.value !== 'string' || !Object.hasOwn(variants, node.value)) return
        if (!variants[node.value].includes(file)) context.report({ node, messageId: 'patterned', data: { pattern: `variant="${node.value}"` } })
      },
      Literal(node) {
        if (typeof node.value === 'string') checkClasses(node, node.value)
      },
      TemplateElement(node) {
        checkClasses(node, node.value.raw)
      },
    }
  },
}
