// ================================================================
// Room + matchmaking manager.
//
// Design goals (per requirements):
//  - Unlimited concurrent rooms: rooms are plain objects in a Map,
//    created on demand — nothing here caps how many can exist at once;
//    the only real ceiling is the host machine's memory/CPU.
//  - Unlimited users: any number of sockets may queue or spectate;
//    there's no user allow-list or seat cap beyond each room's own size.
//  - Fast game start: a room finalizes and begins as soon as its seats
//    are full, OR after a short auto-fill timeout — whichever comes first —
//    so nobody waits long for a match even if few humans are online.
// ================================================================
'use strict';

const engine = require('./engine');

const AUTO_FILL_MS = 12000;      // longest a queued player waits before AI fills empty seats
const TURN_AI_DELAY_MS = 1600;    // "thinking time" for AI / auto-played turns
const DISCONNECT_GRACE_MS = 20000; // time a human seat stays reserved before an AI takes over

const rooms = new Map();          // roomId -> room object
const queues = {}; // e.g. { '2_50': [], '4_100': [] } -> waiting entries
let roomCounter = 1;

function makeRoomId() {
  return 'room-' + (roomCounter++) + '-' + Math.random().toString(36).slice(2, 7);
}

// ---------------------------------------------------------------
// Matchmaking queue processing — runs continuously so any number of
// independent queues (one per room size) can each spawn rooms the
// moment they're ready, without blocking one another.
// ---------------------------------------------------------------
// ---------------------------------------------------------------
// Matchmaking queue processing — runs continuously so any number of
// independent queues (one per room size) can each spawn rooms the
// moment they're ready, without blocking one another.
//
// Player Type Isolation Rules:
//  - 'admin'  : admin plays only with normal humans. No AI fill. No rigged players.
//  - 'rigged' : ### players play only with normal humans. No AI fill. No admin.
//  - 'normal' : regular humans. AI fills empty seats after timeout.
// ---------------------------------------------------------------
function processQueues(io) {
  Object.keys(queues).forEach(queueKey => {
    const q = queues[queueKey];
    if (q.length === 0) return;

    const parts = queueKey.split('_');
    const size = parseInt(parts[0], 10);
    const entryFee = parseInt(parts[1], 10);
    const playerType = parts[2] || 'normal'; // 'admin' | 'rigged' | 'normal'

    const oldestWait = Date.now() - q[0].joinedAt;
    
    // Always reserve at least 1 seat for AI. Fill rest with AI after timeout.
    const maxHumans = size - 1;
    const timedOut = oldestWait >= AUTO_FILL_MS;
    if (q.length >= maxHumans || timedOut) {
      const taken = q.splice(0, maxHumans);
      createRoomFromQueue(io, size, entryFee, taken);
    }
  });
}

