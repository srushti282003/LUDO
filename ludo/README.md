# Ludo · Royal Race

A full Ludo platform: real-time online matchmaking, registration/login backed
by MongoDB, unlimited concurrent users and rooms, a rule-based AI, and a local
"Practice" mode for hot-seat play — all in one Node.js project.

## Features

- **Accounts** — register/login (bcrypt-hashed passwords, JWT sessions), pick
  a favorite piece color at signup, per-user win/loss stats stored in MongoDB.
- **Quick Match (online, real-time)** — pick a table size (2 or 4), and the
  server matches you instantly via Socket.io. If not enough humans join within
  12 seconds, empty seats auto-fill with AI so the match starts fast regardless.
  No cap on concurrent rooms or players — each match is an independent
  in-memory room, created on demand.
- **Practice mode** — local hot-seat play on one device, any mix of human/AI
  seats, choose your own color per seat.
- **Full classic Ludo rules** — 6-to-exit, extra turn on 6, triple-6 forfeit,
  exact-landing home entry, capturing with safe stars/start squares, blocking.
- **Reconnect support** — refreshing mid-match automatically rejoins your
  seat within a 20-second grace window before the AI takes over for you.
- **Presentation** — animated dice per player corner, piece movement
  animation, synthesized sound effects (no audio files needed), confetti +
  ranked win screen, "How to Play" reference.

## Project structure

```
ludo/
├── server.js              Express + Socket.io entry point
├── package.json
├── .env.example            copy to .env and edit
├── game/
│   ├── engine.js            authoritative rules engine (shared by rooms + AI)
│   └── roomManager.js        matchmaking queues + live room/turn state
├── middleware/
│   └── auth.js               JWT verification middleware
├── models/
│   ├── User.js                Mongoose user schema
│   └── Match.js               Mongoose match-history schema
├── routes/
│   ├── auth.js                 /api/auth/register, /login, /me
│   └── match.js                 /api/match/result
└── public/
    ├── login.html / register.html   auth pages
    ├── theme.css                     shared auth-page styling
    └── index.html                    mode select → practice or quick match
```

## Setup & run

1. **Install MongoDB** locally (or point `.env` at any MongoDB instance) and
   make sure it's running — the app expects `mongodb://localhost:27017/LUDO`
   by default.
2. In the `ludo/` folder:
   ```bash
   cp .env.example .env      # edit JWT_SECRET for anything beyond local testing
   npm install
   npm start
   ```
3. Open `http://localhost:3000` — it redirects to `/login.html` if you're not
   signed in yet. Register an account, then you'll land on the mode-select
   screen (Quick Match vs Practice).

`npm run dev` uses nodemon for auto-restart while editing.

## How matchmaking works

- Joining "Quick Match" adds your socket to a queue bucket for the table size
  you picked (2 or 4 players).
- A background tick (once per second) checks every queue bucket: if it's full,
  or if the longest-waiting player has been queued 12+ seconds, it spins up a
  new room immediately, filling any still-empty seats with AI.
- Because each room is just an object in a `Map`, there's no fixed limit on
  how many rooms can run at once — only the host machine's memory/CPU is the
  real ceiling. The same is true for concurrent users: nothing here enforces
  an account or connection cap.
- All game rules are enforced server-side (`game/engine.js`) — the client only
  renders what the server sends and requests rolls/moves, so a modified client
  can't play illegal moves.

## Honest scope notes

- **Single-process, in-memory rooms.** This runs great for one server
  instance. To scale Socket.io itself across multiple server processes/machines
  (for very large concurrent load), add the official
  [Socket.io Redis adapter](https://socket.io/docs/v4/redis-adapter/) — the
  room/matchmaking logic here doesn't need to change, only the Socket.io
  server construction in `server.js`.
- **Room state isn't persisted to MongoDB mid-game** — only final win/loss is
  recorded per user via `/api/match/result`. If the server process restarts,
  in-progress matches are lost. Persisting live room state to MongoDB (or
  Redis) is a natural next step if you need that durability.
- **Guests can queue without an account** (server accepts sockets without a
  valid JWT and treats them as anonymous seats) — only signed-in users get
  stats recorded.

## Extending it

- **Leaderboards** — the `Match` model already exists; write matches to it in
  `game/roomManager.js` on game-over, then add a `/api/leaderboard` route.
- **Chat** — add a `chat:message` socket event, broadcast to `io.to(roomId)`.
- **Private rooms with invite codes** — skip the matchmaking queue and let a
  player create a room directly, sharing its `roomId` with friends.
- **More AI difficulty levels** — `game/engine.js`'s `scoreMove` is a single
  weighting function; parameterize it per difficulty or swap in a minimax
  search over a few turns for a "hard" mode.
