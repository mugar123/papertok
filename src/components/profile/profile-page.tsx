import type { ReactNode } from 'react';
import type { Paper } from '../../models/paper.ts';
import type { OrcidConnection } from '../../services/orcid-connection-service.ts';
import type { Coauthor, OrcidCandidate, OrcidListedWork, OrcidPublicationsLoad, OrcidWork } from '../../services/orcid-service.ts';
import type { OrcidWorkDecision, OrcidWorkDecisions } from '../../services/orcid-work-decisions-service.ts';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowClockwise, ArrowCounterClockwise, CaretDown, Check, CircleNotch, IdentificationBadge, LinkBreak, LinkSimple, X } from '@phosphor-icons/react';
import { toast } from 'sonner';
import { useAuth } from '../../context/auth-context.tsx';
import { useFollowing } from '../../context/following-context.tsx';
import { usePageRestored } from '../../hooks/use-page-restored.ts';
import { connectOrcid, orcidRecordUrl } from '../../services/orcid-connection-service.ts';
import { CITING_WORKS_PAGE_SIZE, getWorksCiting, twelveMonthsBefore } from '../../services/open-alex-service.ts';
import { arrangeOrcidWorks, citedWorkIds, citedWorksState, frequentCoauthors, loadOrcidPublications, orcidWorkKeys, othersCitations, readerPapers, readerWorkIds } from '../../services/orcid-service.ts';
import { readOrcidWorkDecisions, saveOrcidWorkDecision } from '../../services/orcid-work-decisions-service.ts';
import { keepFeedSeeds } from '../../services/orcid-feed-seeds-service.ts';
import { readFeedSeeds, type FeedSeeds } from '../../services/orcid-feed-seeds-store.ts';
import { feedSeedsStale } from '../../utils/publication-seeds.ts';
import { getUiErrorMessage } from '../../utils/error-messages.ts';
import { safeDoiUrl } from '../../utils/external-url.ts';
import { getPublicPaperPath } from '../../utils/public-navigation.ts';
import { ListRowAuthors, PaperListRow } from '../lists/list-row.tsx';
import Petri from '../onboarding/petri.tsx';
import ScientificText from '../scientific-text.ts';
import { AlertDialog, AlertDialogContent, AlertDialogDescription, AlertDialogTitle } from '../ui/alert-dialog.tsx';
import { Button } from '../ui/button.tsx';
import { EmptyState } from '../ui/empty-state.tsx';
import { FollowToggle } from '../ui/follow-toggle.tsx';
import { actionStart, toastError } from '../ui/toast.ts';
import { toastFollowRefused } from '../following/follow-refused-toast.ts';
import '../settings/settings-page.css';
import PublicationAreas from './publication-areas.tsx';
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
  disconnectSentence: 'PaperTok forgets your ORCID iD, your name and which suggested works you marked as yours or not, and this page stops listing your publications. PaperTok stays among the trusted organizations in your ORCID account settings until you remove it there.',
  cancel: 'Cancel',
  disconnected: 'ORCID is disconnected.',
  publications: 'Your publications',
  publicationsIntro: 'The public works in your ORCID record.',
  publicationsCount: (record: number, added: number) => `${record} public ${record === 1 ? 'work' : 'works'} in your ORCID record${added > 0 ? `, and ${added} you added` : ''}. A work OpenAlex knows shows its details; the others show what ORCID lists.`,
  recordCapped: (total: number, listed: number) => `Your ORCID record has ${total} public works; this page lists the newest ${listed}.`,
  loading: 'Loading your publications…',
  loaded: (count: number) => `${count} ${count === 1 ? 'publication' : 'publications'} listed.`,
  suggestionsLoaded: (count: number) => `${count} more ${count === 1 ? 'work' : 'works'} might be yours.`,
  failed: 'Your publications could not be loaded from ORCID.',
  detailsFailed: 'Details from OpenAlex could not be loaded for every work, so some show only what ORCID lists, or only their identifier.',
  retry: 'Try again',
  emptyTitle: 'Your ORCID record lists no public works',
  empty: 'Works you add to your ORCID record and make public are listed here.',
  untitled: 'Untitled work',
  addedByYou: 'Added by you',
  remove: 'Remove',
  removeLabel: (title: string) => `Remove from your publications: ${title}`,
  suggestions: 'Might also be yours',
  suggestionsIntro: 'OpenAlex links these works to your ORCID iD; some may belong to someone else. A work you mark as yours joins your publications on this page; your ORCID record does not change.',
  suggestionsFailed: 'The works OpenAlex links to your ORCID iD could not be loaded.',
  suggestionsPartial: 'OpenAlex stopped answering before it had listed every work linked to your iD, so some may be missing here.',
  suggestionsCapped: (total: number, checked: number) => `OpenAlex links ${total} works to your iD; only the newest ${checked} were checked.`,
  noSuggestions: 'OpenAlex links no other works to your ORCID iD.',
  noneLeft: 'You have sorted every suggestion.',
  mine: 'This is mine',
  mineLabel: (title: string) => `This is mine: ${title}`,
  notMine: 'Not mine',
  notMineLabel: (title: string) => `Not mine: ${title}`,
  addedRow: 'Added to your publications:',
  hiddenRow: 'Marked as not yours:',
  undo: 'Undo',
  undoLabel: (title: string) => `Undo: ${title}`,
  hiddenToggle: (count: number) => `Marked as not yours (${count})`,
  showAgain: 'Show again',
  showAgainLabel: (title: string) => `Show again: ${title}`,
  saveFailed: 'Your choice could not be saved. Try again.',
  // Each names the work, so two decisions in a row are both read out.
  announceMine: (title: string) => `Added "${title}" to your publications.`,
  announceNotMine: (title: string) => `Marked "${title}" as not yours. It no longer appears among the suggestions.`,
  announceBack: (title: string) => `"${title}" is back among the suggestions.`,
  announceRemoved: (title: string) => `Removed "${title}" from your publications.`,
  citations: 'Papers citing your work',
  citationsIntro: 'Papers from the last 12 months that cite your publications, newest first, as OpenAlex lists them. Papers OpenAlex lists with your ORCID iD among the authors, and the publications listed here, are left out.',
  citationsLoading: 'Loading papers citing your work…',
  citationsLoaded: (count: number) => `${count} ${count === 1 ? 'paper cites' : 'papers cite'} your work.`,
  citationsFailed: 'The papers citing your work could not be loaded from OpenAlex.',
  citationsNone: 'OpenAlex lists no papers from the last 12 months that cite these works.',
  citationsOnlyOwn: 'OpenAlex lists no papers by others from the last 12 months that cite these works.',
  citationsAllOwnCapped: (total: number) => `The newest ${CITING_WORKS_PAGE_SIZE} of the ${total} papers OpenAlex lists from the last 12 months that cite these works are all your own.`,
  citationsCapped: (total: number) => `These come from the newest ${CITING_WORKS_PAGE_SIZE} of the ${total} papers OpenAlex lists from the last 12 months that cite these works.`,
  citationsUnknown: 'Papers citing your work appear here for works OpenAlex knows, and OpenAlex knows none of your publications yet.',
  citationsDetailsFailed: 'Papers citing your work could not be looked up, because the details of your publications did not load from OpenAlex.',
  citationsNextVisit: 'Papers citing your work will be listed the next time you open this page.',
  cites: 'Cites',
  citesMore: (count: number) => ` and ${count} more of your works`,
  coauthors: 'Frequent coauthors',
  coauthorsIntro: 'The people who share two or more of your publications on OpenAlex, most shared first. Papers with more than 30 authors are not counted.',
  sharedWorks: (count: number) => `${count} shared works`,
  follow: (name: string) => `Follow ${name}`,
  following: (name: string) => `Following ${name}`,
};

