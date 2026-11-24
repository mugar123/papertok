import type { Paper } from '../../models/paper.ts';
import type { FollowInput } from '../../utils/following.ts';
import type { FollowRefusal, RefusalLine } from '../following/follow-refused-toast.ts';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useAuth } from '../../context/auth-context.tsx';
import { useFollowing } from '../../context/following-context.tsx';
import { Button } from '../ui/button.tsx';
import { FollowToggle } from '../ui/follow-toggle.tsx';
import { actionStart } from '../ui/toast.ts';
import { followName, followRefusal, refusalShownTo, sayFollowRefused } from '../following/follow-refused-toast.ts';
import { ABOUT_INSTITUTION_LIMIT, aboutFollowTargets } from './about-follow-targets.ts';
import './about-follows.css';

type AboutFollowsProps = {
  paper: Paper;
  // A guest's press asks for an account.
  onAuthRequired: () => void;
};

/**
 * The Institutions section of "About this paper", each row with the one
 * Follow control (ENG-123). It renders nothing when the paper has no
 * institution with a verified id.
 */
export function AboutFollows({ paper, onAuthRequired }: AboutFollowsProps) {
  const { user } = useAuth();
  const { isFollowing, isFollowPending, toggleFollow } = useFollowing();
  const institutions = useMemo(() => aboutFollowTargets(paper), [paper]);
  const [showAll, setShowAll] = useState(false);
  // Said aloud once the write settles; the toggle's own state is not announced by every reader.
  const [announcement, setAnnouncement] = useState('');
  // Said in the panel, under the list, not as a toast: the panel is a modal layer, and a
  // toast sits outside its focus trap. A press that settles after the panel closed is a toast.
  const [refusal, setRefusal] = useState<RefusalLine<FollowRefusal> | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  if (institutions.length === 0) return null;

  const press = (entity: FollowInput) => {
    if (!user) {
      onAuthRequired();
      return;
    }
    const name = followName(entity);
    const following = isFollowing(entity);
    const uid = user.uid;
    const startedAt = actionStart();
    setRefusal(null);
    toggleFollow(entity).then(
      (nowFollowing) => setAnnouncement(nowFollowing ? `Following ${name}` : `Unfollowed ${name}`),
      (error: unknown) => sayFollowRefused(
        followRefusal(error, { name, following }),
        { inView: () => mounted.current, showInLine: refused => setRefusal({ uid, refused }), startedAt },
      ),
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
          onClick={() => press(entity)}
          followLabel={`Follow ${name}`}
          followingLabel={`Following ${name}`}
        />
      </li>
    );
  };
  const shown = showAll ? institutions : institutions.slice(0, ABOUT_INSTITUTION_LIMIT);
  return (
    <>
      <section className="pc-about-section">
        <h3 className="pc-about-heading">Institutions</h3>
        <ul className="pc-follow-list">{shown.map(entity => row(entity))}</ul>
        {refused && <p className="pc-follow-refusal" role="alert">{refused.message}</p>}
        {institutions.length > ABOUT_INSTITUTION_LIMIT && (
          <Button
            variant="ghost"
            size="sm"
            className="pc-follow-more"
            aria-expanded={showAll}
            onClick={() => setShowAll(current => !current)}
          >
            {showAll ? 'Show fewer' : `Show all ${institutions.length} institutions`}
          </Button>
        )}
      </section>
      <span className="visually-hidden" role="status">{announcement}</span>
    </>
  );
}
