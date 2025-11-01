import React, { useEffect, useMemo, useRef, useState } from "react";
import { playFeedback, playLetterSound } from "../engine/speech";

// Play arbitrary clip with m4a → mp3 fallback
function playClip(base: string): Promise<void> {
  return new Promise((resolve) => {
    const tryExt = (exts: string[]) => {
      if (exts.length === 0) return resolve();
      const [ext, ...rest] = exts;
      const el = new Audio(`/audio/${base}.${ext}`);
      el.onended = () => resolve();
      el.onerror = () => tryExt(rest);
      el.play().catch(() => tryExt(rest));
    };
    tryExt(["m4a", "mp3"]);
  });
}

// Play sound effect (correct/wrong) with m4a → mp3 fallback
// Throttles to prevent overlapping by restarting if already playing
const SOUND_EFFECT_VOLUME = 0.75; // SFX quieter to not overpower letters

let currentCorrectAudio: HTMLAudioElement | null = null;
let currentWrongAudio: HTMLAudioElement | null = null;

function playSoundEffect(kind: "correct" | "wrong"): void {
  const current = kind === "correct" ? currentCorrectAudio : currentWrongAudio;
  if (current) {
    current.currentTime = 0;
    current.volume = SOUND_EFFECT_VOLUME;
    current.play().catch(() => {});
    return;
  }

  const tryExt = (exts: string[]): void => {
    if (exts.length === 0) return;
    const [ext, ...rest] = exts;
    const el = new Audio(`/audio/sound_effects/${kind}.${ext}`);
    el.volume = SOUND_EFFECT_VOLUME;
    el.onerror = () => tryExt(rest);
    el.play().catch(() => tryExt(rest));
    
    if (kind === "correct") {
      currentCorrectAudio = el;
    } else {
      currentWrongAudio = el;
    }
    
    el.onended = () => {
      if (kind === "correct") {
        currentCorrectAudio = null;
      } else {
        currentWrongAudio = null;
      }
    };
  };
  tryExt(["m4a", "mp3"]);
}

const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");
type Word = "DOG" | "CAT";
const WORDS: Word[] = ["DOG", "CAT"];

// Type-ahead buffer configuration
const BUFFER_MAX = 16;
const BUFFER_ITEM_TTL_MS = 3000;
const KEY_REPEAT_GUARD_MS = 30;

// Key event stored in buffer
interface KeyEvent {
  key: string;
  t: number; // timestamp
}

// State machine phases
type Phase =
  | { type: "click_letter"; clickIndex: 0 | 1 | 2 }
  | { type: "blend_prefix"; k: 2 | 3 }
  | { type: "type_prefix"; k: 2 | 3 };

