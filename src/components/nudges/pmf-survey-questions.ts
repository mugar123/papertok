import { createElement as h, useId } from 'react';
import { Radio } from '@base-ui/react/radio';
import { RadioGroup } from '@base-ui/react/radio-group';
import type { PmfDisappointment } from '../../utils/pmf-survey.ts';

const COPY = {
  disappointment: 'How would you feel if you could no longer use PaperTok?',
  choices: [
    ['very', 'Very disappointed'],
    ['somewhat', 'Somewhat disappointed'],
    ['not', 'Not disappointed'],
  ] as const satisfies readonly (readonly [PmfDisappointment, string])[],
  recommend: 'How likely are you to recommend PaperTok to a colleague?',
  optional: '(optional)',
  low: 'Not at all likely',
  high: 'Extremely likely',
};

const SCORES = Array.from({ length: 11 }, (_, score) => score);

function isDisappointment(value: unknown): value is PmfDisappointment {
  return COPY.choices.some(([choice]) => choice === value);
}

function isScore(value: unknown): value is number {
  return typeof value === 'number' && SCORES.includes(value);
}

/**
 * The survey's two questions, each a radio group named by its question: how
 * the reader would feel without PaperTok, then how likely they are to
 * recommend it from 0 to 10, which may be left unanswered. Every choice is a
 * native button in a Base UI radio group, as in the feed window's order
 * (custom-feeds/feed-dialog.tsx): Tab reaches each question once and the arrow
 * keys move between its choices. The ends of the scale describe 0 and 10.
 *
 * Written without JSX, on the Base UI parts rather than ui/radio-group.tsx, so
 * its tests can render it under Node. Its styles are in pmf-survey.css.
 */
export default function PmfSurveyQuestions({ disappointment, nps, onDisappointmentChange, onNpsChange }: {
  disappointment: PmfDisappointment | null;
  nps: number | null;
  onDisappointmentChange: (value: PmfDisappointment) => void;
  onNpsChange: (value: number) => void;
}) {
  const id = useId();
  const ids = { disappointment: `${id}-disappointment`, recommend: `${id}-recommend`, low: `${id}-low`, high: `${id}-high` };
  const describedBy = (score: number) => (score === 0 ? ids.low : score === 10 ? ids.high : undefined);

  return h('div', { className: 'pmf-survey-questions' },
    h('div', { className: 'pmf-survey-question' },
      h('p', { id: ids.disappointment, className: 'pmf-survey-question-text' }, COPY.disappointment),
      h(RadioGroup, {
        className: 'pmf-survey-choices',
        'aria-labelledby': ids.disappointment,
        value: disappointment,
        onValueChange: (value: unknown) => { if (isDisappointment(value)) onDisappointmentChange(value); },
      }, COPY.choices.map(([value, label]) => h(Radio.Root, {
        key: value,
        value,
        nativeButton: true,
        render: h('button', { type: 'button', className: 'pmf-survey-choice' }),
      }, label)))),
    h('div', { className: 'pmf-survey-question' },
      h('p', { id: ids.recommend, className: 'pmf-survey-question-text' },
        COPY.recommend, ' ', h('span', { className: 'pmf-survey-optional' }, COPY.optional)),
      h(RadioGroup, {
        className: 'pmf-survey-scale',
        'aria-labelledby': ids.recommend,
        value: nps,
        onValueChange: (value: unknown) => { if (isScore(value)) onNpsChange(value); },
      }, SCORES.map(score => h(Radio.Root, {
        key: score,
        value: score,
        nativeButton: true,
        'aria-describedby': describedBy(score),
        render: h('button', { type: 'button', className: 'pmf-survey-score' }),
      }, String(score)))),
      // The number shows which end each label belongs to when the scale wraps
      // onto two rows; the description of 0 and 10 does not repeat it.
      h('div', { className: 'pmf-survey-scale-ends' },
        h('span', { id: ids.low }, h('span', { 'aria-hidden': true }, '0: '), COPY.low),
        h('span', { id: ids.high }, h('span', { 'aria-hidden': true }, '10: '), COPY.high))));
}
