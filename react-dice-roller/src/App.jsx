import { useState } from 'react';

const API_URL = import.meta.env.VITE_API_URL;

const diceFaces = ['⚀', '⚁', '⚂', '⚃', '⚄', '⚅'];

function App() {
  const [currentPlayer, setCurrentPlayer] = useState(1);
  const [diceValue, setDiceValue] = useState(1);
  const [isRolling, setIsRolling] = useState(false);
  const [message, setMessage] = useState("Roll to start!");

  const handleRoll = () => {
    if (isRolling) return; // Block spam

    setIsRolling(true);
    setMessage("Rolling...");

    // Visual animation effect — min 800ms (8 ticks × 100ms)
    let ticks = 0;
    const spinInterval = setInterval(() => {
      setDiceValue(Math.floor(Math.random() * 6) + 1);
      ticks++;
      if (ticks >= 8) {
        clearInterval(spinInterval);
        finishRoll();
      }
    }, 100);
  };

  const finishRoll = () => {
    const finalRoll = Math.floor(Math.random() * 6) + 1;
    setDiceValue(finalRoll);

    if (finalRoll === 6) {
      // Player rolled 6 — gets an extra turn, does NOT switch player
      setMessage(`Player ${currentPlayer} rolled a 6! Extra turn.`);
      setIsRolling(false);
    } else {
      setMessage(`Player ${currentPlayer} rolled a ${finalRoll}. Next player's turn.`);
      // Switch player only after non-6 roll, with a short delay
      setTimeout(() => {
        setCurrentPlayer(prev => prev === 1 ? 2 : 1);
        setMessage(`Player ${currentPlayer === 1 ? 2 : 1}'s turn`);
        setIsRolling(false);
      }, 1500);
    }
  };

  return (
    <div className="container">
      <div className={`player-indicator ${currentPlayer === 1 ? 'p1' : 'p2'}`}>
        Player {currentPlayer}'s Turn
      </div>

      <div className={`dice ${isRolling ? 'rolling-animation' : ''}`}>
        {diceFaces[diceValue - 1]}
      </div>

      <button onClick={handleRoll} disabled={isRolling}>
        {isRolling ? 'Rolling...' : 'Roll Dice'}
      </button>

      <div className="status">
        {message}
      </div>
    </div>
  );
}

export default App;
