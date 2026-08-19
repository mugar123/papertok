import { motion, useReducedMotion } from 'framer-motion';
import { Globe2, Lock } from 'lucide-react';
import { PROFILE_VISIBILITY } from '../../services/userProfileService.js';
import { visibilityCopy } from './visibilityCopy.js';
import './VisibilityChoice.css';

/**
 * The choice between a public and a private profile.
 *
 * Neither option is preselected, here or anywhere upstream: `value` starts as
 * null and the caller keeps its submit button disabled until it is not. That
 * is the whole design — a preselected option is a decision made for the user
 * and presented as if they had made it.
 *
 * Rendered in two places, deliberately the same component: the create form
 * (first profile) and the one-time prompt shown to accounts whose profile
 * predates this phase. Both must be the same question.
 */
export default function VisibilityChoice({ value, onChange, isEnglish, idPrefix = 'visibility' }) {
  const prefersReducedMotion = useReducedMotion();
  const copy = visibilityCopy(isEnglish);

  const options = [
    {
      id: PROFILE_VISIBILITY.public,
      Icon: Globe2,
      title: copy.publicTitle,
      body: copy.publicBody,
    },
    {
      id: PROFILE_VISIBILITY.private,
      Icon: Lock,
      title: copy.privateTitle,
      body: copy.privateBody,
    },
  ];

  return (
    <fieldset className="visibility-choice">
      <legend className="visibility-choice-legend">{copy.legend}</legend>

      <div className="visibility-choice-options" role="radiogroup" aria-label={copy.legend}>
        {options.map(({ id, Icon, title, body }, index) => {
          const selected = value === id;
          return (
            <motion.button
              key={id}
              type="button"
              role="radio"
              id={`${idPrefix}-${id}`}
              aria-checked={selected}
              className={`visibility-option${selected ? ' is-selected' : ''}`}
              onClick={() => onChange(id)}
              initial={prefersReducedMotion ? { opacity: 0 } : { opacity: 0, y: 8 }}
              animate={{
                opacity: 1,
                y: 0,
                transition: {
                  delay: prefersReducedMotion ? 0 : index * 0.05,
                  duration: prefersReducedMotion ? 0.08 : 0.24,
                  ease: 'easeOut',
                },
              }}
            >
              <span className="visibility-option-icon" aria-hidden="true"><Icon size={20} /></span>
              <span className="visibility-option-copy">
                <span className="visibility-option-title">{title}</span>
                <span className="visibility-option-body">{body}</span>
              </span>
              <span className="visibility-option-mark" aria-hidden="true" />
            </motion.button>
          );
        })}
      </div>

      {/* Stated up front, not discovered later: the three things a private
          profile does not hide. */}
      <div className="visibility-caveats">
        <p className="visibility-caveats-title">{copy.notProtectedTitle}</p>
        <ul>
          {copy.notProtected.map(item => <li key={item}>{item}</li>)}
        </ul>
      </div>

      <p className="visibility-choice-footnote">{copy.changeLater}</p>
    </fieldset>
  );
}
