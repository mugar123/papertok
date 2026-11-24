import type { CharacterTimings, ReadAloudChapter, SpokenPassage } from './read-aloud.ts';
import { useCallback, useEffect, useEffectEvent, useMemo, useRef, useState } from 'react';
import { CHARS_PER_SECOND, locateInListen, passageText, readAloudTimeline } from './read-aloud.ts';
import { ReadAloudError, fetchParagraphAudio, fetchParagraphTimings } from '../../services/read-aloud-service.ts';

const hasBrowserVoice = () => typeof window !== 'undefined' && 'speechSynthesis' in window;
/** Passages one listener asks for at once, well inside the plan's concurrent generations shared by every listener. */
const WORKERS = 3;
// A moment of silence played within the press: Safari on iOS lets an audio element that has
// played once from a press play again later, when its clip arrives after the network wait.
const SILENCE = 'data:audio/wav;base64,UklGRjQAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YRAAAAAAAAAAAAAAAAAAAAAAAAAA';

/** The speeds the player offers, slowest first. */
export const READ_ALOUD_SPEEDS = [0.75, 1, 1.25, 1.5, 2] as const;
const BUSY_RETRIES = 3;
/** A sentence shorter than this is mostly the voice starting and stopping, so it does not time the pace. */
const TIMED_SENTENCE_CHARS = 40;

