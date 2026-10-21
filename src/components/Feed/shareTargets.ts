import type { ExternalToast } from 'sonner';

import { InstagramLogo, LinkedinLogo, RedditLogo, WhatsappLogo, XLogo } from '@phosphor-icons/react';
import { toast } from 'sonner';

export type Shared = (method: string) => void;
type ShareData = { text: string; url: string };

const enc = encodeURIComponent;

export const NETWORKS = [
  { id: 'x', name: 'X', Icon: XLogo, href: ({ text, url }: ShareData) => `https://twitter.com/intent/tweet?text=${enc(text)}&url=${enc(url)}` },
  { id: 'reddit', name: 'Reddit', Icon: RedditLogo, href: ({ text, url }: ShareData) => `https://www.reddit.com/submit?url=${enc(url)}&title=${enc(text)}` },
  { id: 'linkedin', name: 'LinkedIn', Icon: LinkedinLogo, href: ({ url }: ShareData) => `https://www.linkedin.com/sharing/share-offsite/?url=${enc(url)}` },
  { id: 'whatsapp', name: 'WhatsApp', Icon: WhatsappLogo, href: ({ text, url }: ShareData) => `https://wa.me/?text=${enc(`${text} ${url}`)}` },
  { id: 'instagram', name: 'Instagram', Icon: InstagramLogo, href: null },
];

export const INSTAGRAM_NOTE = 'Link copied. Paste it in your Instagram story or bio.';

export async function copyLink({ url, onShared, method, message, position }: { url: string; onShared?: Shared; method: string; message: string; position?: ExternalToast['position'] }) {
  try {
    await navigator.clipboard.writeText(url);
  } catch (error) {
    console.error('Could not copy the link', error);
    toast.error('Could not copy the link', { position });
    return;
  }
  onShared?.(method);
  toast.success(message, { position });
}
