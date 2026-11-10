import type { MouseEvent } from 'react';
import type { Paper } from '../../models/paper.ts';
import type { PaperMenuAction } from './paper-menu.tsx';
import { CheckCircle, DownloadSimple, Eye, Info, Prohibit } from '@phosphor-icons/react';
import { downloadCitationFile } from '../../utils/reading-library.ts';

export const shareMethod = (method: string) => (method === 'clipboard' || method === 'instagram' ? 'clipboard' : 'other');

export function paperActions({ paper, isRead, onAbout, onToggleRead, onNotInterested }: {
  paper: Paper; isRead: boolean; onAbout: () => void; onToggleRead: () => void; onNotInterested: (event: MouseEvent) => void;
}): PaperMenuAction[] {
  return [
    { id: 'about', label: 'About this paper', hint: 'Status, topics, funding and links', Icon: Info, onSelect: onAbout },
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
