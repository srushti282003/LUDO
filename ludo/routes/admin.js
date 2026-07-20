const express = require('express');
const User = require('../models/User');
const Transaction = require('../models/Transaction');
const Match = require('../models/Match');
const Settings = require('../models/Settings');
const { requireAuth } = require('../middleware/auth');
const multer = require('multer');
const path = require('path');

const router = express.Router();
const upload = multer({ dest: path.join(__dirname, '../public/uploads/') });

// Middleware to ensure user is admin.
async function requireAdmin(req, res, next) {
  try {
    const user = await User.findById(req.userId);
    if (!user || (user.username !== 'ABmin9876' && user.username.toLowerCase() !== 'admin')) {
      return res.status(403).json({ error: 'Access denied' });
    }
    next();
  } catch (err) {
    res.status(500).json({ error: 'Admin check failed' });
  }
}

// Ensure all routes require auth and admin
router.use(requireAuth);
router.use(requireAdmin);

// ---------------------------------------------------------
// Dashboard Stats
// ---------------------------------------------------------
router.get('/stats', async (req, res) => {
  try {
    const totalUsers = await User.countDocuments({ username: { $nin: ['ABmin9876', 'admin', 'Admin'] } });
    
    const [totalDepositsResult] = await Transaction.aggregate([
      { $match: { type: 'deposit', status: 'completed' } },
      { $group: { _id: null, total: { $sum: '$amount' } } }
    ]);
    const totalDeposits = totalDepositsResult ? totalDepositsResult.total : 0;

    const [totalWithdrawalsResult] = await Transaction.aggregate([
      { $match: { type: 'withdrawal', status: 'completed' } },
      { $group: { _id: null, total: { $sum: '$amount' } } }
    ]);
    const totalWithdrawals = totalWithdrawalsResult ? totalWithdrawalsResult.total : 0;

    const [platformEarningsResult] = await Transaction.aggregate([
      { $match: { type: 'platform_fee' } },
      { $group: { _id: null, total: { $sum: '$amount' } } }
    ]);
    const platformEarnings = platformEarningsResult ? platformEarningsResult.total : 0;

    const pendingDeposits = await Transaction.countDocuments({ type: 'deposit', status: 'pending' });
    const pendingWithdrawals = await Transaction.countDocuments({ type: 'withdrawal', status: 'pending' });

    // Time-based reports (Daily, Weekly, Monthly arrays for charts can be added here)
    const onlineUsers = req.app.locals.onlineUsers ? req.app.locals.onlineUsers.size : 0;
    const runningRooms = req.app.locals.roomsManager ? Object.keys(req.app.locals.roomsManager.rooms).length : 0;

    res.json({
      totalUsers,
      totalDeposits,
      totalWithdrawals,
      platformEarnings,
      pendingDeposits,
      pendingWithdrawals,
      onlineUsers,
      runningRooms
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch stats', detail: err.message });
  }
});

// ---------------------------------------------------------
// Settings & Slots Management
// ---------------------------------------------------------
router.put('/settings', upload.single('qrImage'), async (req, res) => {
  try {
    let settings = await Settings.findOne();
    if (!settings) settings = new Settings();

    if (req.body.whatsappNumber) settings.whatsappNumber = req.body.whatsappNumber;
    if (req.body.upiDetails) settings.upiDetails = req.body.upiDetails;
    if (req.body.platformFeePercentage) settings.platformFeePercentage = Number(req.body.platformFeePercentage);
    if (req.body.turnTimerSeconds) settings.turnTimerSeconds = Number(req.body.turnTimerSeconds);
    if (req.body.aiEnabled !== undefined) settings.aiEnabled = req.body.aiEnabled === 'true' || req.body.aiEnabled === true;
    
    if (req.body.entryFeeSlots) {
      settings.entryFeeSlots = JSON.parse(req.body.entryFeeSlots);
    }
    
    if (req.file) {
      settings.qrImage = '/uploads/' + req.file.filename;
    }
    
    await settings.save();
    
    // Broadcast setting changes instantly to all connected clients
    if (req.app.locals.io) {
      req.app.locals.io.emit('settings:update', settings);
    }
    res.json({ success: true, settings });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update settings', detail: err.message });
  }
});

// ---------------------------------------------------------
// User Management
// ---------------------------------------------------------
router.get('/users', async (req, res) => {
  try {
    const { search } = req.query;
    let query = { username: { $nin: ['ABmin9876', 'admin', 'Admin'] } };
    
    if (search) {
      const isId = search.length === 24 && /^[0-9a-fA-F]{24}$/.test(search);
      if (isId) {
        query._id = search;
      } else {
        query.$or = [
          { username: { $regex: search, $options: 'i' } },
          { phoneNumber: { $regex: search, $options: 'i' } }
        ];
      }
    }
    const users = await User.find(query).select('-passwordHash').sort({ createdAt: -1 });
    // Append online status
    const onlineUsersSet = req.app.locals.onlineUsers || new Set();
    const enriched = users.map(u => ({
      ...u.toObject(),
      isOnline: onlineUsersSet.has(u._id.toString())
    }));
    res.json(enriched);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch users' });
  }
});

router.post('/user/:id/status', async (req, res) => {
  try {
    const { status } = req.body; // 'active', 'suspended', 'banned', 'remove'
    if (status === 'remove') {
      await User.findByIdAndDelete(req.params.id);
      return res.json({ success: true, message: 'User permanently deleted' });
    }
    
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    
    user.accountStatus = status;
    await user.save();
    
    // Disconnect user in real-time if banned/suspended
    if ((status === 'banned' || status === 'suspended') && req.app.locals.io) {
      req.app.locals.io.to('user_' + user._id.toString()).emit('user:banned');
      req.app.locals.io.in('user_' + user._id.toString()).disconnectSockets(true);
    }
    
    res.json({ success: true, user });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update user status' });
  }
});

router.post('/user/:id/balance', async (req, res) => {
  try {
    const { amount, action } = req.body; // action: 'add' or 'deduct' or 'set'
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found' });

    let amt = Number(amount);
    if (action === 'add') {
      user.walletBalance += amt;
    } else if (action === 'deduct') {
      user.walletBalance = Math.max(0, user.walletBalance - amt);
    } else if (action === 'set') {
      user.walletBalance = Math.max(0, amt);
    }

    await user.save();
    
    await Transaction.create({
      userId: user._id,
      type: 'admin_adjustment',
      amount: amt,
      status: 'completed',
      balanceAfter: user.walletBalance,
      referenceId: action
    });

    if (req.app.locals.io) {
      req.app.locals.io.to('user_' + user._id.toString()).emit('wallet:update', { newBalance: user.walletBalance });
    }

    res.json({ success: true, newBalance: user.walletBalance });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update balance' });
  }
});

// Toggle Rigging status for AI overrides
router.post('/user/:id/rig', async (req, res) => {
  try {
    const { isRigged } = req.body;
    const user = await User.findByIdAndUpdate(req.params.id, { isRigged }, { new: true });
    res.json({ success: true, isRigged: user.isRigged });
  } catch (err) {
    res.status(500).json({ error: 'Failed to rig user' });
  }
});

// ---------------------------------------------------------
// Payments & Withdrawals Management
// ---------------------------------------------------------
router.get('/transactions/pending', async (req, res) => {
  try {
    const txs = await Transaction.find({ status: 'pending', type: 'deposit' }).populate('userId', 'username phoneNumber').sort({ createdAt: -1 });
    res.json(txs);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch deposits' });
  }
});

router.get('/withdrawals', async (req, res) => {
  try {
    const txs = await Transaction.find({ type: 'withdrawal' }).populate('userId', 'username phoneNumber walletBalance').sort({ createdAt: -1 });
    res.json(txs);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch withdrawals' });
  }
});

router.post('/transaction/:id/:action', async (req, res) => {
  try {
    const { action } = req.params; // 'approve' or 'reject'
    const tx = await Transaction.findById(req.params.id).populate('userId');
    if (!tx || tx.status !== 'pending') return res.status(400).json({ error: 'Invalid transaction or already processed' });

    const user = await User.findById(tx.userId._id);

    if (action === 'approve') {
      if (tx.type === 'deposit') {
        user.walletBalance += tx.amount;
        user.totalDeposits += tx.amount;
        tx.balanceAfter = user.walletBalance;
      }
      // If withdrawal, balance was already deducted on request.
      tx.status = 'completed';
    } else if (action === 'reject') {
      tx.status = 'rejected';
      if (tx.type === 'withdrawal') {
        // Refund the withdrawn amount back to the user
        user.walletBalance += tx.amount;
        user.totalWithdrawals -= tx.amount;
      }
      tx.balanceAfter = user.walletBalance;
    } else {
      return res.status(400).json({ error: 'Invalid action' });
    }

    await user.save();
    await tx.save();

    // Instantly sync the new wallet balance to the user's live session
    if (req.app.locals.io) {
      req.app.locals.io.to('user_' + user._id.toString()).emit('wallet:update', { newBalance: user.walletBalance });
    }

    res.json({ message: 'Transaction processed successfully', transaction: tx });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update transaction', detail: err.message });
  }
});

// ---------------------------------------------------------
// Match & Winner History
// ---------------------------------------------------------
router.get('/matches', async (req, res) => {
  try {
    const matches = await Match.find()
      .populate('players', 'username phoneNumber')
      .populate('winner', 'username')
      .sort({ playedAt: -1 })
      .limit(100);
    res.json(matches);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch matches' });
  }
});

router.get('/winners', async (req, res) => {
  try {
    const winners = await Transaction.find({ type: 'winning' })
      .populate('userId', 'username phoneNumber walletBalance')
      .sort({ createdAt: -1 })
      .limit(100);
    res.json(winners);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch winners' });
  }
});

module.exports = router;
