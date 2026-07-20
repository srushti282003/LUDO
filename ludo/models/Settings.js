const mongoose = require('mongoose');

const slotSchema = new mongoose.Schema({
  amount: { type: Number, required: true },
  isEnabled: { type: Boolean, default: true },
  allowedModes: { type: [String], default: ['2-player'] } // e.g., '2-player', '3-player', '4-player'
}, { _id: false });

const settingsSchema = new mongoose.Schema({
  whatsappNumber: { type: String, default: '8850919451' },
  upiDetails: { type: String, default: 'admin@upi' },
  qrImage: { type: String, default: '' },
  entryFeeSlots: { 
    type: [slotSchema], 
    default: [
      { amount: 50, isEnabled: true, allowedModes: ['2-player'] },
      { amount: 100, isEnabled: true, allowedModes: ['2-player'] },
      { amount: 200, isEnabled: true, allowedModes: ['2-player'] },
      { amount: 500, isEnabled: true, allowedModes: ['2-player'] }
    ] 
  },
  platformFeePercentage: { type: Number, default: 5 },
  turnTimerSeconds: { type: Number, default: 20 },
  aiEnabled: { type: Boolean, default: true }
});

module.exports = mongoose.model('Settings', settingsSchema);