/** Refused for credits, or not stored while stored-only: the browser reads it and nothing retries. */
const skippable = (error: unknown) => error instanceof ReadAloudError && (error.code === 'AI_QUOTA_EXHAUSTED' || error.code === 'AI_AUDIO_NOT_STORED');

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
export function useReadAloud(queue: SpokenPassage[], chapters: ReadAloudChapter[], { title, onFallback, onError, onBlocked }: {
  title: string;
  onFallback: (error: unknown) => void;
  onError: () => void;
  /** The browser would not start the audio without another press; the voice is paused. */
  onBlocked: () => void;
}) {
  const [paragraph, setParagraph] = useState<number | null>(null);
  const [progress, setProgress] = useState(0);
  const [playing, setPlaying] = useState(false);
  // Each passage's audio that has arrived, by its text, with how long it plays.
  const [lengths, setLengths] = useState<Record<string, number>>({});
  // ElevenLabs' timings of each passage that has them, by its text.
  const [timings, setTimings] = useState<Record<string, CharacterTimings>>({});
  // Which voice is reading the passage (none while its clip loads), and how far the browser's voice has got through it.
  const voice = useRef<'audio' | 'browser' | null>(null);
  // Passages whose timings were asked for, so each is asked once, as it starts playing.
  const timed = useRef(new Set<string>());
  const spokenChars = useRef(0);
  // The sentence the browser's voice is on. Some voices (Android's) report no word
  // boundaries, so its progress is estimated from the time since it started, at the
  // pace its longer sentences have been read so far.
  const browserSentence = useRef({ before: 0, length: 0, startedAt: 0, heard: false });
  const pace = useRef({ chars: 0, seconds: 0 });
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
  // Settles once that queue's passages have all been asked for, or the asking stopped.
  const preparation = useRef<Promise<void>>(Promise.resolve());
  const [speed, setSpeedState] = useState<number>(1);
  // Read when a clip or sentence starts, so a change made meanwhile applies to it.
  const speedNow = useRef(1);

  const timeline = useMemo(() => readAloudTimeline(queue, chapters, item => lengths[passageText(item)]), [chapters, lengths, queue]);
  const ready = useMemo(() => queue.reduce((count, item) => count + Number(lengths[passageText(item)] !== undefined), 0), [lengths, queue]);

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
    const known = clips.current.get(text);
    if (known) return known;
    const pending = request(text).then((blob) => {
      const url = URL.createObjectURL(blob);
      void clipSeconds(url).then((seconds) => {
        setLengths(lengths => ({ ...lengths, [text]: seconds ?? readAloudTimeline([item], []).duration }));
      });
      return url;
    });
    // A passage that failed for now is asked for again the next time it is needed.
    pending.catch((error: unknown) => {
      if (!skippable(error) && clips.current.get(text) === pending) clips.current.delete(text);
    });
    clips.current.set(text, pending);
    return pending;
  };

  /**
   * Asks for every passage, from `start` to the end and then the ones before it.
   * A passage refused for credits or not stored is skipped; any other failure
   * (the Worker down, a timeout) stops the rest.
   */
  const fetchAll = (start: number) => {
    if (fetchingAll.current === queue) return preparation.current;
    const items = queue;
    fetchingAll.current = items;
    setPrepareDone(false);
    let settle = () => {};
    preparation.current = new Promise<void>((resolve) => { settle = resolve; });
    const order = [...items.slice(start), ...items.slice(0, start)];
    let next = 0;
    let stopped = false;
    let working = WORKERS;
    const work = async () => {
      while (!stopped && next < order.length && fetchingAll.current === items) {
        try {
          await clip(order[next++]);
        } catch (error) {
          if (!skippable(error) && !stopped) {
            stopped = true;
            fetchingAll.current = null;
            setPrepareDone(true);
            settle();
          }
        }
      }
      working -= 1;
      if (working === 0 && fetchingAll.current === items) setPrepareDone(true);
      if (working === 0) settle();
    };
    for (let count = 0; count < WORKERS; count += 1) void work();
    return preparation.current;
  };

  const play = (start: number, fraction = 0) => {
    const token = ++run.current;
    const current = () => token === run.current;
    // A jump while either voice is speaking silences it before the new place starts.
    audio.current?.pause();
    if (hasBrowserVoice()) window.speechSynthesis.cancel();
    if (!audio.current) {
      audio.current = new Audio();
      audio.current.src = SILENCE;
      audio.current.play().catch(() => undefined);
    }
    setPlaying(true);

    /** Reads the passage from its sentence `sentence`, that sentence from its character `skip`. */
    const speakWithBrowser = (index: number, sentence: number, skip = 0) => {
      const item = queue[index];
      if (sentence >= item.utterances.length) {
        next(index + 1, 0);
        return;
      }
      const line = item.utterances[sentence].slice(skip);
      const utterance = new SpeechSynthesisUtterance(line);
      utterance.lang = 'en-US';
      utterance.rate = speedNow.current;
      const before = item.utterances.slice(0, sentence).reduce((sum, text) => sum + text.length + 1, 0) + skip;
      voice.current = 'browser';
      spokenChars.current = before;
      const said = { before, length: line.length, startedAt: 0, heard: false };
      browserSentence.current = said;
      utterance.onstart = () => { said.startedAt = performance.now(); };
      utterance.onboundary = (event) => {
        // Some voices report only sentence boundaries, which say nothing within one.
        if (!current() || event.name !== 'word') return;
        said.heard = true;
        spokenChars.current = before + event.charIndex;
      };
      utterance.onend = () => {
        if (!current()) return;
        if (said.startedAt && said.length >= TIMED_SENTENCE_CHARS) {
          pace.current.chars += said.length;
          pace.current.seconds += (performance.now() - said.startedAt) / 1000;
        }
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

    /**
     * A passage without PaperTok's audio: the browser reads it, and the next one tries the stored
     * audio again. A jump into the passage (a skip of 15 seconds, a press on the timeline) starts
     * the browser's voice at the word that holds the place, by handing it the text from there.
     */
    const fallBack = (index: number, error: unknown, from = 0) => {
      if (!current()) return;
      const first = !told.current;
      told.current = true;
      if (!hasBrowserVoice()) {
        if (first) onError();
        next(index + 1, 0);
        return;
      }
      if (first) onFallback(error);
      const lines = queue[index].utterances;
      const place = from * passageText(queue[index]).length;
      let sentence = 0;
      let start = 0;
      while (sentence < lines.length - 1 && start + lines[sentence].length + 1 <= place) {
        start += lines[sentence].length + 1;
        sentence += 1;
      }
      // Back to the start of the word the place falls in, so the voice does not begin mid-word.
      const skip = Math.max(0, lines[sentence].lastIndexOf(' ', Math.max(0, Math.floor(place - start))) + 1);
      setProgress(from);
      speakWithBrowser(index, sentence, skip);
    };

    function next(index: number, from: number) {
      if (!current()) return;
      if (!queue[index]) {
        reset();
        return;
      }
      setParagraph(index);
      setProgress(from);
      voice.current = null;
      clip(queue[index]).then((url) => {
        if (!current()) return undefined;
        const element = (audio.current ??= new Audio());
        element.onloadedmetadata = () => {
          if (from > 0 && Number.isFinite(element.duration)) element.currentTime = from * element.duration;
        };
        element.ontimeupdate = () => {
          if (current() && element.duration) setProgress(element.currentTime / element.duration);
        };
        element.onended = () => next(index + 1, 0);
        element.onerror = () => fallBack(index, element.error, from);
        if (element.src !== url) element.src = url;
        else if (Number.isFinite(element.duration)) element.currentTime = from * element.duration;
        element.playbackRate = speedNow.current;
        voice.current = 'audio';
        const text = passageText(queue[index]);
        if (!timed.current.has(text)) {
          timed.current.add(text);
          void fetchParagraphTimings(text, { signal: fetches.current?.signal }).then((found) => {
            if (found) setTimings(known => ({ ...known, [text]: found }));
          });
        }
        return element.play();
      }).catch((error: unknown) => {
        // The browser refused to start audio without a fresh press: the clip is fine, so wait for one.
        if (error instanceof DOMException && error.name === 'NotAllowedError') {
          if (!current()) return;
          pause();
          onBlocked();
          return;
        }
        fallBack(index, error, from);
      });
    }

    // The whole paper's audio is prepared before the voice starts, so it plays through without waits.
    void fetchAll(start).then(() => next(start, fraction));
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

  const resumeFromSystem = useEffectEvent(() => play(paragraph ?? 0, progress));
  const seekFromSystem = useEffectEvent((details: MediaSessionActionDetails) => {
    if (details.action === 'seekto' && details.seekTime !== undefined) seek(details.seekTime);
    else seek(position + (details.action === 'seekbackward' ? -1 : 1) * (details.seekOffset ?? 15));
  });
  const listening = paragraph !== null;

  useEffect(() => {
    if (!listening || !('audioSession' in navigator)) return;
    const session = navigator.audioSession;
    if (!session || typeof session !== 'object' || !('type' in session) || typeof session.type !== 'string') return;
    const previous = session.type;
    session.type = 'playback';
    return () => { session.type = previous; };
  }, [listening]);

  useEffect(() => {
    if (!listening || !('mediaSession' in navigator)) return;
    const session = navigator.mediaSession;
    session.metadata = new MediaMetadata({ title, artist: 'PaperTok' });
    const handlers: [MediaSessionAction, MediaSessionActionHandler][] = [
      ['play', () => resumeFromSystem()],
      ['pause', pause],
      ['stop', reset],
      ['seekbackward', details => seekFromSystem(details)],
      ['seekforward', details => seekFromSystem(details)],
      ['seekto', details => seekFromSystem(details)],
    ];
    const registered: MediaSessionAction[] = [];
    for (const [action, handler] of handlers) {
      try {
        session.setActionHandler(action, handler);
        registered.push(action);
      } catch (error) {
        // Browsers can expose Media Session without supporting every action.
        if (!(error instanceof DOMException && error.name === 'NotSupportedError')) throw error;
      }
    }
    return () => {
      for (const action of registered) session.setActionHandler(action, null);
      session.metadata = null;
      session.playbackState = 'none';
      session.setPositionState?.();
    };
  }, [listening, title, pause, reset]);

  useEffect(() => {
    if (!listening || !('mediaSession' in navigator)) return;
    navigator.mediaSession.playbackState = playing ? 'playing' : 'paused';
    if (timeline.duration > 0) navigator.mediaSession.setPositionState?.({
      duration: timeline.duration,
      position: Math.min(position, timeline.duration),
      playbackRate: 1,
    });
  }, [listening, title, playing, position, timeline.duration]);

  /**
   * Where the voice is in the current passage now, read from the playing audio or the
   * browser voice's last word rather than from `position`, which moves a few times a second.
   */
  const live = useCallback(() => {
    const element = audio.current;
    const item = paragraph === null ? null : queue[paragraph];
    if (playing && voice.current === 'browser' && item) {
      const said = browserSentence.current;
      const chars = said.heard || !said.startedAt
        ? spokenChars.current
        : said.before + Math.min(said.length, ((performance.now() - said.startedAt) / 1000)
          * (pace.current.seconds > 0 ? pace.current.chars / pace.current.seconds : CHARS_PER_SECOND));
      return { seconds: null, fraction: chars / Math.max(1, passageText(item).length) };
    }
    if (playing && voice.current === 'audio' && element && Number.isFinite(element.duration) && element.duration > 0) {
      return { seconds: element.currentTime, fraction: element.currentTime / element.duration };
    }
    return { seconds: at ? progress * (at.end - at.start) : null, fraction: progress };
  }, [at, paragraph, playing, progress, queue]);

  /** The paper's audio as one MP3, its clips in reading order; only once every passage has one. */
  const audioFile = useCallback(async () => {
    const urls = await Promise.all(queue.map(item => clips.current.get(passageText(item)) ?? Promise.reject(new ReadAloudError('AI_AUDIO_NOT_STORED'))));
    const parts = await Promise.all(urls.map(url => fetch(url).then(response => response.blob())));
    return new Blob(parts, { type: 'audio/mpeg' });
  }, [queue]);

  return {
    timeline,
    timings,
    audioFile,
    live,
    /** How much of the paper's audio exists yet; `failed` once a passage was refused and the rest will not come. */
    prepared: { ready, total: queue.length, failed: prepareDone && ready < queue.length },
    paragraph,
    playing,
    position,
    /** Starts at `start` when nothing is under way yet, otherwise carries on from where it paused. */
    play: (start: number) => (paragraph === start ? play(start, progress) : play(start)),
    speed,
    /** The audio changes at once; the browser's voice from its next sentence. */
    setSpeed: (next: number) => {
      speedNow.current = next;
      setSpeedState(next);
      pace.current = { chars: 0, seconds: 0 };
      if (audio.current) audio.current.playbackRate = next;
    },
    pause,
    reset,
    seek,
  };
}
