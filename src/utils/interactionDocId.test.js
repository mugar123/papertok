import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeInteractionDocId, encodeInteractionDocId } from './interactionDocId.js';
import { isFetchableDocumentId } from './listPaperMetadataPlan.js';

test('a legal id encodes to itself, so existing documents keep their names', () => {
  for (const id of ['openalex:W2029887339', '1807.10247', 'arxiv:2301.00001v2', 'pmid:33301246']) {
    assert.equal(encodeInteractionDocId(id), id);
    assert.equal(decodeInteractionDocId(id), id);
  }
});

test('a slash-bearing id becomes a legal document id and round-trips', () => {
  for (const id of ['hep-th/0603001', 'math.GT/0309136v1', 'doi:10.1103/physrevb.42.892', 'a/b/c']) {
    const encoded = encodeInteractionDocId(id);
    assert.ok(isFetchableDocumentId(encoded), `${encoded} must be a legal document id`);
    assert.ok(!encoded.includes('/'));
    assert.equal(decodeInteractionDocId(encoded), id);
  }
});

test('a percent sign in the original id survives the round trip unambiguously', () => {
  const id = 'weird%2Fid/with/percent';
  const encoded = encodeInteractionDocId(id);
  assert.equal(decodeInteractionDocId(encoded), id);
  assert.notEqual(encoded, encodeInteractionDocId('weird/id/with/percent'));
});

test('blank input stays blank', () => {
  assert.equal(encodeInteractionDocId(''), '');
  assert.equal(decodeInteractionDocId(''), '');
});