function createRoomFromQueue(io, size, entryFee, entries) {
  const colors = engine.COLORS.slice(0, size);
  const id = makeRoomId();

  let addedRiggedAI = false;
  let availableAiNames = ['Alexx', 'Maxx', 'Rahulx', 'Samx', 'Johnx', 'Ronnx', 'Devx'];
  // Shuffle names
  availableAiNames.sort(() => Math.random() - 0.5);

  const seats = colors.map((color, i) => {
    const entry = entries[i];
    if (entry) {
      return {
        color, isAI: false, connected: true,
        socketId: entry.socket.id, userId: entry.userId || null,
        name: entry.isAdmin ? 'JKing28$' : (entry.name || ('Player ' + (i + 1))).slice(0, 20),
        isAdmin: entry.isAdmin, isRigged: entry.isRigged
      };
    }
    const randomAiName = availableAiNames.pop() || 'Bot' + Math.floor(Math.random() * 100);
    
    // The first AI added to the game is the rigged one (always wins)
    // Any other AIs added (e.g. in 4 player game with 2 AIs) will be normal/weak
    const rigThisAi = !addedRiggedAI;
    addedRiggedAI = true;
    
    return { color, isAI: true, connected: true, socketId: null, userId: null, name: randomAiName, isAdmin: false, isRigged: rigThisAi };
  });

  // Deduct entry fees asynchronously
  (async () => {
    try {
      const User = require('../models/User');
      const Transaction = require('../models/Transaction');
      for (const entry of entries) {
        if (entry && entry.userId) {
          const user = await User.findById(entry.userId);
          if (user) {
            user.walletBalance -= entryFee;
            await user.save();
            await Transaction.create({
              userId: user._id,
              type: 'entry_fee',
              amount: entryFee,
              balanceAfter: user.walletBalance,
              referenceId: id
            });
            io.to('user_' + user._id.toString()).emit('wallet:update', { newBalance: user.walletBalance });
          }
        }
      }
    } catch(err) { console.error('Fee deduction error', err); }
  })();

  const room = {
    id, size, entryFee, seats,
    players: seats.map(s => ({ color: s.color, pieces: [{pos:-1},{pos:-1},{pos:-1},{pos:-1}], finished:false })),
    order: seats.map((_, i) => i),
    turnPtr: 0,
    dice: 1,
    diceLocked: false,
    consecutiveSixes: 0,
    phase: 'rolling',   // rolling | choosing | ended
    finishedOrder: [],
    createdAt: Date.now(),
    disconnectTimers: {},
    timers: {}
  };
  rooms.set(id, room);

  seats.forEach(s => {
    if (s.socketId) {
      const sock = io.sockets.sockets.get(s.socketId);
      if (sock) {
        sock.join(id);
        sock.data.roomId = id;
        sock.emit('match:found', { roomId: id, seatColor: s.color, seatIndex: seats.indexOf(s) });
      }
    }
  });

  broadcastState(io, room);
  takeTurnIfNeeded(io, room);
}

function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

function joinQueue(io, socket, { size, entryFee, name, favoriteColor, userId, isAdmin, isRigged }) {
  const s = [2, 3, 4].includes(size) ? size : 4;
  const f = entryFee || 50;
  
  // Determine which isolated queue this player type belongs to
  const playerType = isAdmin ? 'admin' : isRigged ? 'rigged' : 'normal';
  const queueKey = `${s}_${f}_${playerType}`;
  
  if (!queues[queueKey]) queues[queueKey] = [];
  leaveAllQueues(socket);
  queues[queueKey].push({ socket, name, favoriteColor, userId, isAdmin: !!isAdmin, isRigged: !!isRigged, joinedAt: Date.now() });
  socket.data.queuedKey = queueKey;
  socket.emit('queue:joined', { size: s, entryFee: f, position: queues[queueKey].length });
  processQueues(io);
}

function leaveAllQueues(socket) {
  Object.keys(queues).forEach(key => {
    const idx = queues[key].findIndex(e => e.socket.id === socket.id);
    if (idx !== -1) queues[key].splice(idx, 1);
  });
}

// ---------------------------------------------------------------
// Public snapshot sent to clients — never expose internal timers,
// socket ids, etc.
// ---------------------------------------------------------------
function publicState(room) {
  return {
    id: room.id,
    size: room.size,
    seats: room.seats.map(s => ({ color: s.color, isAI: s.isAI, connected: s.connected, name: s.name })),
    players: room.players.map(p => ({ color: p.color, pieces: p.pieces.map(pc => ({ pos: pc.pos })), finished: p.finished })),
    order: room.order,
    turnPtr: room.turnPtr,
    dice: room.dice,
    phase: room.phase,
    finishedOrder: room.finishedOrder
  };
}
function broadcastState(io, room) {
  io.to(room.id).emit('room:state', publicState(room));
}

// ---------------------------------------------------------------
// Turn engine — mirrors the client's local logic exactly so
// behaviour is identical between practice mode and real matches.
// ---------------------------------------------------------------
function activeSeat(room) { return room.seats[room.order[room.turnPtr]]; }
function activePlayer(room) { return room.players[room.order[room.turnPtr]]; }

