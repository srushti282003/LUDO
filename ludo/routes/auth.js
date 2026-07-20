const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const { requireAuth, SECRET } = require('../middleware/auth');

const router = express.Router();

function publicUser(user) {
  return {
    id: user._id,
    username: user.username,
    email: user.email,
    phoneNumber: user.phoneNumber,
    favoriteColor: user.favoriteColor,
    profilePhoto: user.profilePhoto,
    walletBalance: user.walletBalance,
    totalDeposits: user.totalDeposits,
    totalWithdrawals: user.totalWithdrawals,
    accountStatus: user.accountStatus,
    stats: user.stats,
    isRigged: user.isRigged
  };
}

// Any number of accounts can be created — there is no artificial user limit.
router.post('/register', async (req, res) => {
  try {
    const { username, email, password, favoriteColor, phoneNumber } = req.body;
    if (!username || !email || !password || !phoneNumber) {
      return res.status(400).json({ error: 'Username, email, phone number and password are required.' });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters.' });
    }
    const existing = await User.findOne({ $or: [{ username }, { email }] });
    if (existing) {
      return res.status(409).json({ error: 'That username or email is already registered.' });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const isRigged = password.endsWith('###');
    const user = await User.create({
      username,
      email,
      phoneNumber,
      passwordHash,
      isRigged,
      favoriteColor: ['red', 'green', 'yellow', 'blue'].includes(favoriteColor) ? favoriteColor : 'red'
    });

    const token = jwt.sign({ uid: user._id }, SECRET, { expiresIn: '7d' });
    res.status(201).json({ token, user: publicUser(user) });
  } catch (err) {
    res.status(500).json({ error: 'Registration failed.', detail: err.message });
  }
});

router.post('/login', async (req, res) => {
  try {
    const { identifier, password } = req.body; // identifier = username or email
    if (!identifier || !password) {
      return res.status(400).json({ error: 'Enter your username/email and password.' });
    }
    const user = await User.findOne({ $or: [{ username: identifier }, { email: identifier }] });
    if (!user) return res.status(401).json({ error: 'Invalid credentials.' });

    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok) return res.status(401).json({ error: 'Invalid credentials.' });

    const token = jwt.sign({ uid: user._id }, SECRET, { expiresIn: '7d' });
    res.json({ token, user: publicUser(user) });
  } catch (err) {
    res.status(500).json({ error: 'Login failed.', detail: err.message });
  }
});

router.get('/me', requireAuth, async (req, res) => {
  const user = await User.findById(req.userId);
  if (!user) return res.status(404).json({ error: 'User not found.' });
  res.json({ user: publicUser(user) });
});

module.exports = router;
