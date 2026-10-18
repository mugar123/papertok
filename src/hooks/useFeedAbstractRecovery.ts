import { useEffect } from 'react';
import type { Paper } from '../models/Paper.ts';
import { fetchPapersByIds } from '../services/arxivService.ts';
import { getMissingArxivAbstractIds, getMissingAbstractDois } from '../utils/feedEnrichment.ts';
import { fetchInspireAbstracts } from '../services/inspireAbstractService.ts';

export function useFeedAbstractRecovery(
  papers: Paper[],
  onRecovered: (records: Partial<Paper>[]) => void,
  scope: string,
) {
  const idsKey = getMissingArxivAbstractIds(papers).join(',');
  useEffect(() => {
    if (!idsKey) return;
    let active = true;
    const recover = async () => {
      const ids = idsKey.split(',');
      // Match the existing Worker limit and share arXiv's queue, deadlines and cache.
      for (let offset = 0; offset < ids.length && active; offset += 50) {
        const records = await fetchPapersByIds(ids.slice(offset, offset + 50));
        if (active) onRecovered(records);
      }
    };
    void recover().catch(error => {
      if (active) console.warn('arXiv abstract recovery failed', error);
    });
    return () => { active = false; };
  }, [idsKey, onRecovered, scope]);

  const doisKey = JSON.stringify(getMissingAbstractDois(papers));
  useEffect(() => {
    const dois = JSON.parse(doisKey) as string[];
    if (!dois.length) return;
    let active = true;
    void fetchInspireAbstracts(dois).then(records => {
      if (active) onRecovered(records);
    }).catch(error => {
      if (active) console.warn('INSPIRE abstract recovery failed', error);
    });
    return () => { active = false; };
  }, [doisKey, onRecovered, scope]);
}
