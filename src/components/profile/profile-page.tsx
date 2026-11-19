import type { Paper } from '../../models/paper.ts';
import type { OrcidConnection } from '../../services/orcid-connection-service.ts';
import type { OrcidPublication, OrcidWork } from '../../services/orcid-service.ts';
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowClockwise, CircleNotch, IdentificationBadge, LinkBreak, LinkSimple } from '@phosphor-icons/react';
import { toast } from 'sonner';
import { useAuth } from '../../context/auth-context.tsx';
import { usePageRestored } from '../../hooks/use-page-restored.ts';
import { connectOrcid, orcidRecordUrl } from '../../services/orcid-connection-service.ts';
import { loadOrcidPublications } from '../../services/orcid-service.ts';
import { getUiErrorMessage } from '../../utils/error-messages.ts';
import { safeDoiUrl } from '../../utils/external-url.ts';
import { getPublicPaperPath } from '../../utils/public-navigation.ts';
import { ListRowAuthors, PaperListRow } from '../lists/list-row.tsx';
import Petri from '../onboarding/petri.tsx';
import ScientificText from '../scientific-text.ts';
import { AlertDialog, AlertDialogContent, AlertDialogDescription, AlertDialogTitle } from '../ui/alert-dialog.tsx';
import { Button } from '../ui/button.tsx';
import { EmptyState } from '../ui/empty-state.tsx';
import { toastError } from '../ui/toast.ts';
import '../settings/settings-page.css';
import './profile-page.css';

const COPY = {
  title: 'My profile',
  subtitle: 'Only you can see this page.',
  orcid: 'ORCID',
  orcidIntro: 'Connecting signs you in to ORCID to confirm your iD, and this page then lists the public works in your ORCID record.',
  orcidConnected: 'Confirmed by signing in to ORCID.',
  orcidId: 'ORCID iD',
  notConnected: 'Not connected',
  connect: 'Connect ORCID',
  disconnect: 'Disconnect',
  disconnectLabel: 'Disconnect ORCID',
  newTab: ' (opens in a new tab)',
  disconnectTitle: 'Disconnect ORCID?',
  disconnectSentence: 'PaperTok forgets your ORCID iD and name, and this page stops listing your publications. PaperTok stays among the trusted organizations in your ORCID account settings until you remove it there.',
  cancel: 'Cancel',
  disconnected: 'ORCID is disconnected.',
  publications: 'Your publications',
  publicationsIntro: 'The public works in your ORCID record.',
  publicationsCount: (count: number) => `${count} public ${count === 1 ? 'work' : 'works'} in your ORCID record. A work OpenAlex knows by its DOI shows its details; the others show what ORCID lists.`,
  loading: 'Loading your publications…',
  loaded: (count: number) => `${count} ${count === 1 ? 'publication' : 'publications'} listed.`,
  failed: 'Your publications could not be loaded from ORCID.',
  detailsFailed: 'Details from OpenAlex could not be loaded, so each work shows only what ORCID lists.',
  retry: 'Try again',
  emptyTitle: 'Your ORCID record lists no public works',
  empty: 'Works you add to your ORCID record and make public are listed here.',
  untitled: 'Untitled work',
};

/** ORCID's work type as words: `journal-article` reads "Journal article". */
function workTypeLabel(type: string | null) {
  if (!type) return null;
  const words = type.replace(/[-_]+/g, ' ').trim().toLowerCase();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : null;
}

/** A work OpenAlex does not describe: only what the ORCID record says, linked to its DOI when it has one. */
function OrcidWorkRow({ work }: { work: OrcidWork }) {
  const doiUrl = work.doi ? safeDoiUrl(work.doi) : '';
  const meta = [workTypeLabel(work.type), work.year ? String(work.year) : null].filter((text): text is string => Boolean(text));
  const title = work.title ? <ScientificText>{work.title}</ScientificText> : COPY.untitled;
  return (
    <div className="list-row orcid-work-row" role="listitem">
      <div className="list-row-content">
        {meta.length > 0 && (
          <div className="list-row-head">
            {meta.map((text, index) => (
              <span key={text} className={index === 0 ? 'list-row-lead' : 'list-row-meta'}>
                {index > 0 && <span aria-hidden="true">·</span>}
                {text}
              </span>
            ))}
          </div>
        )}
        <p className="list-row-title orcid-work-title">
          {doiUrl ? (
            <a href={doiUrl} target="_blank" rel="noopener noreferrer">
              {title}
              <span className="visually-hidden">{COPY.newTab}</span>
            </a>
          ) : title}
        </p>
      </div>
    </div>
  );
}

