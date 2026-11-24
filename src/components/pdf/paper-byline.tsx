import type { Paper, PaperAuthor } from '../../models/paper.ts';
import type { OpenAlexAuthor } from '../../services/adapters/open-alex-types.ts';
import type { WikiInfo } from '../../services/wiki-service.ts';
import { useCallback, useEffect, useRef, useState } from 'react';
import { getEntityById } from '../../services/open-alex-service.ts';
import { loadEntityWikiInfo } from '../../services/wiki-service.ts';
import { authorExplorerPath, openAlexAuthorId } from '../../utils/explorer-paths.ts';
import { explorerFollowEntity } from '../explorer/explorer-follow-entity.ts';
import { useAuth } from '../../context/auth-context.tsx';
import { useFollowing } from '../../context/following-context.tsx';
import { Check, Plus } from '@phosphor-icons/react';
import { Button } from '../ui/button.tsx';
import { PreviewCard, PreviewCardContent, PreviewCardTrigger } from '../ui/preview-card.tsx';
import ScientificText from '../scientific-text.ts';
import { NewTabHint } from './new-tab-hint.tsx';
import { compactCount } from '../../utils/format-count.ts';
import './paper-byline.css';

type Profile = { author: OpenAlexAuthor | null; wiki: WikiInfo | null };


function AuthorCard({ id, author, profile }: { id: string; author: PaperAuthor; profile: Profile | null | undefined }) {
  const { user } = useAuth();
  const { isFollowing, isFollowPending, toggleFollow } = useFollowing();
  const entity = profile?.author;
  const name = entity?.display_name || author.name;
  const institution = entity?.last_known_institutions?.[0]?.display_name || author.affiliation;
  const follow = entity && user ? explorerFollowEntity({ type: 'author', routeId: id, entity, authorIdentityUnverified: false, officialName: '', displayName: name }) : null;
  const path = authorExplorerPath(author, null);
  return (
    <>
      <div className="ft-author-card-head">
        {profile?.wiki?.thumbnail
          ? <img className="ft-author-photo" src={profile.wiki.thumbnail} alt="" referrerPolicy="no-referrer" />
          : <span className="ft-author-photo" data-loading={profile === undefined || undefined} aria-hidden="true">{name.charAt(0).toUpperCase()}</span>}
        <div>
          <p className="ft-author-name">
            {path ? <a href={path} target="_blank" rel="noopener noreferrer">{name}<NewTabHint /></a> : name}
          </p>
          {/* The profile on its way: where its institution and its figures will be. */}
          {profile === undefined && (
            <>
              <span className="ft-author-skeleton" aria-hidden="true" />
              <span className="ft-author-skeleton ft-author-skeleton--short" aria-hidden="true" />
              <span className="visually-hidden" role="status">Loading profile</span>
            </>
          )}
          {institution && <p className="ft-author-place" title={institution}>{institution}</p>}
          {typeof entity?.works_count === 'number' && <p className="ft-author-stats">{compactCount.format(entity.works_count)} works</p>}
        </div>
      </div>
      {profile === null && <p className="ft-author-bio" role="status">Could not load this profile.</p>}
      {/* Cut at three lines; the rest is on the profile, which "Read more" opens. */}
      {profile?.wiki?.source === 'wikipedia' && (
        <div className="ft-author-about">
          <p className="ft-author-bio">{profile.wiki.extract}</p>
          {path && <a className="ft-author-more" href={path} target="_blank" rel="noopener noreferrer">Read more<span className="visually-hidden"> about {name}</span><NewTabHint /></a>}
        </div>
      )}
      {profile?.wiki?.imageSourceUrl && (
        <a className="ft-author-image-source" href={profile.wiki.imageSourceUrl} target="_blank" rel="noopener noreferrer">
          Photo on Wikimedia Commons<NewTabHint />
        </a>
      )}
      {follow && (
        // The design system's primary button, full width; pressed while followed.
        <Button
          className="w-full"
          variant={isFollowing(follow) ? 'outline' : 'default'}
          aria-pressed={isFollowing(follow)}
          disabled={isFollowPending(follow)}
          onClick={() => { toggleFollow(follow).catch(console.error); }}
        >
          {isFollowing(follow) ? <Check data-icon="inline-start" aria-hidden="true" /> : <Plus data-icon="inline-start" aria-hidden="true" />}
          {isFollowing(follow) ? 'Following' : 'Follow'}
          <span className="visually-hidden"> {name}</span>
        </Button>
      )}
    </>
  );
}

