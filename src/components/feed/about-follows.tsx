import type { MouseEvent } from 'react';
import type { Paper } from '../../models/paper.ts';
import type { FollowInput } from '../../utils/following.ts';
import type { FollowRefusal, RefusalLine } from '../following/follow-refused-toast.ts';
import { useMemo, useState } from 'react';
import { useAuth } from '../../context/auth-context.tsx';
import { useFollowing } from '../../context/following-context.tsx';
import { Button } from '../ui/button.tsx';
import { FollowToggle } from '../ui/follow-toggle.tsx';
import { followName, followRefusal, refusalShownTo } from '../following/follow-refused-toast.ts';
import { ABOUT_INSTITUTION_LIMIT, aboutFollowTargets } from './about-follow-targets.ts';
import './about-follows.css';

type AboutFollowsProps = {
  paper: Paper;
  // A guest's press asks for an account.
  onAuthRequired: () => void;
  // Where a reader at the journal limit unfollows one; `inReader` says the panel is the reader's.
  onOpenSettings: (inReader: boolean) => void;
};

/**
 * The Journal and Institutions sections of "About this paper", each row with
 * the one Follow control (ENG-123). It renders nothing when the paper has
 * neither a journal OpenAlex identifies nor an institution with a verified id.
 */
export function AboutFollows({ paper, onAuthRequired, onOpenSettings }: AboutFollowsProps) {
  const { user } = useAuth();
  const { isFollowing, isFollowPending, toggleFollow } = useFollowing();
  const { journal, institutions } = useMemo(() => aboutFollowTargets(paper), [paper]);
  const [showAll, setShowAll] = useState(false);
  // Said aloud once the write settles; the toggle's own state is not announced by every reader.
  const [announcement, setAnnouncement] = useState('');
  // Shown in the panel, not as a toast: the panel is a modal layer, and a toast sits outside its focus trap.
  const [refusal, setRefusal] = useState<RefusalLine<FollowRefusal> | null>(null);
  if (!journal && institutions.length === 0) return null;

  const press = (event: MouseEvent, entity: FollowInput) => {
    if (!user) {
      onAuthRequired();
      return;
    }
    const name = followName(entity);
    const following = isFollowing(entity);
    const uid = user.uid;
    // Read now: the event has no current target once the write settles.
    const inReader = Boolean(event.currentTarget.closest('.pc-about--reader'));
    setRefusal(null);
    toggleFollow(entity).then(
      (nowFollowing) => setAnnouncement(nowFollowing ? `Following ${name}` : `Unfollowed ${name}`),
      (error: unknown) => setRefusal({ uid, refused: followRefusal(error, { name, following, openSettings: () => onOpenSettings(inReader) }) }),
    );
  };
  const refused = refusalShownTo(refusal, user?.uid);
  const row = (entity: FollowInput) => {
    const name = followName(entity);
    return (
      <li key={`${entity.type}:${entity.id}`} className="pc-follow-row">
        <span className="pc-follow-name">{name}</span>
        <FollowToggle
          pressed={isFollowing(entity)}
          pending={isFollowPending(entity)}
          onClick={(event) => press(event, entity)}
          followLabel={`Follow ${name}`}
          followingLabel={`Following ${name}`}
        />
      </li>
    );
  };
  const shown = showAll ? institutions : institutions.slice(0, ABOUT_INSTITUTION_LIMIT);
  return (
    <>
      {journal && (
        <section className="pc-about-section">
          <h3 className="pc-about-heading">Journal</h3>
          <ul className="pc-follow-list">{row(journal)}</ul>
        </section>
      )}
      {institutions.length > 0 && (
        <section className="pc-about-section">
          <h3 className="pc-about-heading">Institutions</h3>
          <ul className="pc-follow-list">{shown.map(row)}</ul>
          {institutions.length > ABOUT_INSTITUTION_LIMIT && (
            <Button
              variant="ghost"
              size="sm"
              className="pc-follow-more"
              aria-expanded={showAll}
              onClick={() => setShowAll(current => !current)}
            >
              {showAll ? 'Show fewer' : `Show all ${institutions.length}`}
            </Button>
          )}
        </section>
      )}
      <span className="visually-hidden" role="status">{announcement}</span>
      {refused && (
        <p className="pc-follow-refusal" role="alert">
          {refused.message}
          {refused.action && <Button variant="outline" size="sm" onClick={refused.action.onClick}>{refused.action.label}</Button>}
        </p>
      )}
    </>
  );
}
