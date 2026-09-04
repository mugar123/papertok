import test from 'node:test';
import assert from 'node:assert/strict';
import { formeSeed, planRows, slotFor, planForme, SLOT_KINDS } from './researchForme.js';

function papers(count, overrides = () => ({})) {
  return Array.from({ length: count }, (_, index) => ({
    id: `p${index}`,
    title: `Paper ${index}`,
    ...overrides(index),
  }));
}

/** The sweep the layout has to survive: every plausible edition size against
 *  many seeds, with figures arriving for none, some or all of the papers. */
function sweep(assertion) {
  for (let count = 1; count <= 14; count += 1) {
    for (let seed = 0; seed < 60; seed += 1) {
      for (const share of [0, 0.3, 0.7, 1]) {
        const list = papers(count);
        const withFigure = new Set(
          list.slice(0, Math.round(count * share)).map(paper => paper.id),
        );
        const cells = planForme(list, {
          seed,
          wantsFigure: paper => withFigure.has(paper.id),
          hasFigure: paper => withFigure.has(paper.id),
        });
        assertion(cells, { count, seed, share, list });
      }
    }
  }
}

test('every row closes on the six-column measure', () => {
  sweep((cells, context) => {
    let accumulated = 0;
    for (const cell of cells) {
      if (accumulated === 0) {
        assert.equal(cell.isRowStart, true, `row opens without a start cell ${JSON.stringify(context)}`);
      }
      accumulated += cell.span;
      assert.ok(accumulated <= 6, `row overflowed to ${accumulated} ${JSON.stringify(context)}`);
      if (accumulated === 6) {
        assert.equal(cell.isRowEnd, true, `row closes without an end cell ${JSON.stringify(context)}`);
        accumulated = 0;
      }
    }
    assert.equal(accumulated, 0, `trailing row left at ${accumulated} ${JSON.stringify(context)}`);
  });
});

test('every paper is placed exactly once, in the order it was ranked', () => {
  sweep((cells, { list }) => {
    assert.equal(cells.length, list.length);
    assert.deepEqual(cells.map(cell => cell.paper.id), list.map(paper => paper.id));
  });
});

test('the opener is the lead and only the lead', () => {
  sweep(cells => {
    const openers = cells.filter(cell => cell.kind === 'opener');
    assert.ok(openers.length <= 1);
    if (openers.length === 1) assert.equal(openers[0], cells[0]);
  });
});

test('a slot that shows a plate always says which aspect to crop it to', () => {
  sweep(cells => {
    for (const cell of cells) {
      assert.equal(cell.plate, SLOT_KINDS[cell.kind].plate);
      if (cell.plate) assert.ok(cell.aspect, `plate slot ${cell.kind} has no aspect`);
      else assert.equal(cell.aspect, null);
    }
  });
});

/**
 * The reason the figures do not feed the row planner. A late or empty answer
 * from the worker must never move the grid — only the inside of a cell.
 */
test('resolving a figure changes the cell, never the grid', () => {
  for (let seed = 0; seed < 200; seed += 1) {
    const list = papers(10);
    const wantsFigure = paper => Number(paper.id.slice(1)) % 3 !== 0;

    const pending = planForme(list, { seed, wantsFigure, hasFigure: () => false });
    const settled = planForme(list, { seed, wantsFigure, hasFigure: wantsFigure });

    assert.deepEqual(
      pending.map(cell => [cell.paper.id, cell.span, cell.isRowStart, cell.isRowEnd]),
      settled.map(cell => [cell.paper.id, cell.span, cell.isRowStart, cell.isRowEnd]),
      `grid moved when figures resolved at seed ${seed}`,
    );
  }
});

test('the same edition always composes the same page', () => {
  const list = papers(9);
  const options = { seed: formeSeed(['7d', 'physics', 'hero-1']), hasFigure: () => true, wantsFigure: () => true };
  assert.deepEqual(planForme(list, options), planForme(list, options));
});

test('a different edition composes a different page', () => {
  const list = papers(10);
  const shape = seedParts => planForme(list, {
    seed: formeSeed(seedParts),
    wantsFigure: () => true,
    hasFigure: () => true,
  }).map(cell => `${cell.span}${cell.kind}`).join(' ');

  const editions = new Set([
    shape(['24h', '', 'hero-1']),
    shape(['7d', '', 'hero-1']),
    shape(['30d', '', 'hero-1']),
    shape(['7d', 'physics', 'hero-1']),
    shape(['7d', '', 'hero-2']),
  ]);
  // Five neighbouring editions should not all fall on the same composition.
  assert.ok(editions.size >= 4, `only ${editions.size} distinct compositions`);
});

test('a row does not repeat the previous pattern when it has an alternative', () => {
  for (let seed = 0; seed < 200; seed += 1) {
    const rows = planRows(12, (() => {
      let state = seed;
      return () => {
        state = (state * 1103515245 + 12345) % 2147483648;
        return state / 2147483648;
      };
    })());
    for (let index = 1; index < rows.length; index += 1) {
      // The tail can be forced: with one paper left, [6] is the only fit.
      const forced = rows.slice(index).flat().length <= 1;
      if (!forced) {
        assert.notDeepEqual(rows[index], rows[index - 1], `repeat at row ${index}, seed ${seed}`);
      }
    }
  }
});

/** Groups the flat cell list back into the rows it was laid out in. */
function rowsOf(cells) {
  const rows = [];
  let row = [];
  for (const cell of cells) {
    row.push(cell);
    if (cell.isRowEnd) { rows.push(row); row = []; }
  }
  return rows;
}

test('a text cell sharing a row with a plate fills it rather than leaving a hole', () => {
  sweep(cells => {
    for (const row of rowsOf(cells)) {
      if (!row.some(cell => cell.plate)) continue;
      for (const mate of row.filter(cell => !cell.plate)) {
        assert.ok(mate.dekLines >= 4, `${mate.kind} beside a plate runs only ${mate.dekLines} lines`);
        assert.notEqual(mate.kind, 'brief', 'a brief should give way beside a plate');
      }
    }
  });
});

test('a paper that asked for a plate and did not get one keeps its text, not less of it', () => {
  for (const span of [2, 3, 4, 6]) {
    const lost = slotFor({ span, wantsPlate: true, hasPlate: false, isLead: false, coin: 0.9 });
    assert.notEqual(lost, 'brief', `span ${span} fell to a bare headline`);
    assert.ok(SLOT_KINDS[lost].dek > 0, `span ${span} fell to a slot with no standfirst`);
  }
});

test('an empty selection lays out nothing rather than throwing', () => {
  assert.deepEqual(planForme([], { seed: 1 }), []);
  assert.deepEqual(planForme(null, { seed: 1 }), []);
  assert.deepEqual(planForme([null, undefined], { seed: 1 }), []);
});

test('the seed is stable and spreads adjacent editions apart', () => {
  assert.equal(formeSeed(['7d', 'a']), formeSeed(['7d', 'a']));
  assert.notEqual(formeSeed(['7d', 'a']), formeSeed(['7d', 'b']));
  assert.equal(formeSeed('7d'), formeSeed(['7d']));
  assert.ok(Number.isInteger(formeSeed(['x'])) && formeSeed(['x']) >= 0);
});
