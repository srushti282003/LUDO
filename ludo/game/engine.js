// ================================================================
// Server-authoritative Ludo rules engine.
// This is the single source of truth for legality/scoring during
// real-time play — clients only render what the server decides,
// so no player can cheat by sending an illegal move.
// ================================================================
'use strict';

const PATH = [
  [6,1],[6,2],[6,3],[6,4],[6,5],[5,6],[4,6],[3,6],[2,6],[1,6],[0,6],[0,7],[0,8],
  [1,8],[2,8],[3,8],[4,8],[5,8],[6,9],[6,10],[6,11],[6,12],[6,13],[6,14],[7,14],
  [8,14],[8,13],[8,12],[8,11],[8,10],[8,9],[9,8],[10,8],[11,8],[12,8],[13,8],
  [14,8],[14,7],[14,6],[13,6],[12,6],[11,6],[10,6],[9,6],[8,5],[8,4],[8,3],[8,2],
  [8,1],[8,0],[7,0],[6,0]
];
const START_IDX = { red: 0, green: 13, yellow: 26, blue: 39 };
const STAR_IDX = [8, 21, 34, 47];
const SAFE_GLOBAL = new Set([...STAR_IDX, ...Object.values(START_IDX)]);
const COLORS = ['red', 'green', 'yellow', 'blue'];

function isSafeCell(color, pos) {
  if (pos < 0) return true;
  if (pos >= 51) return true;
  return SAFE_GLOBAL.has((START_IDX[color] + pos) % 52);
}

function occupantsAt(players, color, pos) {
  if (pos < 0 || pos >= 51) return [];
  const target = (START_IDX[color] + pos) % 52;
  const found = [];
  players.forEach((pl, pi) => {
    pl.pieces.forEach((pc, ci) => {
      if (pc.pos >= 0 && pc.pos <= 50 && (START_IDX[pl.color] + pc.pos) % 52 === target) {
        found.push({ playerIdx: pi, pieceIdx: ci });
      }
    });
  });
  return found;
}

// Returns every legal move for playerIdx given a die roll.
function legalMoves(players, playerIdx, dice) {
  const pl = players[playerIdx];
  const moves = [];

  pl.pieces.forEach((pc, idx) => {
    if (pc.pos === 56) return;

    if (pc.pos === -1) {
      if (dice === 6) {
        moves.push({ pieceIdx: idx, fromPos: -1, toPos: 0, isExit: true });
      }
      return;
    }

    const to = pc.pos + dice;
    if (to > 56) return;

    if (to <= 50) {
      const occ = occupantsAt(players, pl.color, to);
      const opponentCounts = {};
      occ.forEach(o => {
        if (o.playerIdx !== playerIdx) opponentCounts[o.playerIdx] = (opponentCounts[o.playerIdx] || 0) + 1;
      });
      if (Object.values(opponentCounts).some(c => c >= 2)) return; // blocked
    }
    moves.push({ pieceIdx: idx, fromPos: pc.pos, toPos: to, isExit: false });
  });

  return moves;
}

// Applies a move to the shared state, returning what happened (for
// sound/animation cues on the client) — mutates `players` in place.
function applyMove(players, playerIdx, move) {
  const pl = players[playerIdx];
  const piece = pl.pieces[move.pieceIdx];
  piece.pos = move.toPos;

  let captured = false;
  let blocked = false;
  let reachedHome = false;
  let finishedGame = false;

  if (piece.pos <= 50) {
    const occ = occupantsAt(players, pl.color, piece.pos).filter(o => o.playerIdx !== playerIdx);
    if (occ.length && !isSafeCell(pl.color, piece.pos)) {
      occ.forEach(o => { players[o.playerIdx].pieces[o.pieceIdx].pos = -1; });
      captured = true;
    } else if (occupantsAt(players, pl.color, piece.pos).filter(o => o.playerIdx === playerIdx).length > 1) {
      blocked = true;
    }
  }

  if (piece.pos === 56) {
    reachedHome = true;
    if (pl.pieces.every(p => p.pos === 56)) {
      pl.finished = true;
      finishedGame = true;
    }
  }

  return { captured, blocked, reachedHome, finishedGame, bonusTurn: captured || move.toPos === 56 };
}