function loadProfile(id: string): Promise<Profile | null> {
  return getEntityById('author', id)
    .then(async (entity) => {
      const wiki = entity ? await loadEntityWikiInfo({ entity }).catch(() => null) : null;
      // The photo too, so the card opens with it rather than drawing it in.
      if (wiki?.thumbnail) new Image().src = wiki.thumbnail;
      return { author: entity, wiki };
    })
    .catch(() => null);
}

// ponytail: only the first authors are preloaded, so a 300-author paper does not fire 300
// profile requests; the rest still load on hover.
const PRELOAD = 12;

function AuthorName({ author, paper, preload }: { author: PaperAuthor; paper: Partial<Paper>; preload: boolean }) {
  const id = openAlexAuthorId(author);
  const path = authorExplorerPath(author, paper);
  const [profile, setProfile] = useState<Profile | null | undefined>(undefined);
  const requested = useRef(false);
  const load = useCallback(() => {
    if (!id || requested.current) return;
    requested.current = true;
    void loadProfile(id).then(setProfile);
  }, [id]);
  // Preloaded once the browser is idle, so the card is ready before the first hover.
  useEffect(() => {
    if (!preload) return undefined;
    const idle = window.requestIdleCallback ?? ((run: () => void) => window.setTimeout(run, 200));
    const cancel = window.cancelIdleCallback ?? window.clearTimeout;
    const handle = idle(load);
    return () => cancel(handle);
  }, [load, preload]);
  if (!id) return <a className="ft-author" href={path} target="_blank" rel="noopener noreferrer">{author.name}<NewTabHint /></a>;
  return (
    <PreviewCard onOpenChange={(open) => { if (open) load(); }}>
      <PreviewCardTrigger className="ft-author" href={path} target="_blank" rel="noopener noreferrer" delay={400}>
        {author.name}
      </PreviewCardTrigger>
      <PreviewCardContent className="ft-author-card">
        <AuthorCard id={id} author={author} profile={profile} />
      </PreviewCardContent>
    </PreviewCard>
  );
}

/** The authors, each opening a card with their photo and work, and the places they list. */
export function PaperAuthors({ paper }: { paper: Partial<Paper> }) {
  const authors = (paper.authors ?? []).map(author => (typeof author === 'string' ? { name: author } : author)).filter(author => author.name);
  const affiliations = [...new Set(authors.map(author => author.affiliation?.trim()).filter((place): place is string => Boolean(place)))];
  const numbered = affiliations.length > 1;
  return (
    <>
      {authors.length > 0 && (
        <p className="ft-authors">
          {authors.map((author, index) => {
            const place = author.affiliation?.trim();
            return (
              <span key={index} className="ft-author-item">
                <AuthorName author={author} paper={paper} preload={index < PRELOAD} />
                {numbered && place && <sup>{affiliations.indexOf(place) + 1}</sup>}
              </span>
            );
          })}
        </p>
      )}
      {affiliations.length > 0 && (
        <p className="ft-affiliations">
          {affiliations.map((place, index) => (
            <span key={place}>{numbered && <sup>{index + 1}</sup>}{place}</span>
          ))}
        </p>
      )}
    </>
  );
}

export function PaperByline({ paper }: { paper: Paper }) {
  return (
    <header className="ft-head">
      <h2 className="ft-title"><ScientificText>{paper.title}</ScientificText></h2>
      <PaperAuthors paper={paper} />
    </header>
  );
}
