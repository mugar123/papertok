import type { Paper } from '../../models/paper.ts';
import { useCallback, useEffect, useState } from 'react';
import { loadPaperByIdentity } from '../../services/paper-lookup.ts';
import { parsePaperKey } from '../../utils/public-navigation.ts';

type Lookup = { key: string; paper: Paper | null; failed: boolean };

const MAX_CACHED = 200;
const cache = new Map<string, Promise<Paper | null>>();

function lookup(key: string) {
  let request = cache.get(key);
  if (!request) {
    const identity = parsePaperKey(key);
    request = identity ? loadPaperByIdentity(identity) : Promise.resolve(null);
    request.catch(() => cache.delete(key));
    if (cache.size >= MAX_CACHED) cache.delete(cache.keys().next().value!);
    cache.set(key, request);
  }
  return request;
}

export function useReferencePaper(key: string | null) {
  const [result, setResult] = useState<Lookup | null>(null);
  // A failed lookup leaves the cache, so asking again fetches again.
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!key) return undefined;
    let active = true;
    lookup(key).then(
      (paper) => { if (active) setResult({ key, paper, failed: false }); },
      () => { if (active) setResult({ key, paper: null, failed: true }); },
    );
    return () => { active = false; };
  }, [key, attempt]);
  const current = result?.key === key ? result : null;
  const retry = useCallback(() => {
    setResult(null);
    setAttempt(count => count + 1);
  }, []);
  return { paper: current?.paper ?? null, loading: Boolean(key) && !current, failed: current?.failed ?? false, retry };
}
