export const conferenceSources = new Map<string, { venueId: string; label: string; decisionsOn?: string }>([
  ['neurips-2026', { venueId: 'NeurIPS.cc/2026/Conference', label: 'NeurIPS 2026' }],
  ['iclr-2026', { venueId: 'ICLR.cc/2026/Conference', label: 'ICLR 2026' }],
  ['icml-2026', { venueId: 'ICML.cc/2026/Conference', label: 'ICML 2026' }],
  ['colm-2026', { venueId: 'colmweb.org/COLM/2026/Conference', label: 'COLM 2026' }],
  ['iclr-2027', { venueId: 'ICLR.cc/2027/Conference', label: 'ICLR 2027', decisionsOn: '2026-12-16' }],
]);
