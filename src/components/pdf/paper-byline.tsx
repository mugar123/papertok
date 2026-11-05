import type { Paper, PaperAuthor } from '../../models/paper.ts';
import type { OpenAlexAuthor } from '../../services/adapters/open-alex-types.ts';
import type { WikiInfo } from '../../services/wiki-service.ts';
import { useState } from 'react';
import { getEntityById } from '../../services/open-alex-service.ts';
import { loadEntityWikiInfo } from '../../services/wiki-service.ts';
import { authorExplorerPath, openAlexAuthorId } from '../../utils/explorer-paths.ts';
import { explorerFollowEntity } from '../explorer/explorer-follow-entity.ts';
import { useAuth } from '../../context/auth-context.tsx';
import { useFollowing } from '../../context/following-context.tsx';
import { FollowToggle } from '../ui/follow-toggle.tsx';
import { PreviewCard, PreviewCardContent, PreviewCardTrigger } from '../ui/preview-card.tsx';
import ScientificText from '../scientific-text.ts';

type Profile = { author: OpenAlexAuthor | null; wiki: WikiInfo | null };

const compact = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 });

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
          <p className="ft-author-name">{name}</p>
          {/* The profile on its way: where its institution and its figures will be. */}
          {profile === undefined && (
            <>
              <span className="ft-author-skeleton" aria-hidden="true" />
              <span className="ft-author-skeleton ft-author-skeleton--short" aria-hidden="true" />
              <span className="visually-hidden" role="status">Loading profile</span>
            </>
          )}
          {institution && <p className="ft-author-place">{institution}</p>}
          {typeof entity?.works_count === 'number' && <p className="ft-author-stats">{compact.format(entity.works_count)} works</p>}
        </div>
      </div>
      {profile === null && <p className="ft-author-bio" role="status">Could not load this profile.</p>}
      {profile?.wiki && <p className="ft-author-bio">{profile.wiki.extract}</p>}
      <div className="ft-author-actions">
        {follow && (
          <FollowToggle
            pressed={isFollowing(follow)}
            disabled={isFollowPending(follow)}
            onClick={() => { toggleFollow(follow).catch(console.error); }}
            followLabel={`Follow ${name}`}
            followingLabel={`Following ${name}`}
          />
        )}
        <span className="ft-author-links">
          {path && <a href={path} target="_blank" rel="noopener noreferrer">Open profile<span className="visually-hidden"> (opens in a new tab)</span></a>}
        </span>
      </div>
    </>
  );
}

// An author OpenAlex knows opens a preview of their profile; one it does not is only a name.
function AuthorName({ author }: { author: PaperAuthor }) {
  const id = openAlexAuthorId(author);
  const [profile, setProfile] = useState<Profile | null | undefined>(undefined);
  if (!id) return <span className="ft-author">{author.name}</span>;
  const load = (open: boolean) => {
    if (!open || profile) return;
    void getEntityById('author', id)
      .then(async found => {
        const entity = found;
        const wiki = entity ? await loadEntityWikiInfo({ entity }).catch(() => null) : null;
        setProfile({ author: entity, wiki });
      })
      .catch(() => setProfile(null));
  };
  return (
    <PreviewCard onOpenChange={load}>
      <PreviewCardTrigger className="ft-author" href={authorExplorerPath(author, null)} target="_blank" rel="noopener noreferrer" delay={400}>
        {author.name}
      </PreviewCardTrigger>
      <PreviewCardContent className="ft-author-card">
        <AuthorCard id={id} author={author} profile={profile} />
      </PreviewCardContent>
    </PreviewCard>
  );
}

/** The paper's title block: its title, its authors numbered by affiliation, and those affiliations. */
export function PaperByline({ paper }: { paper: Paper }) {
  const authors = paper.authors.map(author => (typeof author === 'string' ? { name: author } : author)).filter(author => author.name);
  const affiliations = [...new Set(authors.map(author => author.affiliation?.trim()).filter((place): place is string => Boolean(place)))];
  const numbered = affiliations.length > 1;
  return (
    <header className="ft-head">
      <h2 className="ft-title"><ScientificText>{paper.title}</ScientificText></h2>
      {authors.length > 0 && (
        <p className="ft-authors">
          {authors.map((author, index) => {
            const place = author.affiliation?.trim();
            return (
              <span key={index} className="ft-author-item">
                <AuthorName author={author} />
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
    </header>
  );
}