function takeTurnIfNeeded(io, room) {
  if (room.phase === 'ended') return;
  const seat = activeSeat(room);
  
  if (room.timers.turn) clearTimeout(room.timers.turn);
  
  if (seat.isAI || !seat.connected) {
    // Show dice animation for AI/disconnected
    io.to(room.id).emit('room:event', { type: 'auto-roll-start' }); 
    setTimeout(() => executeRoll(io, room, true), 600);
  } else {
    // 20-second timer for human to roll
    room.timers.turn = setTimeout(() => executeRoll(io, room, true), 20000);
  }
}

function executeRoll(io, room, isAuto) {
  if (room.phase === 'ended' || room.diceLocked) return;
  room.diceLocked = true; // Lock the dice instantly

  const playerIdx = room.order[room.turnPtr];
  const seat = room.seats[playerIdx];
  
  let result;
  if (seat.isRigged) {
    result = engine.calculateRiggedRoll(room.players, playerIdx);
  } else {
    let safe = false;
    let attempts = 0;
    while (!safe && attempts < 10) {
      result = engine.rollDie();
      const riggedIndices = room.seats.map((s, i) => s.isRigged ? i : -1).filter(i => i !== -1);
      safe = engine.isSafeRoll(room.players, playerIdx, riggedIndices, result);
      attempts++;
    }
  }

  // Emit the result to all clients to start their synced visual animations
  io.to(room.id).emit('room:dice_result', { dice: result, playerIdx });
  
  // Pause server logic for 1.5 seconds to allow clients to render the animation
  setTimeout(() => handleRollResult(io, room, result, isAuto), 1500);
}

function handleRollResult(io, room, result, isAuto) {
  room.dice = result;
  if (result === 6) room.consecutiveSixes++; else room.consecutiveSixes = 0;

  if (room.consecutiveSixes === 3) {
    room.consecutiveSixes = 0;
    io.to(room.id).emit('room:event', { type: 'triple-six', color: activePlayer(room).color });
    endTurn(io, room);
    return;
  }

  const moves = engine.legalMoves(room.players, room.order[room.turnPtr], result);
  broadcastState(io, room);

  if (moves.length === 0) {
    io.to(room.id).emit('room:event', { type: 'no-move', dice: result });
    setTimeout(() => { if (result === 6) beginRoll(io, room); else endTurn(io, room); }, 700);
    return;
  }

  const seat = activeSeat(room);
  if (seat.isAI || !seat.connected) {
    const choice = engine.aiChooseMove(room.players, room.order[room.turnPtr], moves);
    // Add small pause for AI readability
    setTimeout(() => performMove(io, room, choice), 500);
  } else {
    room.phase = 'choosing';
    broadcastState(io, room);
    if (room.timers.turn) clearTimeout(room.timers.turn);
    
    if (moves.length === 1) {
      setTimeout(() => performMove(io, room, moves[0]), 500);
    } else {
      room.timers.turn = setTimeout(() => executeAutoMove(io, room), 20000);
    }
  }
}

function executeAutoMove(io, room) {
  if (room.phase !== 'choosing') return;
  const moves = engine.legalMoves(room.players, room.order[room.turnPtr], room.dice);
  if (moves.length > 0) {
    const choice = engine.aiChooseMove(room.players, room.order[room.turnPtr], moves);
    performMove(io, room, choice);
  }
}