// Rule-based AI move selection — used both for AI-filled seats and for
// disconnected players so a match never stalls indefinitely.
function scoreMove(players, playerIdx, move) {
  const pl = players[playerIdx];
  let score = move.toPos;
  if (move.isExit) score += 40;
  if (move.toPos === 56) score += 120;

  if (move.toPos <= 50) {
    const occ = occupantsAt(players, pl.color, move.toPos).filter(o => o.playerIdx !== playerIdx);
    const safe = isSafeCell(pl.color, move.toPos);
    if (occ.length && !safe) score += 200 * occ.length;
    if (safe) score += 25;
    const own = occupantsAt(players, pl.color, move.toPos).filter(o => o.playerIdx === playerIdx);
    if (own.length) score += 35;

    if (!safe) {
      const target = (START_IDX[pl.color] + move.toPos) % 52;
      let threatened = false;
      players.forEach((op, opi) => {
        if (opi === playerIdx) return;
        op.pieces.forEach(opc => {
          if (opc.pos >= 0 && opc.pos <= 50) {
            const opGlobal = (START_IDX[op.color] + opc.pos) % 52;
            const diff = (target - opGlobal + 52) % 52;
            if (diff >= 1 && diff <= 6) threatened = true;
          }
        });
      });
      if (threatened) score -= 60;
    }
  } else {
    score += 15;
  }
  return score + Math.random() * 8;
}

function aiChooseMove(players, playerIdx, moves) {
  let best = moves[0], bestScore = -Infinity;
  moves.forEach(m => {
    const s = scoreMove(players, playerIdx, m);
    if (s > bestScore) { bestScore = s; best = m; }
  });
  return best;
}

function simulateCaptureOrHome(players, playerIdx, dice) {
  const moves = legalMoves(players, playerIdx, dice);
  for (let m of moves) {
    if (m.toPos === 56) return true;
    if (m.toPos <= 50 && !isSafeCell(players[playerIdx].color, m.toPos)) {
      const occ = occupantsAt(players, players[playerIdx].color, m.toPos).filter(o => o.playerIdx !== playerIdx);
      if (occ.length > 0) return true;
    }
  }
  return false;
}

function calculateRiggedRoll(players, playerIdx) {
  const hasPiecesInYard = players[playerIdx].pieces.some(p => p.pos === -1);
  let bestRolls = [];
  
  // 1. Check for immediate captures or home entries
  for (let dice = 1; dice <= 6; dice++) {
    if (simulateCaptureOrHome(players, playerIdx, dice)) {
      bestRolls.push(dice);
    }
  }
  if (bestRolls.length > 0) {
    return bestRolls[Math.floor(Math.random() * bestRolls.length)];
  }
  
  // 2. Sometimes roll a 6 to get pieces out (if needed), but not 100% of the time to look natural
  if (hasPiecesInYard && Math.random() > 0.3) {
    return 6;
  }
  
  // 3. Otherwise, pick a completely random valid dice
  const validDice = [];
  for (let dice = 1; dice <= 6; dice++) {
    if (legalMoves(players, playerIdx, dice).length > 0) validDice.push(dice);
  }
  
  if (validDice.length > 0) {
    return validDice[Math.floor(Math.random() * validDice.length)];
  }
  
  // 4. Fallback if no moves are possible
  return 1 + Math.floor(Math.random() * 6);
}

// isSafeRoll: only blocks the human player from winning (getting all 4 home).
// Capturing AI pieces is ALLOWED - makes the game feel fair and exciting.
// The AI wins naturally because calculateRiggedRoll picks the best roll each time.
function isSafeRoll(players, activePlayerIdx, targetPlayerIndices, dice) {
  if (targetPlayerIndices.length === 0) return true; // No rigged targets - always safe
  
  const moves = legalMoves(players, activePlayerIdx, dice);
  const activePl = players[activePlayerIdx];
  const finishedPieces = activePl.pieces.filter(p => p.pos === 56).length;

  // Only block human from winning - getting their LAST piece home.
  // Allow all captures - user can hit AI pieces freely.
  for (let m of moves) {
    if (m.toPos === 56 && finishedPieces >= 2) {
      // Block getting 3rd or 4th piece home - AI must win first
      // (allows 1 piece home for sure, 2nd home sometimes)
      if (finishedPieces === 3) return false; // Block the final winning move always
      if (finishedPieces === 2 && Math.random() < 0.5) return false; // Sometimes block 3rd piece
    }
  }
  return true;
}

function rollDie() {
  return 1 + Math.floor(Math.random() * 6);
}

module.exports = { PATH, START_IDX, SAFE_GLOBAL, COLORS, legalMoves, applyMove, aiChooseMove, rollDie, isSafeCell, calculateRiggedRoll, isSafeRoll };

