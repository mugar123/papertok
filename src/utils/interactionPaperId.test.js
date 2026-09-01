import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyInteractionPaperId } from './interactionPaperId.js';

test('classifies the ids that showed up as Liked titles', () => {
  assert.deepEqual(classifyInteractionPaperId('openalex:W2269592689'), {
    kind: 'openalex',
    value: 'W2269592689',
  });
  assert.deepEqual(classifyInteractionPaperId('1807.10247'), {
    kind: 'arxiv',
    value: '1807.10247',
  });
  assert.deepEqual(classifyInteractionPaperId('hep-th/0603001'), {
    kind: 'arxiv',
    value: 'hep-th/0603001',
  });
  assert.deepEqual(classifyInteractionPaperId('ads:2021JHEP...03..014J'), {
    kind: 'ads',
    value: '2021JHEP...03..014J',
  });
  assert.deepEqual(classifyInteractionPaperId('arxiv:hep-th/0603001'), {
    kind: 'arxiv',
    value: 'hep-th/0603001',
  });
  assert.equal(classifyInteractionPaperId('').kind, 'unknown');
});
