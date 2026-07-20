const express = require('express');
const multer = require('multer');
const path = require('path');
const User = require('../models/User');
const Transaction = require('../models/Transaction');
const Match = require('../models/Match');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// Setup Multer for screenshot uploads
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, 'public/uploads/');
  },
  filename: function (req, file, cb) {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, 'deposit-' + uniqueSuffix + path.extname(file.originalname));
  }
});
const upload = multer({ storage: storage });

router.post('/deposit', requireAuth, upload.single('screenshot'), async (req, res) => {
  try {
    const { amount } = req.body;
    if (!amount || amount <= 0) return res.status(400).json({ error: 'Invalid amount' });
    if (!req.file) return res.status(400).json({ error: 'Payment screenshot is required' });

    const transaction = await Transaction.create({
      userId: req.userId,
      type: 'deposit',
      amount: Number(amount),
      status: 'pending',
      referenceId: '/uploads/' + req.file.filename
    });

    req.app.locals.io.emit('admin:deposit_request');

    res.json({ message: 'Deposit request submitted for admin approval', transaction });
  } catch (err) {
    res.status(500).json({ error: 'Failed to submit deposit', detail: err.message });
  }
});

router.post('/withdraw', requireAuth, async (req, res) => {
  try {
    const { amount } = req.body;
    if (!amount || amount <= 0) return res.status(400).json({ error: 'Invalid amount' });

    const user = await User.findById(req.userId);
    if (user.walletBalance < amount) {
      return res.status(400).json({ error: 'Insufficient wallet balance' });
    }

    // Deduct immediately, it's pending admin approval. 
    // If admin rejects, we will refund it.
    user.walletBalance -= Number(amount);
    user.totalWithdrawals += Number(amount);
    await user.save();

    const transaction = await Transaction.create({
      userId: req.userId,
      type: 'withdrawal',
      amount: Number(amount),
      status: 'pending',
      balanceAfter: user.walletBalance
    });

    req.app.locals.io.emit('admin:withdrawal_request');

    res.json({ message: 'Withdrawal request submitted', transaction, newBalance: user.walletBalance });
  } catch (err) {
    res.status(500).json({ error: 'Failed to submit withdrawal', detail: err.message });
  }
});

router.get('/history', requireAuth, async (req, res) => {
  try {
    const transactions = await Transaction.find({ userId: req.userId }).sort({ createdAt: -1 });
    const matches = await Match.find({ players: req.userId }).populate('winner', 'username').sort({ playedAt: -1 });
    res.json({ transactions, matches });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch history', detail: err.message });
  }
});

module.exports = router;
