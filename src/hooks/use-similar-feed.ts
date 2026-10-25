import { useContext } from 'react';
import { SimilarFeedContext } from '../context/contexts.ts';

// Apart from the provider, which renders the layer and through it the cards
// that call this: importing the hook from there would close an import cycle.
export function useSimilarFeed() {
  const context = useContext(SimilarFeedContext);
  if (!context) throw new Error('useSimilarFeed must be used within a SimilarFeedProvider');
  return context;
}
