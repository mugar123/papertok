import { describe, it } from 'node:test'
import { join } from 'node:path'
import { RuleTester } from 'eslint'
import { patternedButtons } from './patternedButtons.ts'

RuleTester.describe = describe
RuleTester.it = it
RuleTester.itOnly = it.only

const tester = new RuleTester({ languageOptions: { parserOptions: { ecmaFeatures: { jsx: true } } } })
const options = [{ variants: { engraved: ['src/Landing.jsx'] }, classes: { 'btn-halftone': ['src/Landing.jsx'] } }]
const at = (file: string) => join(process.cwd(), file)

tester.run('patterned-buttons', patternedButtons, {
  valid: [
    { code: '<Button variant="engraved" className="btn-halftone" />', options, filename: at('src/Landing.jsx') },
    { code: '<Button variant="outline" className="btn-halftone-ish" />', options, filename: at('src/Feed.jsx') },
  ],
  invalid: [
    { code: "<Button variant={'engraved'} />", options, filename: at('src/Feed.jsx'), errors: [{ messageId: 'patterned', data: { pattern: 'variant="engraved"' } }] },
    { code: 'const c = `bar ${x ? "btn-halftone" : ""}`', options, filename: at('src/Feed.jsx'), errors: [{ messageId: 'patterned' }] },
    { code: 'const c = `bar btn-halftone`', options, filename: at('src/Feed.jsx'), errors: [{ messageId: 'patterned' }] },
  ],
})
