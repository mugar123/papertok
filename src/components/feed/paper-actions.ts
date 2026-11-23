import type { MouseEvent } from 'react';
import type { Paper } from '../../models/paper.ts';
import type { PaperMenuAction } from './paper-menu.tsx';
import { CheckCircle, DownloadSimple, Eye, Info, Prohibit } from '@phosphor-icons/react';
import { ACCOUNT_DISMISSAL_HINT } from '../../utils/feed-dismissal.ts';
import { downloadCitationFile } from '../../utils/reading-library.ts';
import { pdfLinksForPaper, pdfRelayUrl } from '../../utils/paper-open-targets.ts';
import { saveFile } from '../../utils/save-file.ts';

const PAPER_API_BASE_URL = import.meta.env?.VITE_PAPER_API_BASE_URL?.replace(/\/$/, '') || '';

// Saved through the Worker's relay, since the PDF hosts send no CORS headers; a host it does not
// relay, or a relay that fails, opens the PDF in a new tab instead, where the browser can save it.
async function downloadPdf(paper: Paper, pdfUrl: string, relayUrl: string) {
  const blob = relayUrl ? await fetch(relayUrl).then(response => (response.ok ? response.blob() : null)).catch(() => null) : null;
  if (!blob) {
    window.open(pdfUrl, '_blank', 'noopener,noreferrer');
    return;
  }
  saveFile(blob, paper.title, 'pdf');
}

export const shareMethod = (method: string) => (method === 'clipboard' || method === 'instagram' ? 'clipboard' : 'other');

/**
 * `notInterestedHint` is the feed's (feed-dismissal.ts); without one, the account's.
 * `zotero` is the signed-in reader's Send to Zotero (use-zotero-action.ts), beside the citation exports.
 */
export function paperActions({ paper, isRead, onAbout, onToggleRead, onNotInterested, notInterestedHint = ACCOUNT_DISMISSAL_HINT, zotero = null }: {
  paper: Paper; isRead: boolean; onAbout: () => void; onToggleRead: () => void; onNotInterested: (event: MouseEvent) => void; notInterestedHint?: string;
  zotero?: PaperMenuAction | null;
}): PaperMenuAction[] {
  const { fullTextUrl: pdfUrl, relaySourceUrl } = pdfLinksForPaper(paper);
  return [
    { id: 'about', label: 'About this paper', hint: 'Status, topics, funding and links', Icon: Info, onSelect: onAbout },
    {
      id: 'read',
      label: isRead ? 'Mark as unread' : 'Mark as read',
      hint: isRead ? 'Take it out of your reading history' : 'Add it to your reading history',
      Icon: isRead ? CheckCircle : Eye,
      onSelect: onToggleRead,
    },
    { id: 'skip', label: 'Not interested', hint: notInterestedHint, Icon: Prohibit, onSelect: onNotInterested },
    ...(zotero ? [zotero] : []),
    ...(pdfUrl ? [{ id: 'pdf', label: 'Download PDF', hint: 'Save a copy of the paper', Icon: DownloadSimple, onSelect: () => { void downloadPdf(paper, pdfUrl, pdfRelayUrl(relaySourceUrl, PAPER_API_BASE_URL)); } }] : []),
    { id: 'bibtex', label: 'Export BibTeX', hint: 'For LaTeX and BibTeX managers', Icon: DownloadSimple, onSelect: () => downloadCitationFile([paper], 'bibtex', 'papertok-paper') },
    { id: 'ris', label: 'Export RIS', hint: 'For Zotero, EndNote and Mendeley', Icon: DownloadSimple, onSelect: () => downloadCitationFile([paper], 'ris', 'papertok-paper') },
  ];
}