/**
 * The works of the reader's public ORCID record, read when the page opens and
 * kept only in this component. Mounted with a key per iD, so another record
 * starts from an empty list and a late answer for the previous one is dropped.
 */
function OrcidPublications({ orcid }: { orcid: OrcidConnection }) {
  const navigate = useNavigate();
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [publications, setPublications] = useState<OrcidPublication[]>([]);
  const [details, setDetails] = useState<'complete' | 'failed'>('complete');
  const [attempt, setAttempt] = useState(0);
  const headingRef = useRef<HTMLHeadingElement | null>(null);

  useEffect(() => {
    let live = true;
    loadOrcidPublications(orcid.id, orcid.host).then((result) => {
      if (!live) return;
      setPublications(result.publications);
      setDetails(result.details);
      setStatus('ready');
    }, (error) => {
      if (!live) return;
      console.warn('The ORCID works could not be loaded', error);
      setStatus('error');
    });
    return () => { live = false; };
  }, [orcid.id, orcid.host, attempt]);

  const retry = () => {
    // The button leaves with the message; the heading keeps focus in the section.
    headingRef.current?.focus();
    setStatus('loading');
    setAttempt(value => value + 1);
  };

  const openPaper = (paper: Paper) => {
    const path = getPublicPaperPath(paper);
    if (path) {
      void navigate(path, { state: { paper } });
      return;
    }
    const doiUrl = safeDoiUrl(paper.doi);
    if (doiUrl) window.open(doiUrl, '_blank', 'noopener,noreferrer');
  };

  // Missing OpenAlex details are read out with the count, not left to the visible note alone.
  const announcement = status === 'loading' ? COPY.loading
    : status === 'ready' && publications.length > 0
      ? `${COPY.loaded(publications.length)}${details === 'failed' ? ` ${COPY.detailsFailed}` : ''}`
      : status === 'ready' ? COPY.emptyTitle
        : '';

  return (
    <section className="settings-section" aria-labelledby="my-profile-publications-heading">
      <div className="settings-section-heading">
        <h2 ref={headingRef} id="my-profile-publications-heading" tabIndex={-1}>{COPY.publications}</h2>
        <p>{status === 'ready' && publications.length > 0 ? COPY.publicationsCount(publications.length) : COPY.publicationsIntro}</p>
      </div>

      {/* One status line from loading to the result, so each change is read
          out; it stays visible only while loading. A failure is an alert. */}
      <p className={status === 'loading' ? 'my-profile-note' : 'visually-hidden'} role="status">{announcement}</p>
      {status === 'error' && (
        <div className="my-profile-note">
          <p role="alert">{COPY.failed}</p>
          <Button variant="outline" size="sm" onClick={retry}>
            <ArrowClockwise size={15} aria-hidden="true" />
            {COPY.retry}
          </Button>
        </div>
      )}
      {status === 'ready' && details === 'failed' && publications.length > 0 && (
        <div className="my-profile-note">
          <p>{COPY.detailsFailed}</p>
          <Button variant="outline" size="sm" onClick={retry}>
            <ArrowClockwise size={15} aria-hidden="true" />
            {COPY.retry}
          </Button>
        </div>
      )}
      {status === 'ready' && publications.length === 0 && (
        <EmptyState as="h3" art={<Petri pose="reading" />} title={COPY.emptyTitle}>{COPY.empty}</EmptyState>
      )}

      {status === 'ready' && publications.length > 0 && (
        <div className="settings-list orcid-publications" role="list" aria-labelledby="my-profile-publications-heading">
          {publications.map(({ work, paper }, index) => (paper ? (
            <PaperListRow key={work.putCode ?? `work-${index}`} role="listitem" paper={paper} onOpen={() => openPaper(paper)}>
              {(paper.authors?.length ?? 0) > 0 && <ListRowAuthors paper={paper} />}
            </PaperListRow>
          ) : (
            <OrcidWorkRow key={work.putCode ?? `work-${index}`} work={work} />
          )))}
        </div>
      )}
    </section>
  );
}

