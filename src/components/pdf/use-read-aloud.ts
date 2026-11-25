import type { CharacterTimings, ReadAloudChapter, SpokenPassage } from './read-aloud.ts';
import { useCallback, useEffect, useEffectEvent, useMemo, useRef, useState } from 'react';
import { CHARS_PER_SECOND, locateInListen, passageText, readAloudTimeline } from './read-aloud.ts';
import { ReadAloudError, fetchParagraphAudio, fetchParagraphTimings } from '../../services/read-aloud-service.ts';

const hasBrowserVoice = () => typeof window !== 'undefined' && 'speechSynthesis' in window;
// Two background requests leave a third slot for a seek to an uncached passage.
const WORKERS = 2;
const STARTUP_PASSAGES = 3;
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

export function useReadAloud(queue: SpokenPassage[], chapters: ReadAloudChapter[], { title, paperId, onFallback, onError, onBlocked }: {
  title: string;
  /** The paper the passages are from: its first new audio of the day counts against the account's papers. */
  paperId?: string;
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
  const [startup, setStartup] = useState<{ start: number; ready: number; total: number; failed: boolean } | null>(null);
  const [buffering, setBuffering] = useState(false);
  const run = useRef(0);
  const audio = useRef<HTMLAudioElement | null>(null);
  const clips = useRef(new Map<string, Promise<string>>());
  // The name each passage's audio is stored under, as the Worker gave it.
  const audioKeys = useRef(new Map<string, string>());
  const fetches = useRef<AbortController | null>(null);
  // The voice refused for want of credits: from then on, stored audio only.
  const storedOnly = useRef(false);
  const activeRequests = useRef(0);
  const waitingRequests = useRef<Array<() => void>>([]);
  const told = useRef(false);
  // The queue whose passages are being fetched in full; a new queue starts over.
  /**
   * The paper's audio being fetched: what is left, in the order wanted, what has settled, and the
   * first passages the tab opened at, which its progress counts.
   */
  const fetchingAll = useRef<{
    items: SpokenPassage[];
    remaining: SpokenPassage[];
    settled: Set<SpokenPassage>;
    start: number;
    initial: SpokenPassage[];
    opening: boolean;
  } | null>(null);
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
    setBuffering(false);
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

  const request = async (text: string) => {
    await new Promise<void>((resolve) => {
      if (activeRequests.current < WORKERS + 1) {
        activeRequests.current += 1;
        resolve();
      } else waitingRequests.current.push(resolve);
    });
    try {
      for (let attempt = 0; ; attempt += 1) {
        fetches.current?.signal.throwIfAborted();
        try {
          return await fetchParagraphAudio(text, { signal: fetches.current?.signal, storedOnly: storedOnly.current, paperId });
        } catch (error) {
          if (error instanceof ReadAloudError && error.code === 'AI_QUOTA_EXHAUSTED') storedOnly.current = true;
          if (!(error instanceof ReadAloudError && error.code === 'AI_BUSY') || attempt >= BUSY_RETRIES) throw error;
          await wait(800 * (attempt + 1));
        }
      }
    } finally {
      const next = waitingRequests.current.shift();
      if (next) next();
      else activeRequests.current -= 1;
    }
  };

  const clip = (item: SpokenPassage) => {
    const text = passageText(item);
    const known = clips.current.get(text);
    if (known) return known;
    const pending = request(text).then(({ blob, key }) => {
      fetches.current?.signal.throwIfAborted();
      if (key) audioKeys.current.set(text, key);
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

  /** The first passages a tab opened at `start` prepares before Play is offered. */
  const firstPassages = (start: number) => queue.slice(start, start + STARTUP_PASSAGES);

  const reportStartup = (batch: NonNullable<typeof fetchingAll.current>, failed = false) => {
    if (!batch.opening) return;
    const ready = batch.initial.filter(item => batch.settled.has(item)).length;
    setStartup({ start: batch.start, ready, total: batch.initial.length, failed });
  };

  const fetchAll = (start: number, opening = false) => {
    const order = (items: SpokenPassage[]) => [...items.slice(start), ...items.slice(0, start)];
    const running = fetchingAll.current;
    // Already fetching this paper: what is left comes from the new place, and a tab opened there
    // counts its own first passages, those already settled included, not the last opening's.
    if (running?.items === queue) {
      const pending = new Set(running.remaining);
      running.remaining = order(queue).filter(item => pending.has(item));
      if (opening) Object.assign(running, { opening, start, initial: firstPassages(start) });
      reportStartup(running);
      return;
    }
    const batch = { items: queue, remaining: order(queue), settled: new Set<SpokenPassage>(), start, initial: firstPassages(start), opening };
    fetchingAll.current = batch;
    setPrepareDone(false);
    reportStartup(batch);
    let stopped = false;
    let working = WORKERS;
    const work = async () => {
      while (!stopped && batch.remaining.length && fetchingAll.current === batch && !fetches.current?.signal.aborted) {
        const item = batch.remaining.shift();
        if (!item) break;
        try {
          await clip(item);
        } catch (error) {
          if (!skippable(error)) {
            stopped = true;
            if (fetchingAll.current === batch) {
              fetchingAll.current = null;
              setPrepareDone(true);
              reportStartup(batch, true);
            }
          }
        }
        batch.settled.add(item);
        if (fetchingAll.current === batch) reportStartup(batch);
      }
      working -= 1;
      if (working === 0 && fetchingAll.current === batch) setPrepareDone(true);
    };
    for (let count = 0; count < WORKERS; count += 1) void work();
  };

  /** `storedOnly`: PaperTok's voice only where its audio is stored, the browser's for the rest. */
  const prepare = (start: number, { storedOnly: onlyStored = false } = {}) => {
    if (onlyStored) storedOnly.current = true;
    setParagraph(start);
    setProgress(0);
    fetchAll(start, true);
  };

  const play = (start: number, fraction = 0) => {
    if (startup && !startup.failed && startup.ready < startup.total) return;
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
      if (!line.trim()) {
        speakWithBrowser(index, sentence + 1);
        return;
      }
      const utterance = new SpeechSynthesisUtterance(line);
      utterance.lang = 'en-US';
      utterance.rate = speedNow.current;
      const before = item.utterances.slice(0, sentence).reduce((sum, text) => sum + text.length + 1, 0) + skip;
      voice.current = 'browser';
      setBuffering(false);
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
        // A voice that ends a sentence it never started said nothing (Chrome does this when its speech
        // service fails); moving on would race the clock through the paper, so it stops and says so.
        if (!said.startedAt) {
          pause();
          onError();
          return;
        }
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
      setBuffering(true);
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
        // From where the clip had got to, so the browser's voice carries on rather than going back.
        element.onerror = () => fallBack(index, element.error, Number.isFinite(element.duration) && element.duration > 0 ? element.currentTime / element.duration : from);
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
        return element.play().then(() => { if (current()) setBuffering(false); });
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

    fetchAll(start);
    next(start, fraction);
  };

  const at = paragraph === null ? null : timeline.passages[paragraph];
  const position = at ? at.start + progress * (at.end - at.start) : 0;

  const seek = (seconds: number) => {
    if (!queue.length) return;
    const target = locateInListen(timeline, Math.min(Math.max(0, seconds), timeline.duration));
    if (playing) play(target.index, target.fraction);
    else {
      setParagraph(target.index);
      setProgress(target.fraction);
      const token = ++run.current;
      setBuffering(true);
      fetchAll(target.index);
      void clip(queue[target.index]).catch(() => undefined).finally(() => {
        if (token === run.current) setBuffering(false);
      });
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
  /** The stored name of every passage's audio, or null while one has none. */
  const storedNames = useCallback(() => {
    const keys = queue.map(item => audioKeys.current.get(passageText(item)));
    return keys.every((key): key is string => Boolean(key)) ? keys : null;
  }, [queue]);

  const audioFile = useCallback(async () => {
    const urls = await Promise.all(queue.map(item => clips.current.get(passageText(item)) ?? Promise.reject(new ReadAloudError('AI_AUDIO_NOT_STORED'))));
    const parts = await Promise.all(urls.map(url => fetch(url).then(response => response.blob())));
    return new Blob(parts, { type: 'audio/mpeg' });
  }, [queue]);

  return {
    timeline,
    timings,
    prepare,
    buffering,
    startup: startup ?? { start: 0, ready: 0, total: Math.min(STARTUP_PASSAGES, queue.length), failed: false },
    audioFile,
    audioKeys: storedNames,
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
