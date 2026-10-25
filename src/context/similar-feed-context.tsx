import type { PropsWithChildren } from 'react';
import type { Paper } from '../models/paper.ts';

import { useCallback, useMemo, useState } from 'react';
import SimilarFeedLayer from '../components/feed/similar-feed-layer.tsx';
import { SimilarFeedContext } from './contexts.ts';

export interface SimilarFeedContextValue {
  /** Opens the Similar feed for `paper`, grown from `origin` (the pill pressed). */
  openSimilar: (paper: Paper, origin: HTMLElement) => void;
}

/**
 * One Similar layer for the whole app, so every card's pill opens the same one
 * — For You, Following, a paper page, the explorer's overlay. A pill pressed
 * inside the layer re-anchors it on that paper instead of stacking a second
 * layer, and the layer keeps the pill it first grew from: closing always
 * folds back into the card the reader left.
 */
export function SimilarFeedProvider({ children, onOpenPdf, onSaveToList }: PropsWithChildren<{
  onOpenPdf?: (paper: Paper) => void;
  onSaveToList?: (paper: Paper) => void;
}>) {
  const [layer, setLayer] = useState<{ anchor: Paper; origin: HTMLElement } | null>(null);
  const openSimilar = useCallback((anchor: Paper, origin: HTMLElement) => {
    setLayer(current => (current ? { ...current, anchor } : { anchor, origin }));
  }, []);
  const closed = useCallback(() => setLayer(null), []);
  const value = useMemo(() => ({ openSimilar }), [openSimilar]);
  return (
    <SimilarFeedContext.Provider value={value}>
      {children}
      {layer && (
        <SimilarFeedLayer
          anchor={layer.anchor}
          origin={layer.origin}
          onClosed={closed}
          onOpenPdf={onOpenPdf}
          onSaveToList={onSaveToList}
        />
      )}
    </SimilarFeedContext.Provider>
  );
}
