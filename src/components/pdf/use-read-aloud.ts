import type { ReadAloudChapter, SpokenPassage } from './read-aloud.ts';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { locateInListen, readAloudTimeline } from './read-aloud.ts';
import { ReadAloudError, fetchParagraphAudio } from '../../services/read-aloud-service.ts';

const hasBrowserVoice = () => typeof window !== 'undefined' && 'speechSynthesis' in window;
/** Passages one listener asks for at once, well inside the plan's concurrent generations shared by every listener. */
const WORKERS = 3;
const BUSY_RETRIES = 3;

const passageText = (item: SpokenPassage) => item.utterances.join(' ');
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** How long a clip plays, read from its own metadata. */
function clipSeconds(url: string) {
  return new Promise<number | null>((resolve) => {
    const probe = new Audio();
    probe.preload = 'metadata';
    probe.onloadedmetadata = () => resolve(Number.isFinite(probe.duration) ? probe.duration : null);
    probe.onerror = () => resolve(null);
    probe.src = url;
  });
}

/**
 * Reads the paper aloud in PaperTok's voice. Starting asks for every passage,
 * a couple at a time from where the listen begins, so the whole paper is there
 * to seek through, and the timeline swaps each estimate for the clip's real
 * length as it arrives. Once the voice's credits are spent, only audio already
 * made is asked for, so every stored passage still plays in PaperTok's voice;
 * a passage without audio is read by the browser's own voice, which can only
 * start a passage from its beginning.
 */
