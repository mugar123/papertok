import { useRef, useState } from 'react';
import { Button } from '../ui/button.tsx';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '../ui/dialog.tsx';
import type { PmfDisappointment, PmfSurveyAnswer } from '../../utils/pmf-survey.ts';
import PmfSurveyQuestions from './pmf-survey-questions.ts';
import './pmf-survey.css';

const COPY = {
  title: 'Two quick questions',
  description: 'Your answers help decide what PaperTok does next.',
  send: 'Send',
  later: 'Not now',
  close: 'Close',
};

/**
 * The product-market fit survey, in a modal dialog over the feed (NudgeHost
 * decides when, and records the version as asked once it is open). Send hands
 * over the answers once the first question has one. Not now, Escape, the close
 * button and a press outside hand over a dismissal.
 *
 * Focus starts on the title, as in the privacy notice, so a screen reader
 * starts at the title and Tab then reaches the first question.
 */
export default function PmfSurvey({ open, onAnswer }: { open: boolean; onAnswer: (answer: PmfSurveyAnswer) => void }) {
  const titleRef = useRef<HTMLHeadingElement | null>(null);
  const [disappointment, setDisappointment] = useState<PmfDisappointment | null>(null);
  const [nps, setNps] = useState<number | null>(null);
  // Once handed over, the dialog is closing: a second press while it leaves sends nothing.
  const answer = (value: PmfSurveyAnswer) => { if (open) onAnswer(value); };

  return (
    <Dialog open={open} onOpenChange={nextOpen => { if (!nextOpen) answer('dismissed'); }}>
      <DialogContent className="pmf-survey" closeLabel={COPY.close} initialFocus={titleRef}>
        <DialogTitle ref={titleRef} tabIndex={-1} className="pmf-survey-title">{COPY.title}</DialogTitle>
        <DialogDescription className="pmf-survey-description">{COPY.description}</DialogDescription>
        <PmfSurveyQuestions
          disappointment={disappointment}
          nps={nps}
          onDisappointmentChange={setDisappointment}
          onNpsChange={setNps}
        />
        <div className="pmf-survey-actions">
          <Button
            size="sm"
            disabled={!disappointment}
            focusableWhenDisabled
            onClick={() => { if (disappointment) answer({ disappointment, nps }); }}
          >
            {COPY.send}
          </Button>
          <Button size="sm" variant="outline" onClick={() => answer('dismissed')}>{COPY.later}</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
