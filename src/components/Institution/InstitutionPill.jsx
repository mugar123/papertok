import { GraduationCap } from '@phosphor-icons/react';
import { institutionLabel } from '../../services/institutionService.ts';
import './Institution.css';

/**
 * The institution beside a name. The acronym is what shows; the full name is
 * read out, so a screen reader hears "Institution: Universidad de Salamanca"
 * rather than four letters.
 */
export default function InstitutionPill({ institution, className = '' }) {
  if (!institution) return null;
  const label = institutionLabel(institution);
  return (
    <span className={`institution-pill ${className}`.trim()} title={institution.name}>
      <GraduationCap size={12} weight="bold" aria-hidden="true" />
      <span className="sr-only">{'Institution: '}{institution.name}</span>
      <span aria-hidden={label !== institution.name ? 'true' : undefined}>{label}</span>
    </span>
  );
}