function performMove(io, room, move) {
  if (room.timers.turn) clearTimeout(room.timers.turn);
  const playerIdx = room.order[room.turnPtr];
  const result = engine.applyMove(room.players, playerIdx, move);
  const seat = room.seats[playerIdx];

  io.to(room.id).emit('room:event', {
    type: 'move', color: seat.color, move, captured: result.captured,
    blocked: result.blocked, reachedHome: result.reachedHome
  });

  if (result.finishedGame) {
    room.finishedOrder.push(playerIdx);
    const remaining = room.players.filter(p => !p.finished);
    if (remaining.length <= 1) {
      if (remaining.length === 1) {
        room.finishedOrder.push(room.players.findIndex(p => !p.finished));
      }
      room.phase = 'ended';
      broadcastState(io, room);
      io.to(room.id).emit('room:event', { type: 'game-over', finishedOrder: room.finishedOrder });
      scheduleRoomCleanup(room.id);
      distributeWinnings(io, room);
      return;
    }
  }

  broadcastState(io, room);

  if (room.dice === 6 || result.bonusTurn) {
    setTimeout(() => beginRoll(io, room), 700);
  } else {
    setTimeout(() => endTurn(io, room), 700);
  }
}

function beginRoll(io, room) {
  if (room.phase === 'ended') return;
  room.phase = 'rolling';
  room.diceLocked = false;
  broadcastState(io, room);
  takeTurnIfNeeded(io, room);
}

function endTurn(io, room) {
  room.consecutiveSixes = 0;
  room.diceLocked = false;
  advanceTurnPointer(room);
  beginRoll(io, room);
}

function advanceTurnPointer(room) {
  if (room.order.length === 0) return;
  let guard = 0;
  do {
    room.turnPtr = (room.turnPtr + 1) % room.order.length;
    guard++;
  } while (room.players[room.order[room.turnPtr]].finished && guard <= room.order.length && !allButOneFinished(room));
}
function allButOneFinished(room) { return room.players.filter(p => !p.finished).length <= 1; }

function scheduleRoomCleanup(roomId) {
  setTimeout(() => rooms.delete(roomId), 5 * 60 * 1000); // keep briefly for late reconnects/inspection
}

async function distributeWinnings(io, room) {
  if (room.finishedOrder.length === 0) return;
  const winnerSeatIdx = room.finishedOrder[0];
  const winnerSeat = room.seats[winnerSeatIdx];
  if (!winnerSeat || winnerSeat.isAI || !winnerSeat.userId) return; // AI or guest won, money stays with platform

  try {
    const User = require('../models/User');
    const Transaction = require('../models/Transaction');
    const Match = require('../models/Match');

    const totalPool = room.entryFee * room.size;
    const platformFee = totalPool * 0.05;
    const winningAmount = totalPool - platformFee;

    const winner = await User.findById(winnerSeat.userId);
    if (!winner) return;

    winner.walletBalance += winningAmount;
    winner.stats.totalWins += 1;
    await winner.save();

    io.to('user_' + winner._id.toString()).emit('wallet:update', { newBalance: winner.walletBalance });

    await Transaction.create({
      userId: winner._id,
      type: 'winning',
      amount: winningAmount,
      balanceAfter: winner.walletBalance
    });

    await Transaction.create({
      userId: winner._id,
      type: 'platform_fee',
      amount: platformFee
    });
    
    // Increment losses for other human players
    const humanLosers = room.seats.filter((s, i) => i !== winnerSeatIdx && !s.isAI && s.userId);
    for (let s of humanLosers) {
      const loser = await User.findById(s.userId);
      if(loser) {
        loser.stats.totalLosses += 1;
        await loser.save();
      }
    }

  } catch (err) {
    console.error('Failed to distribute winnings:', err);
  }
}

// ---------------------------------------------------------------
// Player-triggered events (called from socket handlers)
// ---------------------------------------------------------------
function requestRoll(io, socket) {
  const room = rooms.get(socket.data.roomId);
  if (!room || room.phase !== 'rolling' || room.diceLocked) return;
  const seat = activeSeat(room);
  if (seat.socketId !== socket.id) return; // not this player's turn
  if (room.timers.turn) clearTimeout(room.timers.turn);
  executeRoll(io, room, false);
}

function requestMove(io, socket, pieceIdx) {
  const room = rooms.get(socket.data.roomId);
  if (!room || room.phase !== 'choosing') return;
  const seat = activeSeat(room);
  if (seat.socketId !== socket.id) return;
  const moves = engine.legalMoves(room.players, room.order[room.turnPtr], room.dice);
  const move = moves.find(m => m.isExit
    ? room.players[room.order[room.turnPtr]].pieces[pieceIdx].pos === -1
    : m.pieceIdx === pieceIdx);
  if (!move) return;
  performMove(io, room, move);
}

