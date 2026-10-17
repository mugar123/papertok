import PetriBell from './PetriBell.jsx';
import PetriBlankPage from './PetriBlankPage.jsx';
import PetriFlask from './PetriFlask.jsx';
import PetriKey from './PetriKey.jsx';
import PetriProfile from './PetriProfile.jsx';
import PetriReading from './PetriReading.jsx';
import PetriStar from './PetriStar.jsx';
import PetriThinking from './PetriThinking.jsx';
import PetriUpset from './PetriUpset.jsx';
import PetriWelcome from './PetriWelcome.jsx';

// Every pose Petri has, by name. Each is drawn on the same frame
// (PetriFrame.jsx); a pose file holds only what makes it that pose.
// The stamp (PetriStamp.jsx) is a different drawing — Petri small inside a
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
};

/**
 * Petri, the mascot: `<Petri pose="flask" label="…" />`. The pose's own props
 * (`name`, `level`, `visibility`) pass through. With a `label` the drawing is
 * an image of that name; without one it is decoration.
 */
export default function Petri({ pose, ...props }) {
  const Pose = POSES[pose];
  return <Pose {...props} />;
}
