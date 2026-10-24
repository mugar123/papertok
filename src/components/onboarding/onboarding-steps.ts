// The account's first screens, drawn in the welcome's layout (WelcomeShell),
// one per screen: the areas, the topics within them, and the university
// library. They are asked only of a reader who did not answer them on the
// welcome (an account opened from a shared link). A reader who did gets one
// screen that saves the answer on arrival and stays only to offer a retry.
export function onboardingSteps({ asksTopics }: { asksTopics: boolean }) {
  return asksTopics ? ['topics', 'subtopics', 'university'] : ['finish'];
}

/**
 * What the onboarding says when saving fails. A write timeout is told apart by
 * its stable code: the write is a merge-set of the same fields, so the
 * reader's own retry is the whole recovery, and they are told why the button
 * stopped spinning. Anything else is unexpected and worth logging.
 */
export function onboardingSaveError(error: unknown) {
  return (error as { code?: string } | null)?.code === 'ONBOARDING_WRITE_TIMEOUT'
    ? { message: 'Still saving. Check your connection and try again.', unexpected: false }
    : { message: 'Could not save. Try again.', unexpected: true };
}
