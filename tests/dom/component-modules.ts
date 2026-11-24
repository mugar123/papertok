import './dom-environment.ts';
import type { Context, ReactNode } from 'react';
import type { Paper } from '../../src/models/paper.ts';
import type { ReadAloudChapter, ReadAloudTimeline, SpokenPassage } from '../../src/components/pdf/read-aloud.ts';
import { startAppModules } from './app-modules.ts';

/**
 * Single components, loaded through `app-modules.ts` the way the build loads
 * them, for tests that render one component instead of the whole app. Each
 * loader starts its own module runner; `close` releases it.
 *
 * Components are typed by what the tests pass them, not imported as types (see
 * `render-feed.ts`).
 */
type Component<Props> = (props: Props) => ReactNode;

export async function loadPaperByline() {
  const { modules: [byline], close } = await loadModules<[
    { PaperByline: Component<{ paper: Paper }> },
  ]>('/src/components/pdf/paper-byline.tsx');
  return { ...byline, close };
}

async function loadModules<Modules extends unknown[]>(...paths: string[]) {
  const app = await startAppModules();
  try {
    const modules = await Promise.all(paths.map(path => app.load(path))) as Modules;
    return { modules, close: () => app.close() };
  } catch (error) {
    await app.close();
    throw error;
  }
}

type PopupReadinessState = 'preparing' | 'ready' | 'failed';

/** `provider-sign-in.tsx`: the notes under the GitHub and Google buttons. */
export async function loadProviderSignIn() {
  const { modules: [signIn], close } = await loadModules<[{
    PreparingNote: Component<{ id: string; state: PopupReadinessState; onRetry: () => void; keepLine?: boolean }>;
    CollisionNote: Component<{ email?: string }>;
  }]>('/src/components/public/provider-sign-in.tsx');
  return { ...signIn, close };
}

/** The reader's `HighlightedScientificText`, and the KaTeX loader it draws formulas with. */
export async function loadReaderText() {
  const { modules: [text, katex], close } = await loadModules<[
    { default: Component<{ children: string }> },
    { getKatex: () => unknown; loadKatex: () => Promise<unknown> },
  ]>('/src/components/reader/highlighted-scientific-text.tsx', '/src/utils/katex-loader.ts');
  return { HighlightedScientificText: text.default, ...katex, close };
}

export async function loadReadAloud() {
  const { modules: [hook, firebase], close } = await loadModules<[
    { useReadAloud: (queue: SpokenPassage[], chapters: ReadAloudChapter[], callbacks: {
      title: string;
      onFallback: (error: unknown) => void;
      onError: () => void;
      onBlocked: () => void;
    }) => {
      playing: boolean;
      prepared: { ready: number; total: number; failed: boolean };
      timeline: ReadAloudTimeline;
      paragraph: number | null;
      position: number;
      play: (start: number) => void;
      pause: () => void;
      seek: (seconds: number) => void;
      live: () => { seconds: number | null; fraction: number };
      setSpeed: (speed: number) => void;
    } },
    import('./firebase-stub.ts').FirebaseStub,
  ]>('/src/components/pdf/use-read-aloud.ts', '/src/services/firebase.ts');
  return { ...hook, firebase, close };
}

interface WelcomeAction { label: string; onClick?: () => void }

/**
 * `welcome-shell.tsx`: the welcome's page, with its dots and buttons, and its
 * topic picker; and the `ThemeProvider` the page's theme switch needs around it.
 */
export async function loadWelcomeShell() {
  const { modules: [shell, theme], close } = await loadModules<[{
    WelcomeShell: Component<{
      stepKey: string;
      direction: number;
      still?: boolean;
      dots: { count: number; index: number; ariaLabel: string; label: (index: number, count: number) => string };
      primary: WelcomeAction & { busy?: boolean };
      children?: ReactNode;
    }>;
    SubtopicsPicker: Component<{
      selectedAreas: Set<string>;
      selectedTopics: Set<string>;
      onToggleTopic: (id: string) => void;
      expandedAreas: Set<string>;
      onToggleExpanded: (key: string) => void;
    }>;
  }, { ThemeProvider: Component<{ children?: ReactNode }> }]>('/src/components/public/welcome-shell.tsx', '/src/context/theme-context.tsx');
  return { ...shell, ThemeProvider: theme.ThemeProvider, close };
}

/** `guest-welcome-preferences.tsx`: the welcome's last screen, with its GitHub star demo. */
export async function loadWelcomeProjectSupport() {
  const { modules: [preferences], close } = await loadModules<[{ WelcomeProjectSupport: Component<object> }]>('/src/components/public/guest-welcome-preferences.tsx');
  return { WelcomeProjectSupport: preferences.WelcomeProjectSupport, close };
}


export async function loadReadingDock() {
  const { modules: [dock, contexts, firebase], close } = await loadModules<[
    { ReadingDock: Component<{
      title: string; paper?: Paper; scroll: HTMLElement | null; contents: null;
      spoken: { queue: SpokenPassage[]; chapters: ReadAloudChapter[] } | null;
      canListen: boolean; originalUrl: string;
      notes: { id: string; open: boolean; count: number; onOpenChange: (open: boolean) => void } | null;
      children?: ReactNode;
    }> },
    Record<'AuthContext' | 'AnalyticsContext', Context<unknown>>,
    import('./firebase-stub.ts').FirebaseStub,
  ]>('/src/components/pdf/reading-dock.tsx', '/src/context/contexts.ts', '/src/services/firebase.ts');
  return { ...dock, ...contexts, firebase, close };
}
