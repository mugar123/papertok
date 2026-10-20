import type { LinkedInstitution } from '../../services/institutionService.ts';
type ServicesAnswer = Awaited<ReturnType<typeof findInstitutionServices>>;
type InstitutionPlatform = NonNullable<ServicesAnswer>['services'][number];
import { Collapsible } from '@base-ui/react/collapsible';
import { CaretDownIcon, ArrowUpRightIcon } from '@phosphor-icons/react';
import { groupInstitutionServices } from './institutionServiceGroups.ts';
import { useEffect, useId, useRef, useState } from 'react';
import { findInstitutionServices, knownInstitutionServices } from '../../services/institutionAccessService.ts';
import { Button } from '../ui/button.tsx';
import { publisherLogoFor } from './publisherLogos.ts';
import './Institution.css';

const COPY = {
  kicker: 'Through your library',
  count: (count: number) => `${count} ${count === 1 ? 'source' : 'sources'}`,
  found: (count: number) => `${COPY.count(count)} through your library.`,
  unchecked: (count: number) => `${COPY.count(count)} could not be checked.`,
  loading: 'Checking your library…',
  empty: 'No access found among the publications and platforms checked. Individual articles may still be available.',
  partial: 'PaperTok could only check part of the catalogue. Try again later.',
  unsupported: 'PaperTok cannot check this library yet.',
  error: 'Your library could not be checked.',
  retry: 'Retry',
  newTab: ' (opens in a new tab)',
  coverage: 'Access varies by journal, year and article. Open a source to see the access found; this is not a full subscription list.',
};

/**
 * What the second line says. The library's package is the truth about HOW the
 * platform is reached: a journal that only comes through ProQuest or EBSCO is
 * found under the publisher's platform by the probe, and the Worker says so
 * (`ownPlatform: false`), so the line names the package ("via ProQuest
 * Central") rather than letting the tile claim a subscription to the publisher.
 */
function subtitleFor(service: InstitutionPlatform) {
  if (service.collection && !service.ownPlatform) return `via ${service.collection}`;
  return service.publisher || null;
}

