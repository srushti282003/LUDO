const mongoose = require('mongoose');

const transactionSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  type: { 
    type: String, 
    enum: ['deposit', 'withdrawal', 'entry_fee', 'winning', 'platform_fee', 'refund', 'admin_adjustment'], 
    required: true 
  },
  amount: { type: Number, required: true },
  status: { 
    type: String, 
    enum: ['pending', 'approved', 'rejected', 'completed'], 
    default: 'completed' 
  },
  referenceId: { type: String }, // e.g., match ID, or upload path for deposit screenshot
  balanceAfter: { type: Number }, // Snapshot of wallet balance after transaction
  createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('Transaction', transactionSchema);