// ---------------------------------------------------------------
// Disconnect handling — a human seat is given a grace period to
// reconnect before the AI takes over, so short network hiccups
// don't immediately ruin the game.
// ---------------------------------------------------------------
function handleLeave(io, socket) {
  const room = rooms.get(socket.data.roomId);
  if (!room || room.phase === 'ended') return;
  
  const seatIdx = room.seats.findIndex(s => s.socketId === socket.id);
  if (seatIdx === -1) return;
  
  const seat = room.seats[seatIdx];
  seat.connected = false;
  seat.isAI = true;
  seat.socketId = null;
  room.players[seatIdx].pieces.forEach(p => p.pos = -1);
  room.players[seatIdx].finished = true;
  
  socket.leave(room.id);
  socket.data.roomId = null;
  socket.data.seatColor = null;
  
  io.to(room.id).emit('room:event', { type: 'player-left', name: seat.name, color: seat.color });
  
  // Check if only 1 unfinished player remains -> instant win
  const activePlayers = room.players.filter(p => !p.finished);
  if (activePlayers.length <= 1) {
    if (activePlayers.length === 1) {
      const winnerIdx = room.players.findIndex(p => !p.finished);
      room.finishedOrder.push(winnerIdx);
      room.players[winnerIdx].finished = true;
    }
    room.phase = 'ended';
    if (room.timers.turn) clearTimeout(room.timers.turn);
    broadcastState(io, room);
    io.to(room.id).emit('room:event', { type: 'game-over', finishedOrder: room.finishedOrder });
    scheduleRoomCleanup(room.id);
    distributeWinnings(io, room);
    return;
  }
  
  // If it was the leaving player's turn, advance
  if (room.order[room.turnPtr] === seatIdx) {
    if (room.timers.turn) clearTimeout(room.timers.turn);
    endTurn(io, room);
  } else {
    broadcastState(io, room);
  }
}

function handleDisconnect(io, socket) {
  leaveAllQueues(socket);
  const roomId = socket.data.roomId;
  const room = rooms.get(roomId);
  if (!room) return;
  const seat = room.seats.find(s => s.socketId === socket.id);
  if (!seat) return;

  seat.connected = false;
  broadcastState(io, room);

  room.disconnectTimers[seat.color] = setTimeout(() => {
    if (!seat.connected) {
      seat.isAI = true; // permanently hand the seat to the AI
      seat.name = 'AI ' + cap(seat.color) + ' (was ' + seat.name + ')';
      broadcastState(io, room);
      if (activeSeat(room) === seat) takeTurnIfNeeded(io, room);
    }
  }, DISCONNECT_GRACE_MS);
}

// A dropped connection can rejoin its seat (by room id + color) within
// the disconnect grace period, so a page refresh doesn't forfeit the game.
function handleRejoin(io, socket, roomId, color) {
  const room = rooms.get(roomId);
  if (!room) { socket.emit('room:not_found'); return; }
  const seat = room.seats.find(s => s.color === color);
  if (!seat || seat.isAI) { socket.emit('room:not_found'); return; }

  clearTimeout(room.disconnectTimers[color]);
  seat.socketId = socket.id;
  seat.connected = true;
  socket.join(room.id);
  socket.data.roomId = room.id;

  broadcastState(io, room);
  socket.emit('match:found', { roomId: room.id, seatColor: color, seatIndex: room.seats.indexOf(seat) });
  if (activeSeat(room) === seat) takeTurnIfNeeded(io, room);
}

module.exports = {
  rooms, queues, joinQueue, leaveAllQueues, requestRoll, requestMove,
  handleDisconnect, handleRejoin, handleLeave, publicState, broadcastState, processQueues
};
