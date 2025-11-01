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

// --- Web Audio API setup for volume boost ---
let audioContext: AudioContext | null = null;
let letterGainNode: GainNode | null = null;
let feedbackGainNode: GainNode | null = null;
const mediaSources = new WeakMap<HTMLAudioElement, MediaElementAudioSourceNode>();

function initWebAudio() {
  if (audioContext) return audioContext;
  
  try {
    const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
    if (!AudioCtx) return null;
    
    audioContext = new AudioCtx();
    letterGainNode = audioContext.createGain();
    feedbackGainNode = audioContext.createGain();
    
    // Boost letters to 1.5x (50% louder), keep feedback at 0.75
    letterGainNode.gain.value = 1.5;
    feedbackGainNode.gain.value = 0.75;
    
    letterGainNode.connect(audioContext.destination);
    feedbackGainNode.connect(audioContext.destination);
    
    return audioContext;
  } catch {
    return null;
  }
}

async function resumeAudioContext(): Promise<void> {
  if (audioContext && audioContext.state === "suspended") {
    try {
      await audioContext.resume();
    } catch {
      // Ignore resume errors
    }
  }
}

function getOrCreateMediaSource(el: HTMLAudioElement, gainNode: GainNode): MediaElementAudioSourceNode | null {
  const ctx = audioContext;
  if (!ctx || ctx.state === "closed") return null;
  
  let source = mediaSources.get(el);
  if (!source) {
    try {
      source = ctx.createMediaElementSource(el);
      source.connect(gainNode);
      mediaSources.set(el, source);
    } catch {
      return null;
    }
  }
  return source;
}

// --- Cache & preload ---
const cache: Record<string, HTMLAudioElement | null> = {};
let didPreload = false;

export function preloadLetterSounds() {
  if (didPreload) return;
  initWebAudio(); // Initialize Web Audio if available
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

// Volume settings for balance adjustment
const VOLUMES = {
  letter: 1.0,      // Letters at full volume (HTMLAudioElement fallback)
  feedback: 0.75,   // SFX quieter to not overpower letters
};

export function playLetterSound(letter: string): Promise<void> {
  const L = letter.toUpperCase();
  const el = cache[L];
  return new Promise((resolve) => {
    if (!el) {
      ttsLetter(L);
      resolve();
      return;
    }
    
    // Try Web Audio API for boosted volume
    const ctx = initWebAudio();
    if (ctx && letterGainNode && ctx.state !== "closed") {
      void resumeAudioContext(); // Resume if suspended
      const source = getOrCreateMediaSource(el, letterGainNode);
      if (source) {
        try {
          el.currentTime = 0;
          el.onended = () => resolve();
          void el.play().catch(() => {
            // Fallback to HTMLAudioElement if Web Audio fails
            el.volume = VOLUMES.letter;
            void el.play().catch(() => { ttsLetter(L); resolve(); });
          });
          return;
        } catch {
          // Fall through to HTMLAudioElement fallback
        }
      }
    }
    
    // Fallback to HTMLAudioElement
    try {
      el.currentTime = 0;
      el.volume = VOLUMES.letter;
      el.onended = () => resolve();
      void el.play().catch(() => { ttsLetter(L); resolve(); });
    } catch {
      ttsLetter(L);
      resolve();
    }
  });
}

export function playFeedback(kind: "success" | "failure") {
  const el = cache[kind];
  if (!el) return;
  
  // Try Web Audio API
  const ctx = initWebAudio();
  if (ctx && feedbackGainNode && ctx.state !== "closed") {
    void resumeAudioContext(); // Resume if suspended
    const source = getOrCreateMediaSource(el, feedbackGainNode);
    if (source) {
      try {
        el.currentTime = 0;
        void el.play();
        return;
      } catch {
        // Fall through to HTMLAudioElement fallback
      }
    }
  }
  
  // Fallback to HTMLAudioElement
  try {
    el.currentTime = 0;
    el.volume = VOLUMES.feedback;
    void el.play();
  } catch {}
}

