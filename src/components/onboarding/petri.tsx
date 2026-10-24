import type { ComponentProps } from 'react';

import PetriBell from './petri-bell.tsx';
import PetriBlankPage from './petri-blank-page.tsx';
import PetriCompass from './petri-compass.tsx';
import PetriDownload from './petri-download.tsx';
import PetriFarewell from './petri-farewell.tsx';
import PetriFlask from './petri-flask.tsx';
import PetriKey from './petri-key.tsx';
import PetriLetGo from './petri-let-go.tsx';
import PetriLost from './petri-lost.tsx';
import PetriProfile from './petri-profile.tsx';
import PetriReading from './petri-reading.tsx';
import PetriSearch from './petri-search.tsx';
import PetriStar from './petri-star.tsx';
import PetriThinking from './petri-thinking.tsx';
import PetriUpset from './petri-upset.tsx';
import PetriWelcome from './petri-welcome.tsx';

// Every pose Petri has, by name. Each is drawn on the same frame
// (petri-frame.tsx); a pose file holds only what makes it that pose.
// The stamp (petri-stamp.tsx) is a different drawing — Petri small inside a
// rubber-stamp ring, no dish — and stays its own component.
const POSES = {
  welcome: PetriWelcome,
  flask: PetriFlask,
  key: PetriKey,
  reading: PetriReading,
  profile: PetriProfile,
  thinking: PetriThinking,
  bell: PetriBell,
  blankPage: PetriBlankPage,
  upset: PetriUpset,
  star: PetriStar,
  compass: PetriCompass,
  download: PetriDownload,
  letGo: PetriLetGo,
  farewell: PetriFarewell,
  lost: PetriLost,
  search: PetriSearch,
};

/**
 * Petri, the mascot: `<Petri pose="flask" label="…" />`. The pose's own props
 * (`name`, `level`, `visibility`, `code`, `initials`, `released`) pass through. With a `label` the drawing is
 * an image of that name; without one it is decoration.
 */
export default function Petri({ pose, ...props }: ComponentProps<typeof PetriWelcome> & ComponentProps<typeof PetriReading> & ComponentProps<typeof PetriProfile> & ComponentProps<typeof PetriLost> & ComponentProps<typeof PetriFarewell> & { pose: keyof typeof POSES }) {
  const Pose = POSES[pose];
  return <Pose {...props} />;
}
