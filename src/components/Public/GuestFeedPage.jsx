import { useState } from 'react';
import {
  readGuestInterests,
  saveGuestInterests,
} from '../../utils/guestInterests.js';
import GuestWelcome from './GuestWelcome.jsx';

export default function GuestFeedPage({ onAuthRequired }) {
  // Stored choices are only a draft for account onboarding. They never grant
  // access to the feed, including answers left by the former guest flow.
  const [interests] = useState(() => readGuestInterests());

  const requestAccount = (answer) => {
    if (answer?.areas) saveGuestInterests(answer);
    onAuthRequired?.('other');
  };

  return (
    <GuestWelcome
      initialAreas={interests?.areas}
      initialTopics={interests?.topics}
      onComplete={requestAccount}
      onSignIn={requestAccount}
    />
  );
}
