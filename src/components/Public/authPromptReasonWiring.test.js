import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// The reason travels from the control that needs an account to the dialog:
// the card (or the Explorer) → the guest page → App → AuthPrompt. Each hop
// used to drop it (audit 2026-09-23). None of these components mounts under
// Node, so the hops are pinned in their source, comments stripped.
const stripComments = (source) => source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
const read = (path) => stripComments(readFileSync(new URL(path, import.meta.url), 'utf8'));

function bounded(code, from, to, label, maxLines) {
  const start = code.indexOf(from);
  const end = code.indexOf(to, start + 1);
  assert.ok(start >= 0 && end > start, `expected to have found ${label}`);
  const block = code.slice(start, end);
  assert.ok(block.split('\n').length <= maxLines, `${label} capture spans past what it names`);
  return block;
}

test('App keeps the reason it was asked for and hands it to the dialog', () => {
  const app = read('../../App.jsx');
  const request = bounded(app, 'const requestAuthentication = useCallback(', '}, [])', 'requestAuthentication', 8);
  assert.match(request, /\(reason\) => \{\s*clearAuthReturn\(\)\s*setAuthPromptOpen\(true\)\s*setAuthPromptReason\(normalizeAuthReason\(reason\)\)/);
  assert.match(app, /<AuthPrompt\s+reason=\{authPromptReason\}/);
});

test('a guest bounced off a protected route gets the general door, not a stale reason', () => {
  const app = read('../../App.jsx');
  // The bounce opens the door without a reason, so the reason is put back to
  // the general one whenever the door closes.
  assert.match(app, /onClose=\{\(\) => \{\s*setAuthPromptOpen\(false\)\s*setAuthPromptReason\('default'\)\s*\}\}/);
});

test('the guest page forwards the action it was given', () => {
  const page = read('./GuestFeedPage.jsx');
  const requestAccount = bounded(page, 'const requestAccount = useCallback(', '}, [', 'requestAccount', 8);
  assert.match(requestAccount, /onAuthRequired\?\.\(action\);/);
});

test('the dialog reads its headline and lede from the reason', () => {
  const prompt = read('./AuthPrompt.jsx');
  assert.match(prompt, /export default function AuthPrompt\(\{ onClose, reason = 'default' \}\)/);
  assert.match(prompt, /const copy = authPromptCopy\(reason\);/);
  assert.match(prompt, /<DialogTitle className="auth-modal-title">\s*\{copy\.title\}\s*<\/DialogTitle>/);
  assert.match(prompt, /<DialogDescription className="auth-modal-lede">\s*\{copy\.lede\}\s*<\/DialogDescription>/);
});

test('a guest pressing Connections gets the dialog with its reason, not a sheet that cannot load', () => {
  const card = read('../Feed/PaperCard.jsx');
  assert.match(
    card,
    /onClick=\{\(event\) => \{\s*event\.stopPropagation\(\);\s*if \(publicMode\) \{\s*requireAuthentication\('related'\);\s*return;\s*\}\s*setShowRelated\(true\);\s*\}\}\s*aria-label=\{'View related papers'\}/,
  );
});

test('the sheet says "sign in" when the session is what is missing, and says it to assistive tech', () => {
  const sheet = read('../Feed/RelatedPapersSheet.jsx');
  assert.match(sheet, /const SETTLED = new Set\(\['ready', 'empty', 'error', 'signin'\]\);/);
  assert.match(sheet, /\{ status: isSignInRequiredError\(error\) \? 'signin' : 'error' \}/);
  assert.equal((sheet.match(/setRelatedStatus\(isSignInRequiredError\(error\) \? 'signin' : 'error'\);/g) || []).length, 2);
  assert.match(sheet, /\{visibleStatus === 'signin' && \(\s*<div className="related-state" role="status">/);
  assert.match(sheet, /\{visibleStatus === 'error' && \(\s*<div className="related-state" role="status">/);
});