/** ORCID's work type as words: `journal-article` reads "Journal article". */
function workTypeLabel(type: string | null) {
  if (!type) return null;
  const words = type.replace(/[-_]+/g, ' ').trim().toLowerCase();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : null;
}

/** The decisions once `decision` is made about the work named `keys`, as orcidWorkDecisionWrite stores it. */
function withDecision(decisions: OrcidWorkDecisions, keys: string[], decision: OrcidWorkDecision | null) {
  const mine = decisions.mine.filter(key => !keys.includes(key));
  const notMine = decisions.notMine.filter(key => !keys.includes(key));
  if (decision === 'mine') mine.push(keys[0]);
  if (decision === 'notMine') notMine.push(keys[0]);
  return { mine, notMine };
}

/** Every name of a work the reader added: the one its decision is kept under, then its paper's. */
function addedKeys(item: Extract<OrcidListedWork, { kind: 'added' }>) {
  return [...new Set([item.key, ...(item.paper ? orcidWorkKeys(item.paper) : [])])];
}

function MetaLine({ items }: { items: Array<string | null> }) {
  const shown = items.filter((text): text is string => Boolean(text));
  if (shown.length === 0) return null;
  return (
    <div className="list-row-head">
      {shown.map((text, index) => (
        <span key={text} className={index === 0 ? 'list-row-lead' : 'list-row-meta'}>
          {index > 0 && <span aria-hidden="true">·</span>}
          {text}
        </span>
      ))}
    </div>
  );
}

