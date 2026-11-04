/**
 * Sentence TTS: xAI stock voice "rex" via the musk-atlas-tts Worker (key stays server-side, audio cached in R2),
 * falling back to the browser's own speech synthesis. Never a cloned / Musk voice.
 */
import { useSyncExternalStore } from "react";

export const TTS_URL = "https://musk-atlas-tts.yuanzhevc.workers.dev";
const RATE_KEY = "musk-atlas:reader:rate";
export const RATES = [0.75, 0.9, 1, 1.25, 1.5];

type State = { sid: number | null; loading: boolean; src: "xai" | "browser" | null; rate: number; auto: boolean };
let state: State = { sid: null, loading: false, src: null, rate: Number(localStorage.getItem(RATE_KEY)) || 1, auto: false };
const subs = new Set<() => void>();
const set = (p: Partial<State>) => {
  state = { ...state, ...p };
  subs.forEach((f) => f());
};
export const useTts = () =>
  useSyncExternalStore(
    (f) => {
      subs.add(f);
      return () => subs.delete(f);
    },
    () => state,
  );

const blobs = new Map<string, Promise<string>>();
/** Fetch (and memoize) the Worker's MP3 for a sentence as a blob URL. */
export function prefetch(text: string): Promise<string> {
  const t = text.replace(/\s+/g, " ").trim().slice(0, 600);
  if (!blobs.has(t)) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 12000);
    blobs.set(
      t,
      fetch(TTS_URL, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: t }), signal: ctl.signal })
        .then(async (r) => {
          if (!r.ok) throw new Error(`tts ${r.status}`);
          return URL.createObjectURL(await r.blob());
        })
        .catch((e) => {
          blobs.delete(t);
          throw e;
        })
        .finally(() => clearTimeout(timer)),
    );
  }
  return blobs.get(t)!;
}

let audio: HTMLAudioElement | null = null;
let run = 0;

function browserSpeak(text: string, rate: number, my: number): Promise<void> {
  return new Promise((res) => {
    try {
      const u = new SpeechSynthesisUtterance(text);
      u.lang = "en-US";
      u.rate = rate * 0.95;
      u.onend = u.onerror = () => res();
      // Some browsers never fire onend (no voices installed): don't stall 连续播放.
      setTimeout(res, (text.split(/\s+/).length * 420) / rate + 1500);
      speechSynthesis.cancel();
      speechSynthesis.speak(u);
      if (my !== run) res();
    } catch {
      res();
    }
  });
}

export const tts = {
  setRate(r: number) {
    localStorage.setItem(RATE_KEY, String(r));
    set({ rate: r });
    if (audio) audio.playbackRate = r;
  },
  setAuto: (auto: boolean) => set({ auto }),
  stop() {
    run++;
    audio?.pause();
    try {
      speechSynthesis.cancel();
    } catch {
      /* */
    }
    set({ sid: null, loading: false, src: null, auto: false });
  },
  /** Play one sentence; resolves true when it finished, false when interrupted. */
  async play(sid: number, text: string): Promise<boolean> {
    const my = ++run;
    audio?.pause();
    try {
      speechSynthesis.cancel();
    } catch {
      /* */
    }
    if (!audio) {
      audio = new Audio();
      (window as unknown as { __ttsAudio?: HTMLAudioElement }).__ttsAudio = audio;
      (audio as HTMLAudioElement & { preservesPitch?: boolean }).preservesPitch = true;
    }
    set({ sid, loading: true });
    let url: string | null = null;
    try {
      url = await prefetch(text);
    } catch {
      url = null;
    }
    if (my !== run) return false;
    if (url) {
      const a = audio;
      a.src = url;
      a.playbackRate = state.rate;
      set({ loading: false, src: "xai" });
      let failed = false;
      const ok = await new Promise<boolean>((res) => {
        a.onended = () => res(true);
        a.onerror = () => ((failed = true), res(false));
        a.onpause = () => !a.ended && res(false);
        a.play().catch(() => ((failed = true), res(false)));
      });
      if (my !== run) return false;
      if (ok) return true;
      if (!failed) return false; // paused by the user
    }
    set({ loading: false, src: "browser" });
    await browserSpeak(text, state.rate, my);
    return my === run;
  },
};
