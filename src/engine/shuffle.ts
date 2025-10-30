export function makeExhaustiveDeck<T>(items: T[]) {
  let deck = [...items];
  function shuffle() {
    for (let i = deck.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [deck[i], deck[j]] = [deck[j], deck[i]];
    }
  }
  shuffle();
  return {
    next() {
      if (deck.length === 0) {
        deck = [...items];
        shuffle();
      }
      return deck.pop()!;
    },
  };
}