export function useReadAloud(queue: SpokenPassage[], chapters: ReadAloudChapter[], { onFallback, onError }: {
  onFallback: (error: unknown) => void;
  onError: () => void;
}) {
  const [paragraph, setParagraph] = useState<number | null>(null);
  const [progress, setProgress] = useState(0);
  const [playing, setPlaying] = useState(false);
  // Each passage's audio that has arrived, by its text, with how long it plays.
  const [lengths, setLengths] = useState<Record<string, number>>({});
  // Every passage has been asked for, so any still missing will not come.
  const [prepareDone, setPrepareDone] = useState(false);
  const run = useRef(0);
  const audio = useRef<HTMLAudioElement | null>(null);
  const clips = useRef(new Map<string, Promise<string>>());
  const fetches = useRef<AbortController | null>(null);
  // The voice refused for want of credits: from then on, stored audio only.
  const storedOnly = useRef(false);
  const told = useRef(false);
  // The queue whose passages are being fetched in full; a new queue starts over.
  const fetchingAll = useRef<SpokenPassage[] | null>(null);

  const timeline = useMemo(() => readAloudTimeline(queue, chapters, item => lengths[passageText(item)]), [chapters, lengths, queue]);
  const ready = queue.filter(item => lengths[passageText(item)] !== undefined).length;

  const pause = useCallback(() => {
    run.current += 1;
    audio.current?.pause();
    if (hasBrowserVoice()) window.speechSynthesis.cancel();
    setPlaying(false);
  }, []);

  const reset = useCallback(() => {
    pause();
    setParagraph(null);
    setProgress(0);
  }, [pause]);

  useEffect(() => {
    const controller = new AbortController();
    const cache = clips.current;
    fetches.current = controller;
    return () => {
      controller.abort();
      for (const pending of cache.values()) void pending.then(url => URL.revokeObjectURL(url), () => undefined);
      cache.clear();
    };
  }, []);

  useEffect(() => {
    window.addEventListener('pagehide', pause);
    return () => {
      window.removeEventListener('pagehide', pause);
      pause();
    };
  }, [pause]);

  const request = async (text: string): Promise<Blob> => {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await fetchParagraphAudio(text, { signal: fetches.current?.signal, storedOnly: storedOnly.current });
      } catch (error) {
        if (error instanceof ReadAloudError && error.code === 'AI_QUOTA_EXHAUSTED') storedOnly.current = true;
        if (!(error instanceof ReadAloudError && error.code === 'AI_BUSY') || attempt >= BUSY_RETRIES) throw error;
        await wait(800 * (attempt + 1));
      }
    }
  };

  const clip = (item: SpokenPassage) => {
    const text = passageText(item);
    let pending = clips.current.get(text);
    if (!pending) {
      pending = request(text).then((blob) => {
        const url = URL.createObjectURL(blob);
        void clipSeconds(url).then((seconds) => {
          setLengths(known => ({ ...known, [text]: seconds ?? readAloudTimeline([item], []).duration }));
        });
        return url;
      });
      pending.catch(() => undefined);
      clips.current.set(text, pending);
    }
    return pending;
  };

  /**
   * Asks for every passage, from `start` to the end and then the ones before it.
   * A passage refused for credits or not stored is skipped; any other failure
   * (the Worker down, a timeout) stops the rest.
   */
  const fetchAll = (start: number) => {
    if (fetchingAll.current === queue) return;
    const items = queue;
    fetchingAll.current = items;
    setPrepareDone(false);
    const order = [...items.slice(start), ...items.slice(0, start)];
    let next = 0;
    let stopped = false;
    let working = WORKERS;
    const work = async () => {
      while (!stopped && next < order.length && fetchingAll.current === items) {
        try {
          await clip(order[next++]);
        } catch (error) {
          const skippable = error instanceof ReadAloudError && (error.code === 'AI_QUOTA_EXHAUSTED' || error.code === 'AI_AUDIO_NOT_STORED');
          if (!skippable) stopped = true;
        }
      }
      working -= 1;
      if (working === 0 && fetchingAll.current === items) setPrepareDone(true);
    };
    for (let count = 0; count < WORKERS; count += 1) void work();
  };

  const play = (start: number, fraction = 0) => {
    const token = ++run.current;
    const current = () => token === run.current;
    // A jump while either voice is speaking silences it before the new place starts.
    audio.current?.pause();
    if (hasBrowserVoice()) window.speechSynthesis.cancel();
    setPlaying(true);
    fetchAll(start);

    const speakWithBrowser = (index: number, sentence: number) => {
      const item = queue[index];
      if (sentence >= item.utterances.length) {
        next(index + 1, 0);
        return;
      }
      const utterance = new SpeechSynthesisUtterance(item.utterances[sentence]);
      utterance.lang = 'en-US';
      utterance.onend = () => {
        if (!current()) return;
        setProgress((sentence + 1) / item.utterances.length);
        speakWithBrowser(index, sentence + 1);
      };
      utterance.onerror = () => {
        if (!current()) return;
        pause();
        onError();
      };
      window.speechSynthesis.speak(utterance);
    };

    /** A passage without PaperTok's audio: the browser reads it, and the next one tries the stored audio again. */
    const fallBack = (index: number, error: unknown) => {
      if (!current()) return;
      const first = !told.current;
      told.current = true;
      if (!hasBrowserVoice()) {
        if (first) onError();
        next(index + 1, 0);
        return;
      }
      if (first) onFallback(error);
      setProgress(0);
      speakWithBrowser(index, 0);
    };

    function next(index: number, from: number) {
      if (!current()) return;
      if (!queue[index]) {
        reset();
        return;
      }
      setParagraph(index);
      setProgress(from);
      clip(queue[index]).then((url) => {
        if (!current()) return undefined;
        const element = audio.current ?? new Audio();
        audio.current = element;
        element.onloadedmetadata = () => {
          if (from > 0 && Number.isFinite(element.duration)) element.currentTime = from * element.duration;
        };
        element.ontimeupdate = () => {
          if (current() && element.duration) setProgress(element.currentTime / element.duration);
        };
        element.onended = () => next(index + 1, 0);
        element.onerror = () => fallBack(index, element.error);
        if (element.src !== url) element.src = url;
        else if (Number.isFinite(element.duration)) element.currentTime = from * element.duration;
        return element.play();
      }).catch((error: unknown) => fallBack(index, error));
    }

    next(start, fraction);
  };

  const at = paragraph === null ? null : timeline.passages[paragraph];
  const position = at ? at.start + progress * (at.end - at.start) : 0;

  const seek = (seconds: number) => {
    const target = locateInListen(timeline, Math.min(Math.max(0, seconds), timeline.duration));
    if (playing) play(target.index, target.fraction);
    else {
      setParagraph(target.index);
      setProgress(target.fraction);
    }
  };

  return {
    timeline,
    /** How much of the paper's audio exists yet; `failed` once a passage was refused and the rest will not come. */
    prepared: { ready, total: queue.length, failed: prepareDone && ready < queue.length },
    paragraph,
    playing,
    position,
    /** Starts at `start` when nothing is under way yet, otherwise carries on from where it paused. */
    play: (start: number) => (paragraph === start ? play(start, progress) : play(start)),
    pause,
    reset,
    seek,
  };
}