export default function WordsGame() {
  const [wordIndex, setWordIndex] = useState(0);
  const word = WORDS[wordIndex];
  const letters = useMemo(() => word.split(""), [word]); // [D, O, G] or [C, A, T]

  const [phase, setPhase] = useState<Phase>({ type: "click_letter", clickIndex: 0 });
  const [typedBuffer, setTypedBuffer] = useState<string>("");
  const [blendHighlightStep, setBlendHighlightStep] = useState<number>(0); // 0..k for blend_prefix
  const [typingCurrentIndex, setTypingCurrentIndex] = useState<number>(0); // Current position in typing sequence
  const [announcement, setAnnouncement] = useState<string>("");
  const [showImage, setShowImage] = useState<boolean>(false);

  // Type-ahead buffer (ring buffer with TTL)
  const keyBufferRef = useRef<KeyEvent[]>([]);
  const lastKeyRef = useRef<{ key: string; t: number } | null>(null);

  // Refs to track latest state for buffer processing (avoids stale closures)
  const phaseRef = useRef(phase);
  const typingCurrentIndexRef = useRef(typingCurrentIndex);
  const typedBufferRef = useRef(typedBuffer);
  const lettersRef = useRef(letters);

  // Timeout refs for blend animation
  const blendTimeoutsRef = useRef<number[]>([]);

  // Prevent duplicate auto plays
  const lastAutoRef = useRef<string>("");

  // Keep refs in sync with state
  useEffect(() => {
    phaseRef.current = phase;
  }, [phase]);
  useEffect(() => {
    typingCurrentIndexRef.current = typingCurrentIndex;
  }, [typingCurrentIndex]);
  useEffect(() => {
    typedBufferRef.current = typedBuffer;
  }, [typedBuffer]);
  useEffect(() => {
    lettersRef.current = letters;
  }, [letters]);

  // Clear all blend timeouts
  function clearBlendTimeouts() {
    blendTimeoutsRef.current.forEach((id) => window.clearTimeout(id));
    blendTimeoutsRef.current = [];
  }

  // Prune buffer: remove items older than TTL
  function pruneBuffer() {
    const now = Date.now();
    keyBufferRef.current = keyBufferRef.current.filter(
      (ev) => now - ev.t < BUFFER_ITEM_TTL_MS
    );
  }

  // Add key to buffer (ring buffer, drops oldest if at capacity)
  function addToBuffer(key: string) {
    const now = Date.now();
    pruneBuffer();

    // Key repeat guard: ignore repeats within 30ms for the same letter
    if (
      lastKeyRef.current &&
      lastKeyRef.current.key === key &&
      now - lastKeyRef.current.t < KEY_REPEAT_GUARD_MS
    ) {
      return;
    }

    lastKeyRef.current = { key, t: now };

    // Ring buffer: drop oldest if at capacity
    if (keyBufferRef.current.length >= BUFFER_MAX) {
      keyBufferRef.current.shift();
    }

    keyBufferRef.current.push({ key, t: now });
  }

  // Get expected letter for current state (uses latest refs)
  function getExpectedLetter(): string | null {
    const currentPhase = phaseRef.current;
    const currentLetters = lettersRef.current;
    if (currentPhase.type === "click_letter") {
      return currentLetters[currentPhase.clickIndex];
    } else if (currentPhase.type === "type_prefix") {
      const target = currentLetters.slice(0, currentPhase.k).join("");
      return target[typingCurrentIndexRef.current] || null;
    }
    return null;
  }

  // Process buffer: consume correct keys immediately, defer out-of-order keys (Strategy 1)
  function processBuffer() {
    pruneBuffer();
    const expected = getExpectedLetter();
    if (!expected) return;

    const currentPhase = phaseRef.current;

    // Strategy 1: Find earliest matching key in buffer (allows out-of-order input)
    const buffer = keyBufferRef.current;
    
    for (let i = 0; i < buffer.length; i++) {
      if (buffer[i].key === expected) {
        // Found matching key - consume it
        buffer.splice(i, 1);

        // Immediately advance state based on current phase
        if (currentPhase.type === "click_letter") {
          handleCorrectLetterClick(expected);
        } else if (currentPhase.type === "type_prefix") {
          handleCorrectType(expected);
        }

        // Continue processing buffer (recursive call)
        // This allows rapid typing: d,o,g all processed immediately
        processBuffer();
        break;
      }
    }

    // For wrong keys during click_letter or type_prefix: play wrong sound but don't consume from buffer
    // (Strategy 1: defer wrong keys that might become correct later)
    // Note: We don't actively check for wrong keys here - they just stay in buffer
  }

  // Advance to next state immediately (no delay)
  function advanceToNextPhase() {
    if (phase.type === "click_letter") {
      if (phase.clickIndex === 0) {
        setPhase({ type: "click_letter", clickIndex: 1 });
        setTypedBuffer("");
      } else if (phase.clickIndex === 1) {
        setPhase({ type: "blend_prefix", k: 2 });
        setTypedBuffer("");
      } else if (phase.clickIndex === 2) {
        setPhase({ type: "blend_prefix", k: 3 });
        setTypedBuffer("");
      }
    }
  }

  // Handle correct letter click - immediate advancement
  function handleCorrectLetterClick(ch: string) {
    playSoundEffect("correct");
    setAnnouncement("Correct");
    setTimeout(() => setAnnouncement(""), 1000);

    // Advance immediately (no delay)
    advanceToNextPhase();
    
    // Trigger audio/visual feedback asynchronously (doesn't block input)
    setTimeout(() => {
      // This delay is only for UX feedback, not for blocking input
    }, 100);
  }

  // Handle correct type - immediate advancement
  function handleCorrectType(ch: string) {
    playSoundEffect("correct");
    setAnnouncement("Correct");
    setTimeout(() => setAnnouncement(""), 1000);

    // Use ref to get latest typed buffer value
    const currentBuffer = typedBufferRef.current;
    const nextBuffer = currentBuffer + ch;
    setTypedBuffer(nextBuffer.toUpperCase());
    
    // Advance index immediately using callback to get latest value
    setTypingCurrentIndex((currentIdx) => {
      const nextIndex = currentIdx + 1;
      const currentPhase = phaseRef.current;
      
      // Type guard: ensure we're in type_prefix phase
      if (currentPhase.type === "type_prefix") {
        if (nextIndex === currentPhase.k) {
          // Typed prefix is complete - move to next phase immediately
          if (currentPhase.k === 2) {
            setPhase({ type: "click_letter", clickIndex: 2 });
            setTypedBuffer("");
            setTypingCurrentIndex(0);
            setShowImage(false);
          } else if (currentPhase.k === 3) {
            setShowImage(false);
            resetForNext();
          }
        }
      }
      
      return nextIndex;
    });
  }

  // Auto-pronounce and handle phase transitions
  useEffect(() => {
    const key = `${word}:${phase.type}:${"clickIndex" in phase ? phase.clickIndex : phase.k}`;
    if (lastAutoRef.current === key) return;
    lastAutoRef.current = key;

    if (phase.type === "click_letter") {
      void playLetterSound(letters[phase.clickIndex]);
    } else if (phase.type === "blend_prefix") {
      // Start prefix audio immediately
      const prefix = letters.slice(0, phase.k).join("");
      void playClip(prefix);

      // Show image when full word audio starts (k=3)
      if (phase.k === 3) {
        setShowImage(true);
      }

      // Start staggered animation
      clearBlendTimeouts();
      setBlendHighlightStep(0);

      // Schedule animation steps: +0s, +1s, +2s, then at +k seconds all turn red
      for (let i = 0; i < phase.k; i++) {
        const timeoutId = window.setTimeout(() => {
          setBlendHighlightStep(i + 1);
        }, i * 1000);
        blendTimeoutsRef.current.push(timeoutId);
      }

      // At +k seconds, all turn red and transition to typing
      const redTimeoutId = window.setTimeout(() => {
        setBlendHighlightStep(phase.k + 1); // "red" state
        setTimeout(() => {
          setPhase({ type: "type_prefix", k: phase.k });
          setTypedBuffer("");
          setTypingCurrentIndex(0);
          // Keep image visible during typing phase for full word (k=3)
          if (phase.k !== 3) {
            setShowImage(false);
          }
        }, 100);
      }, phase.k * 1000);
      blendTimeoutsRef.current.push(redTimeoutId);
    } else if (phase.type === "type_prefix") {
      // Typing phase - no auto audio
    }

    return () => clearBlendTimeouts();
  }, [phase, word, letters]);

  // Process buffer when state changes (allows queued keys to be consumed)
  useEffect(() => {
    // Process buffer after state settles (use setTimeout to avoid render cycle issues)
    const timer = setTimeout(() => {
      processBuffer();
    }, 0);
    return () => clearTimeout(timer);
  }, [phase, typingCurrentIndex, word, letters, typedBuffer]);

  // Physical keyboard handler - adds to buffer, processes immediately
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const ch = e.key.toUpperCase();
      if (!LETTERS.includes(ch)) return;
      e.preventDefault();
      e.stopPropagation();

      // Only accept input during click_letter or type_prefix phases
      // Use ref to get latest phase (avoids stale closure)
      if (phaseRef.current.type === "blend_prefix") return;

      const expected = getExpectedLetter();
      
      if (expected && ch === expected) {
        // Correct key - add to buffer and process immediately
        addToBuffer(ch);
        processBuffer();
      } else if (expected) {
        // Wrong key - give immediate feedback but don't block
        // For Strategy 1: still add to buffer (it might be correct later)
        // But also give wrong feedback now
        playSoundEffect("wrong");
        setAnnouncement("Try again");
        setTimeout(() => setAnnouncement(""), 1000);
        
        // Still add to buffer in case it becomes correct (e.g., typed O early, then D)
        addToBuffer(ch);
        // Don't process buffer here - let wrong keys stay until their turn
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []); // Empty deps - we use refs to get latest state

  // Reset for next word
  function resetForNext() {
    clearBlendTimeouts();
    // Clear type-ahead buffer
    keyBufferRef.current = [];
    lastKeyRef.current = null;
    setWordIndex((i) => (i + 1) % WORDS.length);
    setPhase({ type: "click_letter", clickIndex: 0 });
    setTypedBuffer("");
    setTypingCurrentIndex(0);
    setBlendHighlightStep(0);
    lastAutoRef.current = "";
    setAnnouncement("");
    setShowImage(false);
  }

  // Get image filename for current word
  const imageFilename = useMemo(() => {
    return `${word.toLowerCase()}.png`;
  }, [word]);


  // Color logic per letter based on current phase
  const colorForIndex = (idx: number): string => {
    if (phase.type === "click_letter") {
      // Only the current clickIndex letter is black, others gray
      return idx === phase.clickIndex ? "text-black" : "text-gray-300";
    }

    if (phase.type === "blend_prefix") {
      // Staggered highlight animation
      if (blendHighlightStep <= phase.k) {
        // During animation: letters up to step are black, others gray
        return idx < blendHighlightStep ? "text-black" : "text-gray-300";
      } else {
        // After animation: first k letters are red
        return idx < phase.k ? "text-red-600" : "text-gray-300";
      }
    }

    if (phase.type === "type_prefix") {
      // During typing: first k letters are red, others gray
      // The current target letter (typingCurrentIndex) should be more prominent
      return idx < phase.k ? "text-red-600" : "text-gray-300";
    }

    return "text-gray-300";
  };

  // Determine if a letter should pulsate (only during typing with 2+ letters total)
  const shouldPulsate = (idx: number): boolean => {
    if (phase.type !== "type_prefix") return false;
    // Pulse the current target letter if we're typing 2+ letters total
    return idx === typingCurrentIndex && phase.k >= 2;
  };

  // Get current target prefix for replay/display
  const currentPrefix = useMemo(() => {
    if (phase.type === "click_letter") {
      return letters[phase.clickIndex];
    } else if (phase.type === "blend_prefix" || phase.type === "type_prefix") {
      return letters.slice(0, phase.k).join("");
    }
    return "";
  }, [phase, letters]);

  return (
    <div className="flex flex-col items-center gap-6">
      {/* Accessibility announcement */}
      <div aria-live="polite" aria-atomic="true" className="sr-only">
        {announcement}
      </div>

      {/* Big word display */}
      <div className="flex gap-4 select-none">
        {letters.map((L, idx) => {
          const colorClass = colorForIndex(idx);
          const pulseClass = shouldPulsate(idx) ? "animate-pulse-slow" : "";
          const isTargetLetter = phase.type === "type_prefix" && idx === typingCurrentIndex;
          const boldClass = isTargetLetter ? "font-black" : "font-extrabold";
          
          return (
            <span
              key={idx}
              className={`text-7xl ${boldClass} ${colorClass} ${pulseClass}`}
            >
              {L}
            </span>
          );
        })}
      </div>

      {/* Word illustration - shown when full word audio plays */}
      {showImage && (
        <div className="flex justify-center">
          <img
            src={`/images/${imageFilename}`}
            alt={word}
            className="max-w-xs max-h-64 object-contain"
          />
        </div>
      )}

      {/* Replay button */}
      <div className="flex gap-3">
        <button
          className="px-4 py-2 rounded-lg bg-gray-100 hover:bg-gray-200 border"
          onClick={() => {
            if (phase.type === "click_letter") {
              void playLetterSound(letters[phase.clickIndex]);
            } else if (phase.type === "blend_prefix" || phase.type === "type_prefix") {
              void playClip(currentPrefix);
            }
          }}
          aria-label="Replay"
        >
          Replay
        </button>
      </div>

      {/* Click phase UI */}
      {phase.type === "click_letter" && (
        <>
          <p className="text-gray-600">
            Press: <span className="font-bold">{letters[phase.clickIndex]}</span>
          </p>
        </>
      )}

      {/* Typing phase UI */}
      {phase.type === "type_prefix" && (
        <>
          <p className="text-gray-600">
            Type: <span className="font-bold">{currentPrefix}</span>
          </p>
          <div className="text-3xl font-mono">{typedBuffer}</div>
        </>
      )}
    </div>
  );
}