function relativeLuminance(hex: string) {
  const [r, g, b] = [1, 3, 5].map((start) => {
    const channel = parseInt(hex.slice(start, start + 2), 16) / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * Which ink the monogram takes on its brand colour: white or the app's ink,
 * whichever contrasts more (#111318, luminance ≈ 0.0065). The brand colour
 * does not flip with the theme, so neither may the ink on it.
 */
function inkOn(hex: string) {
  const luminance = relativeLuminance(hex);
  return 1.05 / (luminance + 0.05) >= (luminance + 0.05) / 0.0565 ? 'light' : 'dark';
}

function ServiceLogo({ service }: { service: InstitutionPlatform }) {
  const logo = publisherLogoFor(service.platformId || service.id);
  return logo ? (
    <span className="institution-service-plate" aria-hidden="true">
      <img src={logo} alt="" decoding="async" />
    </span>
  ) : (
    <span
      className="institution-service-tile"
      data-ink={service.color ? inkOn(service.color) : undefined}
      style={service.color ? { '--brand': service.color } : undefined}
      aria-hidden="true"
    >
      {service.monogram}
    </span>
  );
}

function ServiceGroup({ group }: { group: ReturnType<typeof groupInstitutionServices>[number] }) {
  const journals = group.services.filter(service => service.platformId).length;
  return (
    <Collapsible.Root className="institution-service-group">
      <Collapsible.Trigger className="institution-service-summary">
        <ServiceLogo service={group.representative} />
        <span className="institution-service-text">
          <span className="institution-service-name">{group.name}</span>
          <span className="institution-service-coverage">{journals ? 'Access found in part of this collection' : 'Access found for a checked sample'}</span>
          <span className="institution-service-count">
            {journals ? `${journals} ${journals === 1 ? 'journal' : 'journals'} found · View details` : 'View access details'}
          </span>
        </span>
        <CaretDownIcon className="institution-service-chevron" size={18} aria-hidden="true" />
      </Collapsible.Trigger>
      <Collapsible.Panel
        className="institution-service-panel"
        render={(props, state) => <div {...props} inert={!state.open} />}
      >
        <div className="institution-service-details">
          <p className="institution-service-detail-note">{'These results cover sampled titles and years. Check access on the article you want to read.'}</p>
          <ul className="institution-service-titles">
            {group.services.map((service, index) => (
              <li key={service.id} style={{ '--title-index': Math.min(index, 6) }}>
                {service.url ? (
                  <a className="institution-service-title-link" href={service.url} target="_blank" rel="noreferrer">
                    <span>
                      <span className="institution-service-title-name">{service.name}</span>
                      <span className="institution-service-route">
                        {!service.platformId && 'Platform or publication sample · '}{subtitleFor(service)}
                      </span>
                    </span>
                    <ArrowUpRightIcon size={16} aria-hidden="true" />
                    <span className="sr-only">{COPY.newTab}</span>
                  </a>
                ) : (
                  <span className="institution-service-title-link">
                    <span><span className="institution-service-title-name">{service.name}</span><span className="institution-service-route">{subtitleFor(service)}</span></span>
                  </span>
                )}
              </li>
            ))}
          </ul>
        </div>
      </Collapsible.Panel>
    </Collapsible.Root>
  );
}

/**
 * The publisher platforms the linked institution's library reaches. The
 * Worker owns the catalogue, the probes and the brand colours; this paints
 * what it answers. A list cut short and a library PaperTok cannot check are
 * said as such, never as a library with nothing.
 */
export default function InstitutionServices({ institution }: { institution: LinkedInstitution }) {
  const { domain, entityId = null, rorId = null } = institution;
  const subject = `${domain}|${entityId}|${rorId}`;
  const kickerId = useId();
  const [attempt, setAttempt] = useState(0);
  // The last answer and what it answered; a stale one is never shown for
  // another institution, and while a retry runs the previous one stays put.
  // A known answer is there from the first render: the dialog this sits in
  // opens with a scale-in, and a list landing a frame later doubled its
  // height mid-animation.
  const [answer, setAnswer] = useState<{ subject: string; attempt: number; value: ServicesAnswer } | null>(() => {
    const known = knownInstitutionServices({ domain, entityId, rorId });
    return known ? { subject, attempt: 0, value: known } : null;
  });
  // A list that answers after a wait opens its own height instead of
  // stretching the window in one frame; a known one is there from the start.
  const [knownAtMount] = useState(answer !== null);

  useEffect(() => {
    let current = true;
    // A retry follows only a failure, which neither cache keeps, so asking
    // again is enough; `attempt` is what re-runs this.
    findInstitutionServices({ domain, entityId, rorId })
      .then((value) => {
        if (current) setAnswer({ subject: `${domain}|${entityId}|${rorId}`, attempt, value });
      });
    return () => { current = false; };
  }, [domain, entityId, rorId, attempt]);

  const own = answer?.subject === subject ? answer : null;
  const loading = !own || own.attempt !== attempt;
  const result = own?.value;
  const failed = own && result === null;
  const services = result?.services || [];
  const groups = groupInstitutionServices(services);

  // The status region stays in the tree in every state, so whatever it says
  // next is announced. A plain success repeats the heading's count, so it is
  // said to screen readers only.
  let status;
  let quiet = false;
  if (loading) status = COPY.loading;
  else if (failed) status = COPY.error;
  else if (result!.unsupported) status = COPY.unsupported;
  else if (result!.partial) status = COPY.partial;
  else if (result!.unchecked > 0) {
    status = [services.length > 0 && COPY.found(groups.length), COPY.unchecked(result!.unchecked)].filter(Boolean).join(' ');
  } else if (services.length === 0) status = COPY.empty;
  else {
    status = COPY.found(groups.length);
    quiet = true;
  }

  // Only a failure offers a retry: a partial answer is cached at the Worker's
  // edge and in the browser too, so pressing again would replay it.
  const canRetry = Boolean(failed);

  // A retry that succeeds takes its own button away, and with it the focus
  // the press had. The heading takes it instead, so a keyboard user lands on
  // the list that answered rather than on the dialog's edge.
  const kickerRef = useRef<HTMLHeadingElement | null>(null);
  const focusAfterRetry = useRef(false);
  useEffect(() => {
    if (loading || !focusAfterRetry.current) return;
    focusAfterRetry.current = false;
    if (!canRetry) kickerRef.current?.focus();
  }, [loading, canRetry]);

  return (
    <section className="institution-services" aria-labelledby={kickerId} aria-busy={loading || undefined}>
      <h3 id={kickerId} ref={kickerRef} tabIndex={-1} className="institution-services-kicker">
        {COPY.kicker}
        {services.length > 0 && <span className="institution-services-count">{COPY.count(groups.length)}</span>}
      </h3>
      <div className="institution-services-status">
        <p className="institution-services-note">{COPY.coverage}</p>
      </div>
      {services.length > 0 && (
        <div className={knownAtMount ? undefined : 'institution-link-reveal'}>
          <ul className="institution-services-list">
            {groups.map((group, index) => (
              <li key={`${subject}:${group.id}`} style={{ '--service-delay': `${Math.min(index, 4) * 45}ms` }}>
                <ServiceGroup group={group} />
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="institution-services-status">
        <p role="status" className={quiet ? 'sr-only' : 'institution-services-note'}>{status}</p>
        {canRetry && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            aria-disabled={loading || undefined}
            onClick={() => {
              if (loading) return;
              focusAfterRetry.current = true;
              setAttempt(value => value + 1);
            }}
          >
            {COPY.retry}
          </Button>
        )}
      </div>
    </section>
  );
}
