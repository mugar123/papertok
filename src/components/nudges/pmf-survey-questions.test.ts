import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { PmfDisappointment, PmfRole } from '../../utils/pmf-survey.ts';
import PmfSurveyQuestions from './pmf-survey-questions.ts';

function paint(disappointment: PmfDisappointment | null = null, nps: number | null = null, role: PmfRole | null = null) {
  return renderToStaticMarkup(createElement(PmfSurveyQuestions, {
    disappointment,
    nps,
    role,
    onDisappointmentChange: () => {},
    onNpsChange: () => {},
    onRoleChange: () => {},
  }));
}

const attribute = (tag: string, name: string) => new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1];

/** The text of the element with `id`, without what is hidden from assistive technology. */
function textOf(markup: string, id: string) {
  const start = markup.indexOf(`id="${id}"`);
  assert.ok(start >= 0, `an element has id ${id}`);
  const tag = /^<(\w+)/.exec(markup.slice(markup.lastIndexOf('<', start)))?.[1] ?? '';
  // The element's content, up to the close tag that matches its own open tag.
  const tags = new RegExp(`<(/?)${tag}[\\s>]`, 'g');
  tags.lastIndex = markup.indexOf('>', start);
  let depth = 1;
  let end = markup.length;
  for (let found = tags.exec(markup); found; found = tags.exec(markup)) {
    depth += found[1] ? -1 : 1;
    if (depth === 0) {
      end = found.index;
      break;
    }
  }
  return markup.slice(markup.indexOf('>', start) + 1, end)
    .replace(/<span aria-hidden="true">[^<]*<\/span>/g, '')
    .replace(/<[^>]+>/g, '')
    .trim();
}

function radioGroups(markup: string) {
  return [...markup.matchAll(/<div role="radiogroup"[^>]*>/g)].map(([tag]) => tag);
}

function radios(markup: string) {
  return [...markup.matchAll(/(<button[^>]*role="radio"[^>]*>)([^<]*)<\/button>/g)]
    .map(([, tag, label]) => ({ tag, label }));
}

test('each question is a radio group named by the question it asks', () => {
  const markup = paint();
  const groups = radioGroups(markup);
  assert.equal(groups.length, 3);
  assert.deepEqual(groups.map(tag => textOf(markup, attribute(tag, 'aria-labelledby') ?? '')), [
    'How would you feel if you could no longer use PaperTok?',
    'How likely are you to recommend PaperTok to a colleague? (optional)',
    'Which best describes you? (optional)',
  ]);
});

test('every choice is a native button named by its label, so Enter and Space choose it', () => {
  const choices = radios(paint());
  assert.deepEqual(choices.map(({ label }) => label), [
    'Very disappointed',
    'Somewhat disappointed',
    'Not disappointed',
    '0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '10',
    'Undergraduate student',
    'Graduate student',
    'Researcher or faculty',
    'Industry professional',
    'Other',
  ]);
  for (const { tag, label } of choices) assert.equal(attribute(tag, 'type'), 'button', label);
});

test('the ends of the scale say what 0 and 10 mean, and no other score is described', () => {
  const markup = paint();
  const described = radios(markup)
    .filter(({ tag }) => attribute(tag, 'aria-describedby'))
    .map(({ tag, label }) => [label, textOf(markup, attribute(tag, 'aria-describedby') ?? '')]);
  assert.deepEqual(described, [['0', 'Not at all likely'], ['10', 'Extremely likely']]);
});

test('the chosen answers are the checked radios, and nothing is checked before the reader chooses', () => {
  const checked = (markup: string) => radios(markup)
    .filter(({ tag }) => attribute(tag, 'aria-checked') === 'true')
    .map(({ label }) => label);
  assert.deepEqual(checked(paint()), []);
  assert.deepEqual(checked(paint('somewhat', 7)), ['Somewhat disappointed', '7']);
  assert.deepEqual(checked(paint('very', null)), ['Very disappointed'], 'the score and the role may stay unanswered');
  assert.deepEqual(checked(paint('not', null, 'graduate')), ['Not disappointed', 'Graduate student']);
});

test('the role question comes last, its group holding the five roles and only those', () => {
  const markup = paint();
  const roleGroup = radioGroups(markup)[2] ?? '';
  const start = markup.indexOf(roleGroup);
  const roles = radios(markup.slice(start, markup.indexOf('</div>', start)));
  assert.equal(textOf(markup, attribute(roleGroup, 'aria-labelledby') ?? ''), 'Which best describes you? (optional)');
  assert.deepEqual(roles.map(({ label }) => label), [
    'Undergraduate student',
    'Graduate student',
    'Researcher or faculty',
    'Industry professional',
    'Other',
  ]);
});
