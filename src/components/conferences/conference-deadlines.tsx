import type { ConferenceDeadline } from '../../data/conferences.ts';
import { deadlineSources, deadlineToday, formatDeadline } from '../../utils/conference-text.ts';

function DeadlineList({ deadlines }: { deadlines: readonly ConferenceDeadline[] }) {
  return (
    <dl className="conference-facts">
      {deadlines.map(deadline => (
        <div key={deadline.label + deadline.date}><dt>{deadline.label}</dt><dd><time dateTime={deadline.date}>{formatDeadline(deadline)}</time></dd></div>
      ))}
    </dl>
  );
}

export default function ConferenceDeadlines({ deadlines }: { deadlines: readonly ConferenceDeadline[] }) {
  const today = deadlineToday(new Date());
  const open = deadlines.filter(deadline => deadline.date >= today);
  const passed = deadlines.filter(deadline => deadline.date < today);
  return (
    <>
      <h3>Key deadlines</h3>
      {open.length > 0 && <DeadlineList deadlines={open} />}
      {passed.length > 0 && (
        <details className="conference-passed">
          <summary>{passed.length === 1 ? '1 passed deadline' : `${passed.length} passed deadlines`}</summary>
          <DeadlineList deadlines={passed} />
        </details>
      )}
      <p className="conference-source">
        Deadlines from {deadlineSources(deadlines).map(({ url, name }, index) => <span key={url}>{index > 0 && ', '}<a href={url}>{name}</a></span>)}. Confirm them with the organizer.
      </p>
    </>
  );
}
