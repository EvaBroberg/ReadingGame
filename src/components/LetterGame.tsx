import React, { useEffect, useState, useRef } from "react";
import { makeExhaustiveDeck } from "../engine/shuffle";
import { preloadLetterSounds, playLetterSound, playFeedback } from "../engine/speech";

const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");
const deck = makeExhaustiveDeck(letters);

export default function LetterGame() {
  const [target, setTarget] = useState(deck.next());
  const [flash, setFlash] = useState<"none" | "green" | "red">("none");
  const lastSpokenRef = useRef<string>("");

  // Preload once on mount
  useEffect(() => {
    preloadLetterSounds();
  }, []);

  useEffect(() => {
    if (lastSpokenRef.current === target) return;
    lastSpokenRef.current = target;
    void playLetterSound(target);
  }, [target]);

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      const key = e.key.toUpperCase();
      if (!letters.includes(key)) return;
      if (key === target) {
        playFeedback("success");
        setFlash("green");
        setTimeout(() => {
          setFlash("none");
          setTarget(deck.next());
        }, 350);
      } else {
        playFeedback("failure");
        setFlash("red");
        setTimeout(() => {
          setFlash("none");
          void playLetterSound(target);
        }, 350);
      }
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [target]);

  return (
    <div
      className={`flex flex-col items-center justify-center h-[70vh] w-full transition-colors duration-200 ${
        flash === "green"
          ? "bg-green-100"
          : flash === "red"
          ? "bg-red-100"
          : "bg-white"
      }`}
    >
      <div className="text-9xl font-bold text-gray-900">{target}</div>
      <p className="mt-8 text-gray-500 text-lg">Press the matching key!</p>
    </div>
  );
}


