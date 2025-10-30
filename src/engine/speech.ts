// src/engine/speech.ts

// --- Phonics for TTS fallback only (used if no audio can play) ---
type Phon = { name: string; sound: string };
const PHONICS: Record<string, Phon> = {
  A: { name: "ay",  sound: "ah" },  B: { name: "bee", sound: "buh" }, C: { name: "see", sound: "kuh" },
  D: { name: "dee", sound: "duh" }, E: { name: "ee",  sound: "eh" },  F: { name: "ef",  sound: "fff" },
  G: { name: "jee", sound: "guh" }, H: { name: "aitch", sound: "hhh" }, I: { name: "eye", sound: "ih" },
  J: { name: "jay", sound: "juh" }, K: { name: "kay", sound: "kuh" },  L: { name: "el",  sound: "lll" },
  M: { name: "em",  sound: "mmm" }, N: { name: "en",  sound: "nnn" },  O: { name: "oh",  sound: "aw" },
  P: { name: "pee", sound: "puh" }, Q: { name: "cue", sound: "kw" },   R: { name: "ar",  sound: "rrr" },
  S: { name: "es",  sound: "sss" }, T: { name: "tee", sound: "tuh" },  U: { name: "you", sound: "uh" },
  V: { name: "vee", sound: "vvv" }, W: { name: "double you", sound: "wuh" },
  X: { name: "ex",  sound: "ks" },  Y: { name: "why", sound: "yuh" },  Z: { name: "zee", sound: "zzz" },
};

function ttsLetter(letter: string) {
  try {
    const p = PHONICS[letter];
    const u = new SpeechSynthesisUtterance(p ? `${letter}, ${p.name}. ${p.sound}` : letter);
    u.rate = 0.9;
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(u);
  } catch {}
}

// --- Audio support + resolution ---
const testEl = typeof Audio !== "undefined" ? new Audio() : null;

function canPlay(ext: "m4a" | "mp3"): boolean {
  if (!testEl) return false;
  const type = ext === "m4a" ? "audio/mp4; codecs=mp4a.40.2" : "audio/mpeg";
  const res = testEl.canPlayType(type);
  return res === "probably" || res === "maybe";
}

function resolveUrl(base: string): string | null {
  if (canPlay("m4a")) return `/audio/${base}.m4a`;
  if (canPlay("mp3")) return `/audio/${base}.mp3`;
  return null; // forces TTS
}

// --- Cache & preload ---
const cache: Record<string, HTMLAudioElement | null> = {};
let didPreload = false;

export function preloadLetterSounds() {
  if (didPreload) return;
  const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");
  for (const L of letters) {
    const url = resolveUrl(L);
    cache[L] = url ? new Audio(url) : null;
    if (cache[L]) {
      cache[L]!.preload = "auto";
      cache[L]!.load();
    }
  }
  for (const name of ["success", "failure"]) {
    const url = resolveUrl(name);
    cache[name] = url ? new Audio(url) : null;
    if (cache[name]) {
      cache[name]!.preload = "auto";
      cache[name]!.load();
    }
  }
  didPreload = true;
}

export function playLetterSound(letter: string): Promise<void> {
  const L = letter.toUpperCase();
  const el = cache[L];
  return new Promise((resolve) => {
    if (el) {
      try {
        el.currentTime = 0;
        el.onended = () => resolve();
        void el.play().catch(() => { ttsLetter(L); resolve(); });
      } catch {
        ttsLetter(L); resolve();
      }
    } else {
      ttsLetter(L); resolve();
    }
  });
}

export function playFeedback(kind: "success" | "failure") {
  const el = cache[kind];
  if (!el) return;
  try {
    el.currentTime = 0;
    void el.play();
  } catch {}
}
// src/engine/speech.ts

