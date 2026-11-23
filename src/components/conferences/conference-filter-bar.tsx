import { Button } from '../ui/button.tsx';
import { conferenceEditions, conferenceFields } from '../../data/conferences.ts';
import { conferenceFormats, conferenceMonths, withConferenceParam } from '../../utils/conference-filters.ts';
import type { ConferenceFilters } from '../../utils/conference-filters.ts';
import { formatConferenceMonth } from '../../utils/conference-text.ts';

type FilterSelectProps = {
  name: string;
  label: string;
  any: string;
  value: string | null;
  options: readonly (readonly [string, string])[];
  onChange: (value: string | null) => void;
};

function FilterSelect({ name, label, any, value, options, onChange }: FilterSelectProps) {
  const id = `conference-${name}`;
  return (
    <div className="conference-filter">
      <label htmlFor={id}>{label}</label>
      <select id={id} value={value ?? ''} onChange={event => onChange(event.target.value || null)}>
        <option value="">{any}</option>
        {options.map(([key, text]) => <option key={key} value={key}>{text}</option>)}
      </select>
    </div>
  );
}

type Props = {
  filters: ConferenceFilters;
  params: URLSearchParams;
  onChange: (params: URLSearchParams) => void;
};

export default function ConferenceFilterBar({ filters, params, onChange }: Props) {
  const set = (name: string) => (value: string | null) => onChange(withConferenceParam(params, name, value));
  const months = conferenceMonths(conferenceEditions, filters.month)
    .map(month => [month, formatConferenceMonth(month)] as const);
  return (
    <div className="conference-filters" role="group" aria-label="Filters">
      <FilterSelect name="field" label="Research field" any="All fields" value={filters.field} options={Object.entries(conferenceFields)} onChange={set('field')} />
      <FilterSelect name="month" label="Month" any="Any month" value={filters.month} options={months} onChange={set('month')} />
      <FilterSelect name="format" label="Format" any="Any format" value={filters.format} options={Object.entries(conferenceFormats)} onChange={set('format')} />
    </div>
  );
}

/** Stays in place once pressed, so a keyboard reader's focus does too. */
export function ClearFilters({ filters, params, onChange }: Props) {
  const active = Object.values(filters).some(value => value !== null);
  const clear = () => {
    const next = new URLSearchParams(params);
    for (const name of Object.keys(filters)) next.delete(name);
    onChange(next);
  };
  return <Button variant="ghost" size="sm" disabled={!active} focusableWhenDisabled onClick={clear}>Clear filters</Button>;
}
