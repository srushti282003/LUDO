const mongoose = require('mongoose');

// No cap on document count — MongoDB collections scale to as many
// registered users as your deployment's storage/hosting allows.
const userSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true, trim: true, minlength: 3, maxlength: 20 },
  email:    { type: String, required: true, unique: true, trim: true, lowercase: true },
  phoneNumber: { type: String, trim: true },
  passwordHash: { type: String, required: true },
  favoriteColor: { type: String, enum: ['red', 'green', 'yellow', 'blue'], default: 'red' },
  profilePhoto: { type: String, default: '' },
  walletBalance: { type: Number, default: 0, min: 0 },
  totalDeposits: { type: Number, default: 0 },
  totalWithdrawals: { type: Number, default: 0 },
  stats: {
    totalMatchesPlayed: { type: Number, default: 0 },
    totalWins: { type: Number, default: 0 },
    totalLosses: { type: Number, default: 0 },
    gamesPlayed: { type: Number, default: 0 }, // legacy, keep for safety
    gamesWon:    { type: Number, default: 0 }  // legacy, keep for safety
  },
  isRigged: { type: Boolean, default: false },
  accountStatus: { type: String, enum: ['active', 'suspended', 'banned'], default: 'active' },
  createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('User', userSchema);
