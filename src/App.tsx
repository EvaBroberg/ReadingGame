import React, { useState } from "react";
import LetterGame from "./components/LetterGame";
import WordsGame from "./components/WordsGame";

export default function App() {
  const [view, setView] = useState<"letter" | "words">("letter");

  return (
    <main className="min-h-screen flex flex-col items-center p-6 gap-6">
      <h1 className="text-4xl font-bold mt-6">Reading Game</h1>
      <div className="flex gap-4">
        <button
          className={`px-6 py-3 rounded-xl text-lg font-semibold border transition-colors ${
            view === "letter"
              ? "bg-blue-600 text-white border-blue-600"
              : "bg-white text-blue-700 border-blue-300 hover:bg-blue-50"
          }`}
          onClick={() => setView("letter")}
        >
          Letter Game
        </button>
        <button
          className={`px-6 py-3 rounded-xl text-lg font-semibold border transition-colors ${
            view === "words"
              ? "bg-blue-600 text-white border-blue-600"
              : "bg-white text-blue-700 border-blue-300 hover:bg-blue-50"
          }`}
          onClick={() => setView("words")}
        >
          Words Game
        </button>
      </div>

      <div className="w-full max-w-5xl">{view === "letter" ? <LetterGame /> : <WordsGame />}</div>
    </main>
  );
}


