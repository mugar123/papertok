import PetriFlask from './PetriFlask.tsx';
import PetriKey from './PetriKey.tsx';
import PetriProfile from './PetriProfile.tsx';
import PetriReading from './PetriReading.tsx';
import PetriThinking from './PetriThinking.tsx';
import PetriWelcome from './PetriWelcome.tsx';

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
