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
const SOUND_EFFECT_VOLUME = 0.8; // SFX slightly quieter to not overpower letters

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

  // Timeout refs for blend animation
  const blendTimeoutsRef = useRef<number[]>([]);

  // Prevent duplicate auto plays
  const lastAutoRef = useRef<string>("");

  // Clear all blend timeouts
  function clearBlendTimeouts() {
    blendTimeoutsRef.current.forEach((id) => window.clearTimeout(id));
    blendTimeoutsRef.current = [];
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

  // Physical keyboard for both clicking and typing
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const ch = e.key.toUpperCase();
      if (!LETTERS.includes(ch)) return;
      e.preventDefault();
      e.stopPropagation();

      if (phase.type === "click_letter") {
        handleLetterClick(ch);
      } else if (phase.type === "type_prefix") {
        handleType(ch);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [phase, typedBuffer, typingCurrentIndex, word, letters]);

  // Reset for next word
  function resetForNext() {
    clearBlendTimeouts();
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

  // Handle letter click during click_letter phase
  function handleLetterClick(ch: string) {
    if (phase.type !== "click_letter") return;

    const need = letters[phase.clickIndex];
    if (ch !== need) {
      playSoundEffect("wrong");
      setAnnouncement("Try again");
      setTimeout(() => setAnnouncement(""), 1000);
      void playLetterSound(need);
      return;
    }

    playSoundEffect("correct");
    setAnnouncement("Correct");
    setTimeout(() => setAnnouncement(""), 1000);

    // After correct click, wait 1.5s before advancing
    setTimeout(() => {
      if (phase.clickIndex === 0) {
        // First letter clicked → move to second letter click
        setPhase({ type: "click_letter", clickIndex: 1 });
        setTypedBuffer("");
      } else if (phase.clickIndex === 1) {
        // Second letter clicked → start blend_prefix(k=2)
        setPhase({ type: "blend_prefix", k: 2 });
        setTypedBuffer("");
      } else if (phase.clickIndex === 2) {
        // Third letter clicked → start blend_prefix(k=3)
        setPhase({ type: "blend_prefix", k: 3 });
        setTypedBuffer("");
      }
    }, 1500);
  }

  // Handle typing during type_prefix phase
  function handleType(ch: string) {
    if (phase.type !== "type_prefix") return;

    const target = letters.slice(0, phase.k).join("").toUpperCase();
    const expectedLetter = target[typingCurrentIndex];
    const pressed = ch.toUpperCase();

    if (pressed !== expectedLetter) {
      // Wrong key
      playSoundEffect("wrong");
      setAnnouncement("Try again");
      setTimeout(() => setAnnouncement(""), 1000);
      return;
    }

    // Correct key
    playSoundEffect("correct");
    setAnnouncement("Correct");
    setTimeout(() => setAnnouncement(""), 1000);

    const nextBuffer = typedBuffer + ch;
    setTypedBuffer(nextBuffer.toUpperCase());

    // Wait 1.5s before advancing to next letter
    setTimeout(() => {
      setTypingCurrentIndex(typingCurrentIndex + 1);

      if (typingCurrentIndex + 1 === phase.k) {
        // Typed prefix is complete - move to next phase
        if (phase.k === 2) {
          // After typing 2-letter prefix → move to third letter click
          setPhase({ type: "click_letter", clickIndex: 2 });
          setTypedBuffer("");
          setTypingCurrentIndex(0);
          setShowImage(false);
        } else if (phase.k === 3) {
          // After typing full word → hide image and advance to next word
          setShowImage(false);
          resetForNext();
        }
      }
    }, 1500);
  }

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