/** A work OpenAlex does not describe: only what the ORCID record says, linked to its DOI when it has one. */
function OrcidWorkRow({ work }: { work: OrcidWork }) {
  const doiUrl = work.doi ? safeDoiUrl(work.doi) : '';
  const title = work.title ? <ScientificText>{work.title}</ScientificText> : COPY.untitled;
  return (
    <div className="list-row orcid-work-row" role="listitem">
      <div className="list-row-content">
        <MetaLine items={[workTypeLabel(work.type), work.year ? String(work.year) : null]} />
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

/** A work the reader added whose details OpenAlex did not give: its identifier, linked. */
function AddedWorkRow({ itemKey, actions }: { itemKey: string; actions: ReactNode }) {
  const isDoi = itemKey.startsWith('doi:');
  const identifier = itemKey.slice(itemKey.indexOf(':') + 1);
  const url = isDoi ? safeDoiUrl(identifier) : `https://openalex.org/${identifier}`;
  return (
    <div className="list-row orcid-work-row" role="listitem">
      <div className="list-row-content">
        <MetaLine items={[COPY.addedByYou]} />
        <p className="list-row-title orcid-work-title orcid-work-identifier">
          {url ? (
            <a href={url} target="_blank" rel="noopener noreferrer">
              {isDoi ? `doi:${identifier}` : identifier}
              <span className="visually-hidden">{COPY.newTab}</span>
            </a>
          ) : identifier}
        </p>
        {actions}
      </div>
    </div>
  );
}

/** Opens a paper of a list row: its paper page, or its DOI in a new tab. */
function useOpenPaper() {
  const navigate = useNavigate();
  return (paper: Paper) => {
    const path = getPublicPaperPath(paper);
    if (path) {
      void navigate(path, { state: { paper } });
      return;
    }
    const doiUrl = safeDoiUrl(paper.doi);
    if (doiUrl) window.open(doiUrl, '_blank', 'noopener,noreferrer');
  };
}

type CitationsState =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'ready'; citations: ReturnType<typeof othersCitations>; total: number; titles: ReadonlyMap<string, string> };

/**
 * The newest papers of the last 12 months that cite the reader's works
 * (`papers`, readerPapers), from one OpenAlex request when the section
 * mounts and one more for each Try again: a decision made meanwhile does not
 * ask again. Mounted once the publications are loaded, and gone while they
 * load again; a late answer after it left is dropped. `lookupFailed` says the
 * details of some publications did not load, so their OpenAlex ids are missing.
 */
function CitingPapers({ orcidId, papers, lookupFailed }: { orcidId: string; papers: Paper[]; lookupFailed: boolean }) {
  const openPaper = useOpenPaper();
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<CitationsState>({ status: 'loading' });
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  // The works as they stand when a request is made, not as each decision changes them.
  const latestPapers = useRef(papers);
  useEffect(() => { latestPapers.current = papers; }, [papers]);
  // Whether the section asks: decided at mount, and ended by a retry that finds no work left to ask about.
  const [requested, setRequested] = useState(() => citedWorkIds(papers).length > 0);
  const cited = citedWorksState(papers, lookupFailed);

  useEffect(() => {
    const current = latestPapers.current;
    const ids = citedWorkIds(current);
    if (ids.length === 0) return undefined;
    let live = true;
    const readerIds = readerWorkIds(current);
    const titles = new Map(current.map(paper => [String(paper.id), paper.title ?? COPY.untitled]));
    getWorksCiting(ids, twelveMonthsBefore(new Date())).then((result) => {
      if (!live) return;
      setState({ status: 'ready', citations: othersCitations(result.works, orcidId, readerIds), total: result.total, titles });
    }, (error: unknown) => {
      if (!live) return;
      console.warn('The papers citing the ORCID works could not be loaded', error);
      setState({ status: 'error' });
    });
    return () => { live = false; };
  }, [orcidId, attempt]);

  const retry = () => {
    // The button leaves with the message; the heading keeps focus in the section.
    headingRef.current?.focus();
    // The reader may have removed their last work since the failure; with none
    // left there is nothing to ask for, and the section says why instead.
    if (citedWorkIds(latestPapers.current).length === 0) {
      setRequested(false);
      return;
    }
    setState({ status: 'loading' });
    setAttempt(value => value + 1);
  };

  const shown = state.status === 'ready' ? state.citations : [];
  const total = state.status === 'ready' ? state.total : 0;
  const capped = total > CITING_WORKS_PAGE_SIZE;
  const emptyNote = total === 0 ? COPY.citationsNone : capped ? COPY.citationsAllOwnCapped(total) : COPY.citationsOnlyOwn;
  const announcement = state.status === 'loading' ? COPY.citationsLoading
    : state.status === 'ready' ? (shown.length > 0 ? COPY.citationsLoaded(shown.length) : emptyNote) : '';

  return (
    <section className="settings-section" aria-labelledby="my-profile-citations-heading">
      <div className="settings-section-heading">
        <h2 ref={headingRef} id="my-profile-citations-heading" tabIndex={-1}>{COPY.citations}</h2>
        <p>{COPY.citationsIntro}</p>
      </div>
      {requested ? (
        <>
          {/* As the publications do: one status line from loading to the
              result, visible while loading and when nothing is listed. A
              failure is an alert. */}
          <p className={state.status === 'loading' || (state.status === 'ready' && shown.length === 0) ? 'my-profile-note' : 'visually-hidden'} role="status">{announcement}</p>
          {state.status === 'error' && (
            <div className="my-profile-note">
              <p role="alert">{COPY.citationsFailed}</p>
              <Button variant="outline" size="sm" onClick={retry}>
                <ArrowClockwise size={15} aria-hidden="true" />
                {COPY.retry}
              </Button>
            </div>
          )}
          {state.status === 'ready' && shown.length > 0 && capped && <p className="my-profile-note">{COPY.citationsCapped(total)}</p>}
          {state.status === 'ready' && shown.length > 0 && (
            <div className="settings-list orcid-works" role="list" aria-labelledby="my-profile-citations-heading">
              {shown.map(({ paper, cites }) => {
                const first = cites.length > 0 ? state.titles.get(cites[0]) : undefined;
                return (
                  <PaperListRow key={paper.id} role="listitem" paper={paper} onOpen={() => openPaper(paper)}>
                    {(paper.authors?.length ?? 0) > 0 && <ListRowAuthors paper={paper} />}
                    {first && (
                      <p className="orcid-cites-line">
                        {COPY.cites}
                        {' '}
                        <ScientificText>{first}</ScientificText>
                        {cites.length > 1 && COPY.citesMore(cites.length - 1)}
                      </p>
                    )}
                  </PaperListRow>
                );
              })}
            </div>
          )}
        </>
      ) : (
        <p className="my-profile-note" role="status">
          {cited === 'known' ? COPY.citationsNextVisit : cited === 'failed' ? COPY.citationsDetailsFailed : COPY.citationsUnknown}
        </p>
      )}
    </section>
  );
}

/** The reader's frequent coauthors (frequentCoauthors), each with the app's Follow. */
function FrequentCoauthors({ coauthors }: { coauthors: Coauthor[] }) {
  const { isFollowing, isFollowPending, toggleFollow } = useFollowing();
  const entityOf = (coauthor: Coauthor) => ({ type: 'author' as const, id: coauthor.id, displayName: coauthor.name, source: 'openalex' });
  const follow = (coauthor: Coauthor) => {
    const entity = entityOf(coauthor);
    const following = isFollowing(entity);
    // Said in a toast that waits for any overlay opened before the write settles, as the Explorer's Follow does.
    const startedAt = actionStart();
    toggleFollow(entity).catch((error: unknown) => toastFollowRefused(error, { name: coauthor.name, following, startedAt }));
  };
  return (
    <section className="settings-section" aria-labelledby="my-profile-coauthors-heading">
      <div className="settings-section-heading">
        <h2 id="my-profile-coauthors-heading">{COPY.coauthors}</h2>
        <p>{COPY.coauthorsIntro}</p>
      </div>
      <div className="settings-list" role="list" aria-labelledby="my-profile-coauthors-heading">
        {coauthors.map((coauthor) => {
          const entity = entityOf(coauthor);
          return (
            <div key={coauthor.id} className="settings-row settings-row-side" role="listitem">
              <div className="settings-row-content">
                <p className="orcid-coauthor-name">{coauthor.name}</p>
                <p className="orcid-coauthor-count">{COPY.sharedWorks(coauthor.sharedWorks)}</p>
              </div>
              <FollowToggle
                pressed={isFollowing(entity)}
                pending={isFollowPending(entity)}
                onClick={() => follow(coauthor)}
                followLabel={COPY.follow(coauthor.name)}
                followingLabel={COPY.following(coauthor.name)}
              />
            </div>
          );
        })}
      </div>
    </section>
  );
}

/**
 * The reader's publications and the works that might also be theirs, read
 * when the page opens and kept only in this component: the works of their
 * public ORCID record, the works OpenAlex attributes to the iD, and the
 * reader's decisions about those. Mounted with a key per connection, so
 * another record, or the same iD connected again, starts empty and a late
 * answer for the previous one is dropped.
 */
// How long the list stands before its works are kept for For you, so a run of decisions writes once.
const FEED_SEEDS_SAVE_DELAY_MS = 1500;

function OrcidPublications({ orcid, uid }: { orcid: OrcidConnection; uid: string }) {
  const openPaper = useOpenPaper();
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [loaded, setLoaded] = useState<OrcidPublicationsLoad | null>(null);
  const [decisions, setDecisions] = useState<OrcidWorkDecisions>({ mine: [], notMine: [] });
  // Works decided during this visit stay where they were, with an Undo.
  const [recent, setRecent] = useState<ReadonlyMap<string, OrcidWorkDecision>>(new Map());
  const [saving, setSaving] = useState<ReadonlySet<string>>(new Set());
  const [hiddenOpen, setHiddenOpen] = useState(false);
  const [decisionNote, setDecisionNote] = useState('');
  const [attempt, setAttempt] = useState(0);
  // What the account keeps of these works for For you (ENG-251): undefined
  // while it is read, null when the read failed or found nothing kept.
  const [keptSeeds, setKeptSeeds] = useState<FeedSeeds | null | undefined>(undefined);
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  const suggestionsHeadingRef = useRef<HTMLHeadingElement | null>(null);
  const hiddenToggleRef = useRef<HTMLButtonElement | null>(null);
  const controls = useRef(new Map<string, HTMLButtonElement>());
  // Where focus goes once the render a decision causes is on screen.
  const pendingFocus = useRef<string | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  useEffect(() => {
    let live = true;
    // Read beside the works, and needed only to decide whether to write: the list never waits for it.
    readFeedSeeds(uid, orcid.connectedAt).then((kept) => {
      if (live) setKeptSeeds(kept);
    }, (error: unknown) => {
      console.warn('The publications For you ranks by could not be read', error);
      if (live) setKeptSeeds(null);
    });
    loadOrcidPublications(orcid.id, orcid.host, readOrcidWorkDecisions(uid, orcid.connectedAt)).then((result) => {
      if (!live) return;
      setLoaded(result);
      setDecisions(result.decisions);
      setRecent(new Map());
      setStatus('ready');
    }, (error) => {
      if (!live) return;
      console.warn('The ORCID works could not be loaded', error);
      setStatus('error');
    });
    return () => { live = false; };
  }, [orcid.id, orcid.host, orcid.connectedAt, uid, attempt]);

  // A decision replaces the control that made it; focus moves to the one that takes its place.
  useEffect(() => {
    const target = pendingFocus.current;
    if (!target) return;
    pendingFocus.current = null;
    if (target === 'heading') headingRef.current?.focus();
    // The toggle leaves with the last work it hid.
    else if (target === 'hidden-toggle') (hiddenToggleRef.current ?? suggestionsHeadingRef.current)?.focus();
    else controls.current.get(target)?.focus();
  });

  const registerControl = (name: string) => (node: HTMLButtonElement | null) => {
    if (node) controls.current.set(name, node);
    else controls.current.delete(name);
  };

  const retry = () => {
    // The button leaves with the message; the heading keeps focus in the section.
    headingRef.current?.focus();
    setStatus('loading');
    setAttempt(value => value + 1);
  };

  const markRecent = (key: string, row: OrcidWorkDecision | null | undefined) => setRecent((current) => {
    const next = new Map(current);
    if (row) next.set(key, row);
    else next.delete(key);
    return next;
  });

  /**
   * Shows a decision at once and takes it back if it cannot be saved. `keys`
   * names the work (its decision is kept under the first); `undoRow` keeps it
   * in place among the suggestions with an Undo, or takes it out of the place
   * it was decided in. Focus goes to `focus`, or back to `origin` on failure.
   */
  const decide = async (keys: string[], decision: OrcidWorkDecision | null, { undoRow, focus, origin, note }: { undoRow: OrcidWorkDecision | null; focus: string; origin: string; note: string }) => {
    const key = keys[0];
    if (saving.has(key)) return;
    const previous = keys.some(name => decisions.mine.includes(name)) ? 'mine'
      : keys.some(name => decisions.notMine.includes(name)) ? 'notMine' : null;
    const previousRow = recent.get(key);
    setDecisions(current => withDecision(current, keys, decision));
    markRecent(key, undoRow);
    setSaving(current => new Set(current).add(key));
    pendingFocus.current = focus;
    setDecisionNote(note);
    try {
      await saveOrcidWorkDecision(uid, orcid.connectedAt, keys, decision);
    } catch (error) {
      if (!mounted.current) return;
      console.warn('An ORCID work decision could not be saved', error);
      setDecisions(current => withDecision(current, keys, previous));
      markRecent(key, previousRow);
      pendingFocus.current = origin;
      // The error toast says it; the status line would say it twice.
      setDecisionNote('');
      toastError(COPY.saveFailed);
    } finally {
      if (mounted.current) {
        setSaving((current) => {
          const next = new Set(current);
          next.delete(key);
          return next;
        });
      }
    }
  };

  const arranged = useMemo(() => (loaded ? arrangeOrcidWorks(loaded, decisions) : null), [loaded, decisions]);
  const publications = arranged?.publications ?? [];
  const addedCount = publications.filter(item => item.kind === 'added').length;
  const suggestions = (arranged?.candidates ?? []).filter(candidate => candidate.decision === null || recent.has(candidate.key));
  const hidden = (arranged?.candidates ?? []).filter(candidate => candidate.decision === 'notMine' && !recent.has(candidate.key));
  const attributed = loaded?.attributed;
  const papers = useMemo(() => (arranged ? readerPapers(arranged.publications, decisions) : []), [arranged, decisions]);
  // For you ranks by the newest of these works and leaves them all out of the
  // feed (ENG-251): once the list stands, with no decision being saved, the
  // account keeps them when they changed or are stale. Only a complete read
  // is kept, so a lookup that failed cannot shorten what the feed knows.
  const connectedAt = orcid.connectedAt;
  useEffect(() => {
    if (status !== 'ready' || !loaded || !arranged || saving.size > 0 || !connectedAt || keptSeeds === undefined) return;
    if (loaded.attributed.failed || loaded.details === 'failed') return;
    let live = true;
    const timer = setTimeout(() => {
      // Saved only while the account's decisions are still these (saveFeedSeeds).
      keepFeedSeeds(uid, connectedAt, arranged.publications, decisions, keptSeeds, feedSeedsStale).then((kept) => {
        if (live && kept !== keptSeeds) setKeptSeeds(kept);
      }, (error: unknown) => {
        console.warn('The publications For you ranks by could not be kept', error);
      });
    }, FEED_SEEDS_SAVE_DELAY_MS);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [status, loaded, arranged, decisions, saving, connectedAt, uid, keptSeeds]);

  // OpenAlex knows production iDs only: a sandbox iD may name someone else
  // there, so it gets no citations, coauthors or suggestions.
  const onOpenAlex = orcid.host === 'orcid.org';
  const coauthors = useMemo(() => (
    // Without the attributed works the reader's own author ids are unknown,
    // and the reader could be listed as their own coauthor.
    onOpenAlex && attributed && !attributed.failed ? frequentCoauthors(papers, { readerAuthorIds: attributed.authorIds, readerName: orcid.name }) : []
  ), [onOpenAlex, attributed, papers, orcid.name]);

  // The load's result, read out once: a decision is read out by its own line
  // below, so the counts here stay as they were when the page loaded.
  const announcement = useMemo(() => {
    if (status === 'loading') return COPY.loading;
    if (status !== 'ready' || !loaded) return '';
    const initial = arrangeOrcidWorks(loaded, loaded.decisions);
    const open = initial.candidates.filter(candidate => candidate.decision === null).length;
    return [
      initial.publications.length > 0 ? COPY.loaded(initial.publications.length) : COPY.emptyTitle,
      // Missing OpenAlex details are read out with the count, not left to the visible note alone.
      initial.publications.length > 0 && loaded.details === 'failed' ? COPY.detailsFailed : '',
      open > 0 ? COPY.suggestionsLoaded(open) : '',
    ].filter(Boolean).join(' ');
  }, [status, loaded]);

  const decisionButtons = (candidate: OrcidCandidate) => {
    const keys = orcidWorkKeys(candidate.paper);
    const title = candidate.paper.title ?? COPY.untitled;
    const busy = saving.has(candidate.key);
    return (
      <div className="orcid-work-actions">
        <Button
          ref={registerControl(`${candidate.key}:mine`)}
          variant="outline"
          size="sm"
          aria-label={COPY.mineLabel(title)}
          disabled={busy}
          focusableWhenDisabled
          onClick={(event) => {
            event.stopPropagation();
            void decide(keys, 'mine', { undoRow: 'mine', focus: `${candidate.key}:undo`, origin: `${candidate.key}:mine`, note: COPY.announceMine(title) });
          }}
        >
          <Check size={15} aria-hidden="true" />
          {COPY.mine}
        </Button>
        <Button
          ref={registerControl(`${candidate.key}:notMine`)}
          variant="ghost"
          size="sm"
          aria-label={COPY.notMineLabel(title)}
          disabled={busy}
          focusableWhenDisabled
          onClick={(event) => {
            event.stopPropagation();
            void decide(keys, 'notMine', { undoRow: 'notMine', focus: `${candidate.key}:undo`, origin: `${candidate.key}:notMine`, note: COPY.announceNotMine(title) });
          }}
        >
          <X size={15} aria-hidden="true" />
          {COPY.notMine}
        </Button>
      </div>
    );
  };

  return (
    <>
      <section className="settings-section" aria-labelledby="my-profile-publications-heading">
        <div className="settings-section-heading">
          <h2 ref={headingRef} id="my-profile-publications-heading" tabIndex={-1}>{COPY.publications}</h2>
          <p>{status === 'ready' && publications.length > 0 ? COPY.publicationsCount(loaded?.totalWorks ?? 0, addedCount) : COPY.publicationsIntro}</p>
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
        {status === 'ready' && loaded && loaded.totalWorks > loaded.publications.length && (
          <p className="my-profile-note">{COPY.recordCapped(loaded.totalWorks, loaded.publications.length)}</p>
        )}
        {status === 'ready' && loaded?.details === 'failed' && publications.length > 0 && (
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
          <div className="settings-list orcid-works" role="list" aria-labelledby="my-profile-publications-heading">
            {publications.map((item, index) => {
              if (item.kind === 'record') {
                const { work, paper } = item;
                return paper ? (
                  <PaperListRow key={work.putCode ?? `work-${index}`} role="listitem" paper={paper} onOpen={() => openPaper(paper)}>
                    {(paper.authors?.length ?? 0) > 0 && <ListRowAuthors paper={paper} />}
                  </PaperListRow>
                ) : (
                  <OrcidWorkRow key={work.putCode ?? `work-${index}`} work={work} />
                );
              }
              const keys = addedKeys(item);
              const title = item.paper?.title ?? item.key;
              const removeButton = (
                <div className="orcid-work-actions">
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label={COPY.removeLabel(title)}
                    disabled={saving.has(item.key)}
                    focusableWhenDisabled
                    onClick={(event) => {
                      event.stopPropagation();
                      void decide(keys, null, { undoRow: null, focus: 'heading', origin: 'heading', note: COPY.announceRemoved(title) });
                    }}
                  >
                    <X size={15} aria-hidden="true" />
                    {COPY.remove}
                  </Button>
                </div>
              );
              const paper = item.paper;
              return paper ? (
                <PaperListRow key={`added-${item.key}`} role="listitem" paper={paper} aside={COPY.addedByYou} onOpen={() => openPaper(paper)}>
                  {(paper.authors?.length ?? 0) > 0 && <ListRowAuthors paper={paper} />}
                  {removeButton}
                </PaperListRow>
              ) : (
                <AddedWorkRow key={`added-${item.key}`} itemKey={item.key} actions={removeButton} />
              );
            })}
          </div>
        )}
      </section>

      {status === 'ready' && <PublicationAreas papers={papers} decisionPending={saving.size > 0} publicationsHeading={headingRef} />}
      {status === 'ready' && onOpenAlex && <CitingPapers orcidId={orcid.id} papers={papers} lookupFailed={loaded?.details === 'failed' || Boolean(attributed?.failed)} />}
      {status === 'ready' && coauthors.length > 0 && <FrequentCoauthors coauthors={coauthors} />}

      {status === 'ready' && attributed && onOpenAlex && (
        <section className="settings-section" aria-labelledby="my-profile-suggestions-heading">
          <div className="settings-section-heading">
            <h2 ref={suggestionsHeadingRef} id="my-profile-suggestions-heading" tabIndex={-1}>{COPY.suggestions}</h2>
            <p>{COPY.suggestionsIntro}</p>
          </div>
          <p className="visually-hidden" role="status">{decisionNote}</p>

          {attributed.failed ? (
            <div className="my-profile-note">
              <p>{COPY.suggestionsFailed}</p>
              <Button variant="outline" size="sm" onClick={retry}>
                <ArrowClockwise size={15} aria-hidden="true" />
                {COPY.retry}
              </Button>
            </div>
          ) : (
            <>
              {!attributed.complete && (
                <div className="my-profile-note">
                  <p>{COPY.suggestionsPartial}</p>
                  <Button variant="outline" size="sm" onClick={retry}>
                    <ArrowClockwise size={15} aria-hidden="true" />
                    {COPY.retry}
                  </Button>
                </div>
              )}
              {attributed.complete && attributed.total > attributed.papers.length && (
                <p className="my-profile-note">{COPY.suggestionsCapped(attributed.total, attributed.papers.length)}</p>
              )}
              {suggestions.length === 0 && (
                <p className="my-profile-note">{hidden.length > 0 || addedCount > 0 ? COPY.noneLeft : COPY.noSuggestions}</p>
              )}
              {suggestions.length > 0 && (
                <div className="settings-list orcid-works" role="list" aria-labelledby="my-profile-suggestions-heading">
                  {suggestions.map((candidate) => {
                    const decided = recent.get(candidate.key);
                    const { paper } = candidate;
                    if (decided) {
                      return (
                        <div key={candidate.key} className="list-row orcid-work-row orcid-decided-row" role="listitem">
                          <p>
                            {decided === 'mine' ? COPY.addedRow : COPY.hiddenRow}
                            {' '}
                            <ScientificText>{paper.title ?? COPY.untitled}</ScientificText>
                          </p>
                          <Button
                            ref={registerControl(`${candidate.key}:undo`)}
                            variant="outline"
                            size="sm"
                            aria-label={COPY.undoLabel(paper.title ?? COPY.untitled)}
                            disabled={saving.has(candidate.key)}
                            focusableWhenDisabled
                            onClick={() => { void decide(orcidWorkKeys(paper), null, { undoRow: null, focus: `${candidate.key}:mine`, origin: `${candidate.key}:undo`, note: COPY.announceBack(paper.title ?? COPY.untitled) }); }}
                          >
                            <ArrowCounterClockwise size={15} aria-hidden="true" />
                            {COPY.undo}
                          </Button>
                        </div>
                      );
                    }
                    return (
                      <PaperListRow key={candidate.key} role="listitem" paper={paper} onOpen={() => openPaper(paper)}>
                        {(paper.authors?.length ?? 0) > 0 && <ListRowAuthors paper={paper} />}
                        {decisionButtons(candidate)}
                      </PaperListRow>
                    );
                  })}
                </div>
              )}
            </>
          )}

          {hidden.length > 0 && (
            <div className="orcid-hidden">
              <Button
                ref={hiddenToggleRef}
                variant="ghost"
                size="sm"
                aria-expanded={hiddenOpen}
                aria-controls="my-profile-hidden-works"
                onClick={() => setHiddenOpen(open => !open)}
              >
                <CaretDown size={15} aria-hidden="true" className={hiddenOpen ? 'orcid-caret-open' : undefined} />
                {COPY.hiddenToggle(hidden.length)}
              </Button>
              {hiddenOpen && (
                <div id="my-profile-hidden-works" className="settings-list orcid-works" role="list" aria-label={COPY.hiddenToggle(hidden.length)}>
                  {hidden.map(({ key, paper }) => (
                    <PaperListRow key={key} role="listitem" paper={paper} onOpen={() => openPaper(paper)}>
                      {(paper.authors?.length ?? 0) > 0 && <ListRowAuthors paper={paper} />}
                      <div className="orcid-work-actions">
                        <Button
                          variant="ghost"
                          size="sm"
                          aria-label={COPY.showAgainLabel(paper.title ?? COPY.untitled)}
                          disabled={saving.has(key)}
                          focusableWhenDisabled
                          onClick={(event) => {
                            event.stopPropagation();
                            void decide(orcidWorkKeys(paper), null, { undoRow: null, focus: 'hidden-toggle', origin: 'hidden-toggle', note: COPY.announceBack(paper.title ?? COPY.untitled) });
                          }}
                        >
                          <ArrowCounterClockwise size={15} aria-hidden="true" />
                          {COPY.showAgain}
                        </Button>
                      </div>
                    </PaperListRow>
                  ))}
                </div>
              )}
            </div>
          )}
        </section>
      )}
    </>
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
 * The account's own page, which only the account sees: its ORCID connection,
 * the public works of its ORCID record and the works that might also be its
 * own. Nothing here is shown to anyone else. Mounted with `key={uid}` by the
 * route, so another account starts from nothing.
 */
export default function ProfilePage() {
  const { orcid, user } = useAuth();
  return (
    <main className="settings-page my-profile-page">
      <div className="settings-shell my-profile-shell">
        <header className="settings-heading">
          <h1>{COPY.title}</h1>
          <p>{COPY.subtitle}</p>
        </header>
        <OrcidSection />
        {orcid && user && <OrcidPublications key={`${orcid.host}/${orcid.id}/${orcid.connectedAt}`} orcid={orcid} uid={user.uid} />}
      </div>
    </main>
  );
}
