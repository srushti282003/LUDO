const express = require('express');
const User = require('../models/User');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// Called once when a locally-played game ends, to persist the outcome
// for the logged-in player.
router.post('/result', requireAuth, async (req, res) => {
  try {
    const won = !!req.body.won;
    const user = await User.findByIdAndUpdate(
      req.userId,
      { $inc: { 'stats.gamesPlayed': 1, 'stats.gamesWon': won ? 1 : 0 } },
      { new: true }
    );
    if (!user) return res.status(404).json({ error: 'User not found.' });
    res.json({ stats: user.stats });
  } catch (err) {
    res.status(500).json({ error: 'Could not save result.', detail: err.message });
  }
});

module.exports = router;
