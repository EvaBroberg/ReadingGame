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
  }, [phase, typedBuffer, word]);

  // Reset for next word
  function resetForNext() {
    clearBlendTimeouts();
    setWordIndex((i) => (i + 1) % WORDS.length);
    setPhase({ type: "click_letter", clickIndex: 0 });
    setTypedBuffer("");
    setBlendHighlightStep(0);
    lastAutoRef.current = "";
  }

  // Handle letter click during click_letter phase
  function handleLetterClick(ch: string) {
    if (phase.type !== "click_letter") return;

    const need = letters[phase.clickIndex];
    if (ch !== need) {
      playFeedback("failure");
      void playLetterSound(need);
      return;
    }

    playFeedback("success");

    // After correct click, advance logic
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
  }

  // Handle typing during type_prefix phase
  function handleType(ch: string) {
    if (phase.type !== "type_prefix") return;

    const target = letters.slice(0, phase.k).join("").toUpperCase();
    const next = (typedBuffer + ch).toUpperCase();

    if (!target.startsWith(next)) {
      playFeedback("failure");
      return;
    }

    setTypedBuffer(next);
    playFeedback("success");

    if (next === target) {
      // Typed prefix is complete
      if (phase.k === 2) {
        // After typing 2-letter prefix → move to third letter click
        setPhase({ type: "click_letter", clickIndex: 2 });
        setTypedBuffer("");
      } else if (phase.k === 3) {
        // After typing full word → advance to next word
        setTimeout(() => resetForNext(), 350);
      }
    }
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
      return idx < phase.k ? "text-red-600" : "text-gray-300";
    }

    return "text-gray-300";
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
      {/* Big word display */}
      <div className="flex gap-4 select-none">
        {letters.map((L, idx) => (
          <span key={idx} className={`text-7xl font-extrabold ${colorForIndex(idx)}`}>
            {L}
          </span>
        ))}
      </div>

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
            Click: <span className="font-bold">{letters[phase.clickIndex]}</span>
          </p>
          <AlphabetGrid onClick={handleLetterClick} />
        </>
      )}

      {/* Typing phase UI */}
      {phase.type === "type_prefix" && (
        <>
          <p className="text-gray-600">
            Type: <span className="font-bold">{currentPrefix}</span>
          </p>
          <div className="text-3xl font-mono">{typedBuffer}</div>
          <OnscreenKeyboard onPress={handleType} />
        </>
      )}
    </div>
  );
}

// Simple A–Z grid for clicking letters
function AlphabetGrid({ onClick }: { onClick: (ch: string) => void }) {
  return (
    <div className="grid grid-cols-7 gap-2 max-w-[600px]">
      {LETTERS.map((L) => (
        <button
          key={L}
          onClick={() => onClick(L)}
          className="px-3 py-2 text-xl rounded-lg bg-white border hover:bg-gray-100"
          aria-label={`Letter ${L}`}
        >
          {L}
        </button>
      ))}
    </div>
  );
}

// On-screen keyboard (A–Z) for typing
function OnscreenKeyboard({ onPress }: { onPress: (ch: string) => void }) {
  return (
    <div className="grid grid-cols-7 gap-2 max-w-[600px]">
      {LETTERS.map((L) => (
        <button
          key={L}
          onClick={() => onPress(L)}
          className="px-3 py-2 text-xl rounded-lg bg-white border hover:bg-gray-100"
          aria-label={`Key ${L}`}
        >
          {L}
        </button>
      ))}
    </div>
  );
}
