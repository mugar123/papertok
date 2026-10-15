import PetriFlask from './PetriFlask.jsx';
import PetriProfile from './PetriProfile.jsx';
import PetriReading from './PetriReading.jsx';
import PetriThinking from './PetriThinking.jsx';
import PetriWelcome from './PetriWelcome.jsx';

// Every pose Petri has, by name. Each is drawn on the same frame
// (PetriFrame.jsx); a pose file holds only what makes it that pose.
// The stamp (PetriStamp.jsx) is a different drawing — Petri small inside a
// rubber-stamp ring, no dish — and stays its own component.
const POSES = {
  welcome: PetriWelcome, // holding up a card with the reader's name: `name`
  flask: PetriFlask, // experimenting, a flask held up
  reading: PetriReading, // dressed for a reading level: `level`
  profile: PetriProfile, // smiling, or in shades when private: `visibility`
  thinking: PetriThinking, // a question mark over her
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