function OrcidSection() {
  const { orcid, disconnectOrcid } = useAuth();
  const [connecting, setConnecting] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const actionRef = useRef<HTMLButtonElement | null>(null);

  // Back from ORCID's page, the browser can show this page from its cache with Connect still waiting.
  usePageRestored(() => setConnecting(false));

  const connect = async () => {
    setConnecting(true);
    try {
      await connectOrcid();
    } catch (error) {
      setConnecting(false);
      toastError(getUiErrorMessage(error, 'ORCID_FAILED'));
    }
  };

  const confirmDisconnect = async () => {
    if (disconnecting) return;
    setDisconnecting(true);
    try {
      await disconnectOrcid();
      setConfirmOpen(false);
      toast.success(COPY.disconnected);
    } catch (error) {
      toastError(getUiErrorMessage(error, 'ORCID_FAILED'));
    } finally {
      setDisconnecting(false);
    }
  };

  const recordUrl = orcid ? orcidRecordUrl(orcid) : '';

  return (
    <section className="settings-section" aria-labelledby="my-profile-orcid-heading">
      <div className="settings-section-heading">
        <h2 id="my-profile-orcid-heading">{COPY.orcid}</h2>
        <p>{orcid ? COPY.orcidConnected : COPY.orcidIntro}</p>
      </div>
      <div className="settings-list">
        <div className="settings-row settings-row-side">
          <div className="settings-row-content">
            <h3 className="settings-method-name"><IdentificationBadge size={16} aria-hidden="true" />{COPY.orcidId}</h3>
            {orcid ? (
              <>
                {orcid.name && <p className="orcid-holder">{orcid.name}</p>}
                <p>
                  <a className="orcid-record-link" href={recordUrl} target="_blank" rel="noopener noreferrer">
                    {recordUrl}
                    <span className="visually-hidden">{COPY.newTab}</span>
                  </a>
                </p>
              </>
            ) : (
              <p>{COPY.notConnected}</p>
            )}
          </div>
          {/* One button for both states, so focus stays on it when the state changes. */}
          <Button
            ref={actionRef}
            variant="outline"
            size="sm"
            className="settings-row-action"
            aria-label={orcid ? COPY.disconnectLabel : undefined}
            aria-haspopup={orcid ? 'dialog' : undefined}
            aria-busy={connecting || undefined}
            disabled={connecting}
            focusableWhenDisabled
            onClick={() => { if (orcid) setConfirmOpen(true); else void connect(); }}
          >
            {connecting
              ? <CircleNotch size={15} className="settings-spin" aria-hidden="true" />
              : orcid ? <LinkBreak size={15} aria-hidden="true" /> : <LinkSimple size={15} aria-hidden="true" />}
            {orcid ? COPY.disconnect : COPY.connect}
          </Button>
        </div>
      </div>

      <AlertDialog
        open={confirmOpen}
        onOpenChange={(next) => { if (!next && !disconnecting) setConfirmOpen(false); }}
      >
        <AlertDialogContent className="orcid-disconnect-dialog" aria-busy={disconnecting || undefined} finalFocus={actionRef}>
          <AlertDialogTitle render={<h2 />}>{COPY.disconnectTitle}</AlertDialogTitle>
          <AlertDialogDescription>{COPY.disconnectSentence}</AlertDialogDescription>
          <div className="orcid-disconnect-actions">
            <Button variant="outline" disabled={disconnecting} focusableWhenDisabled onClick={() => { if (!disconnecting) setConfirmOpen(false); }}>
              {COPY.cancel}
            </Button>
            <Button variant="destructive" disabled={disconnecting} focusableWhenDisabled aria-busy={disconnecting || undefined} onClick={() => { void confirmDisconnect(); }}>
              {disconnecting && <CircleNotch size={15} className="settings-spin" aria-hidden="true" />}
              {COPY.disconnect}
            </Button>
          </div>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}

/**
 * The account's own page, which only the account sees: its ORCID connection
 * and the public works of its ORCID record. Nothing here is shown to anyone
 * else. Mounted with `key={uid}` by the route.
 */
export default function ProfilePage() {
  const { orcid } = useAuth();
  return (
    <main className="settings-page my-profile-page">
      <div className="settings-shell my-profile-shell">
        <header className="settings-heading">
          <h1>{COPY.title}</h1>
          <p>{COPY.subtitle}</p>
        </header>
        <OrcidSection />
        {orcid && <OrcidPublications key={`${orcid.host}/${orcid.id}`} orcid={orcid} />}
      </div>
    </main>
  );
}
