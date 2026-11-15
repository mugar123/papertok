import type { Paper } from '../../models/paper.ts';
import { useEffect, useState } from 'react';
import { loadPaperByIdentity } from '../../services/paper-lookup.ts';
import { parsePaperKey } from '../../utils/public-navigation.ts';

type Lookup = { key: string; paper: Paper | null; failed: boolean };

// Opening the same citation twice asks once; a long paper cites a few hundred works at most.
const MAX_CACHED = 200;
const cache = new Map<string, Promise<Paper | null>>();

function lookup(key: string) {
  let request = cache.get(key);
  if (!request) {
    const identity = parsePaperKey(key);
    request = identity ? loadPaperByIdentity(identity) : Promise.resolve(null);
    // A failure is not remembered, so opening the card again retries.
    request.catch(() => cache.delete(key));
    if (cache.size >= MAX_CACHED) cache.delete(cache.keys().next().value!);
    cache.set(key, request);
  }
  return request;
}

/**
 * The PaperTok paper a citation names, for the card to show more than the
 * reference list says. Null while it loads, when the citation carries no
 * identifier, or when no provider knows it; `failed` when a provider erred.
 */
export function useReferencePaper(key: string | null) {
  const [result, setResult] = useState<Lookup | null>(null);
  useEffect(() => {
    if (!key) return undefined;
    let active = true;
    lookup(key).then(
      (paper) => { if (active) setResult({ key, paper, failed: false }); },
      () => { if (active) setResult({ key, paper: null, failed: true }); },
    );
    return () => { active = false; };
  }, [key]);
  // A result for the previous citation is not this one's.
  const current = result?.key === key ? result : null;
  return { paper: current?.paper ?? null, loading: Boolean(key) && !current, failed: current?.failed ?? false };
}
