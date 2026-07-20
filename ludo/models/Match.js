const mongoose = require('mongoose');

const matchSchema = new mongoose.Schema({
  players: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  winner:  { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  matchType: { type: String, enum: ['2-player', '3-player', '4-player'], default: '2-player' },
  entryFee: { type: Number, default: 0 },
  prizePool: { type: Number, default: 0 },
  platformFee: { type: Number, default: 0 },
  winningAmount: { type: Number, default: 0 },
  playedAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('Match', matchSchema);
