import type { MouseEvent } from 'react';
import type { Paper } from '../../models/paper.ts';
import type { PaperMenuAction } from './paper-menu.tsx';
import { CheckCircle, DownloadSimple, Eye, Info, Prohibit } from '@phosphor-icons/react';
import { downloadCitationFile } from '../../utils/reading-library.ts';
import { safeDoiUrl, safeExternalUrl } from '../../utils/external-url.ts';
import { getPublicPaperUrl } from '../../utils/public-navigation.ts';

export const shareMethod = (method: string) => (method === 'clipboard' || method === 'instagram' ? 'clipboard' : 'other');

export function paperActions({ paper, isRead, aboutHint, onAbout, onToggleRead, onNotInterested }: {
  paper: Paper; isRead: boolean; aboutHint: string; onAbout: () => void; onToggleRead: () => void; onNotInterested: (event: MouseEvent) => void;
}): PaperMenuAction[] {
  return [
    { id: 'about', label: 'About this paper', hint: aboutHint, Icon: Info, onSelect: onAbout },
    {
      id: 'read',
      label: isRead ? 'Mark as unread' : 'Mark as read',
      hint: isRead ? 'Take it out of your reading history' : 'Add it to your reading history',
      Icon: isRead ? CheckCircle : Eye,
      onSelect: onToggleRead,
    },
    { id: 'skip', label: 'Not interested', hint: 'See fewer papers like this', Icon: Prohibit, onSelect: onNotInterested },
    { id: 'bibtex', label: 'Export BibTeX', hint: 'For LaTeX and BibTeX managers', Icon: DownloadSimple, onSelect: () => downloadCitationFile([paper], 'bibtex', 'papertok-paper') },
    { id: 'ris', label: 'Export RIS', hint: 'For Zotero, EndNote and Mendeley', Icon: DownloadSimple, onSelect: () => downloadCitationFile([paper], 'ris', 'papertok-paper') },
  ];
}

// Never the library link: it only opens for readers at that institution.
export const paperShareUrl = (paper: Paper, openCopy?: { pdfUrl?: string | null; landingPageUrl?: string | null } | null) => getPublicPaperUrl(paper)
  || safeExternalUrl(openCopy?.pdfUrl)
  || safeExternalUrl(openCopy?.landingPageUrl)
  || safeExternalUrl(paper.openAccessPdfUrl)
  || safeExternalUrl(paper.pdfUrl)
  || safeExternalUrl(paper.landingPageUrl)
  || safeDoiUrl(paper.doi)
  || (paper.arxivId ? `https://arxiv.org/abs/${encodeURIComponent(paper.arxivId)}` : '');
