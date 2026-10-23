'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { WebSocketServer, WebSocket } = require('ws');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');

// ───────────────────────── game constants ─────────────────────────
// The client mirrors W, H, PADDLE_W, PADDLE_H, MARGIN, PADDLE_SPEED for prediction.
const W = 800;
const H = 500;
const PADDLE_W = 12;
const PADDLE_H = 90;
const MARGIN = 30;
const PADDLE_SPEED = 420; // px / s
const BALL_R = 8;
const SERVE_SPEED = 340; // px / s
const MAX_SPEED = 760;
const SPEEDUP = 1.07; // per paddle hit
const MAX_BOUNCE = Math.PI / 3.2; // max deflection angle off the paddle edge
const WIN_SCORE = 7;

const TICK_RATE = 60; // simulation steps / s
const STEP_MS = 1000 / TICK_RATE;
const DT = 1 / TICK_RATE;
const SEND_EVERY = 2; // broadcast every 2nd tick → 30 snapshots / s
const FIRST_COUNTDOWN = 3;
const POINT_COUNTDOWN = 1;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const r1 = (v) => Math.round(v * 10) / 10;
const r2 = (v) => Math.round(v * 100) / 100;

// ───────────────────────── rooms ─────────────────────────
const rooms = new Map(); // code → Room
const quickQueue = []; // sockets waiting for a random opponent
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // no I / O

function makeCode() {
  let code;
  do {
    code = Array.from({ length: 4 }, () => CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function send(ws, obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

class Room {
  constructor(code) {
    this.code = code;
    this.players = [null, null]; // slot 0 = left side, slot 1 = right side
    this.dirs = [0, 0]; // latest input per side: -1 up, 0 idle, 1 down
    this.rematch = [false, false];
    this.reset();
    this.phase = 'waiting'; // waiting | countdown | playing | over
  }

  get count() {
    return this.players.filter(Boolean).length;
  }

  get active() {
    return this.phase === 'countdown' || this.phase === 'playing';
  }

  reset() {
    this.score = [0, 0];
    this.paddles = [(H - PADDLE_H) / 2, (H - PADDLE_H) / 2];
    this.ball = { x: W / 2, y: H / 2, vx: 0, vy: 0 };
    this.serveDir = 1;
    this.sv = 0; // serve id: lets clients drop interpolation history on a reset
    this.tick = 0;
    this.cd = 0;
    this.events = [];
  }

  add(ws) {
    const side = this.players[0] ? 1 : 0;
    this.players[side] = ws;
    ws.room = this;
    ws.side = side;
    send(ws, { t: 'joined', code: this.code, side });
    if (this.count === 2) this.startMatch();
    else this.broadcast();
  }

  remove(ws) {
    const idx = this.players.indexOf(ws);
    if (idx === -1) return;
    this.players[idx] = null;
    this.dirs = [0, 0];
    ws.room = null;
    ws.side = -1;

    // Keep the remaining player in slot 0 so a newcomer always takes slot 1.
    if (this.players[1] && !this.players[0]) {
      this.players[0] = this.players[1];
      this.players[1] = null;
      this.players[0].side = 0;
      send(this.players[0], { t: 'joined', code: this.code, side: 0 });
    }

    if (this.count === 0) {
      rooms.delete(this.code);
      return;
    }
    this.reset();
    this.phase = 'waiting';
    this.rematch = [false, false];
    for (const p of this.players) send(p, { t: 'opponent_left' });
    this.broadcast();
  }

  startMatch() {
    this.reset();
    this.rematch = [false, false];
    this.startServe(Math.random() < 0.5 ? 1 : -1, FIRST_COUNTDOWN);
  }

  startServe(dirX, seconds) {
    this.ball = { x: W / 2, y: H / 2, vx: 0, vy: 0 };
    this.serveDir = dirX;
    this.sv++;
    this.cd = seconds;
    this.phase = 'countdown';
    this.broadcast();
  }

  launch() {
    const angle = (Math.random() * 2 - 1) * 0.35;
    this.ball.vx = Math.cos(angle) * SERVE_SPEED * this.serveDir;
    this.ball.vy = Math.sin(angle) * SERVE_SPEED;
    this.phase = 'playing';
    this.broadcast();
  }

  // One fixed simulation step (1/60 s).
  step() {
    if (!this.active) return;
    this.tick++;

    for (let i = 0; i < 2; i++) {
      this.paddles[i] = clamp(this.paddles[i] + this.dirs[i] * PADDLE_SPEED * DT, 0, H - PADDLE_H);
    }

    if (this.phase === 'countdown') {
      this.cd -= DT;
      if (this.cd <= 0) this.launch();
    } else {
      this.stepBall();
    }

    if (this.active && this.tick % SEND_EVERY === 0) this.broadcast();
  }

  stepBall() {
    const b = this.ball;
    const px = b.x;
    const py = b.y;
    b.x += b.vx * DT;
    b.y += b.vy * DT;

    if (b.y - BALL_R < 0) {
      b.y = BALL_R;
      b.vy = Math.abs(b.vy);
      this.events.push('wall');
    } else if (b.y + BALL_R > H) {
      b.y = H - BALL_R;
      b.vy = -Math.abs(b.vy);
      this.events.push('wall');
    }

    // Swept test against each paddle's inner face so a fast ball can't tunnel through.
    const leftFace = MARGIN + PADDLE_W;
    const rightFace = W - MARGIN - PADDLE_W;
    if (b.vx < 0 && px - BALL_R >= leftFace && b.x - BALL_R <= leftFace) {
      const t = (px - BALL_R - leftFace) / (px - b.x);
      this.tryBounce(0, py + (b.y - py) * t, leftFace + BALL_R);
    } else if (b.vx > 0 && px + BALL_R <= rightFace && b.x + BALL_R >= rightFace) {
      const t = (rightFace - (px + BALL_R)) / (b.x - px);
      this.tryBounce(1, py + (b.y - py) * t, rightFace - BALL_R);
    }

    if (b.x + BALL_R < 0) this.point(1);
    else if (b.x - BALL_R > W) this.point(0);
  }

  tryBounce(side, yAt, xOut) {
    const top = this.paddles[side];
    if (yAt + BALL_R < top || yAt - BALL_R > top + PADDLE_H) return; // missed the paddle

    const b = this.ball;
    const rel = clamp((yAt - (top + PADDLE_H / 2)) / (PADDLE_H / 2 + BALL_R), -1, 1);
    const speed = Math.min(Math.hypot(b.vx, b.vy) * SPEEDUP, MAX_SPEED);
    const angle = rel * MAX_BOUNCE;
    const dirX = side === 0 ? 1 : -1;
    b.vx = Math.cos(angle) * speed * dirX;
    b.vy = Math.sin(angle) * speed;
    b.x = xOut;
    b.y = yAt;
    this.events.push('hit');
  }

  point(winner) {
    this.score[winner]++;
    this.events.push('score');
    if (this.score[winner] >= WIN_SCORE) {
      this.events.push('win');
      this.ball.vx = this.ball.vy = 0;
      this.phase = 'over';
      this.broadcast();
    } else {
      // Serve toward the player who just lost the point.
      this.startServe(winner === 0 ? 1 : -1, POINT_COUNTDOWN);
    }
  }

  requestRematch(side) {
    if (this.phase !== 'over') return;
    this.rematch[side] = true;
    send(this.players[1 - side], { t: 'rematch_req' });
    if (this.rematch[0] && this.rematch[1]) this.startMatch();
  }

  broadcast() {
    const b = this.ball;
    const msg = JSON.stringify({
      t: 's',
      tk: this.tick,
      ph: this.phase,
      cd: r2(Math.max(0, this.cd)),
      sv: this.sv,
      b: [r1(b.x), r1(b.y), r1(b.vx), r1(b.vy)],
      p: this.paddles.map(r1),
      sc: this.score,
      ev: this.events,
    });
    this.events = [];
    for (const ws of this.players) {
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(msg);
    }
  }
}

function leave(ws) {
  const qi = quickQueue.indexOf(ws);
  if (qi !== -1) quickQueue.splice(qi, 1);
  if (ws.room) ws.room.remove(ws);
}

// ───────────────────────── HTTP (static files) ─────────────────────────
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
};

const server = http.createServer((req, res) => {
  const { pathname } = new URL(req.url, 'http://localhost');
  const rel = pathname === '/' ? '/index.html' : pathname;
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404).end('Not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
});

// ───────────────────────── WebSocket protocol ─────────────────────────
const wss = new WebSocketServer({ server, maxPayload: 1024 });

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.room = null;
  ws.side = -1;
  ws.msgs = 0;

  ws.on('pong', () => {
    ws.isAlive = true;
  });

  ws.on('message', (raw) => {
    if (++ws.msgs > 120) return; // crude per-second rate limit (reset below)
    let m;
    try {
      m = JSON.parse(raw);
    } catch {
      return;
    }
    if (!m || typeof m.t !== 'string') return;

    switch (m.t) {
      case 'create': {
        leave(ws);
        new_room().add(ws);
        break;
      }
      case 'join': {
        const code = String(m.code || '').trim().toUpperCase();
        const room = rooms.get(code);
        if (!room) return send(ws, { t: 'error', msg: `No room with code ${code || '—'}.` });
        if (room.count >= 2) return send(ws, { t: 'error', msg: 'That room is full.' });
        leave(ws);
        room.add(ws);
        break;
      }
      case 'quick': {
        leave(ws);
        let opponent = null;
        while (quickQueue.length && !opponent) {
          const candidate = quickQueue.shift();
          if (candidate.readyState === WebSocket.OPEN) opponent = candidate;
        }
        if (opponent) {
          const room = new_room();
          room.add(opponent);
          room.add(ws);
        } else {
          quickQueue.push(ws);
          send(ws, { t: 'queued' });
        }
        break;
      }
      case 'input': {
        if (ws.room && (m.dir === -1 || m.dir === 0 || m.dir === 1)) ws.room.dirs[ws.side] = m.dir;
        break;
      }
      case 'rematch': {
        if (ws.room) ws.room.requestRematch(ws.side);
        break;
      }
      case 'leave': {
        leave(ws);
        break;
      }
      case 'ping': {
        if (typeof m.ts === 'number') send(ws, { t: 'pong', ts: m.ts });
        break;
      }
    }
  });

  ws.on('close', () => leave(ws));
  ws.on('error', () => {});
});

function new_room() {
  const room = new Room(makeCode());
  rooms.set(room.code, room);
  return room;
}

// Fixed-timestep loop: real elapsed time feeds an accumulator, the simulation
// advances in constant 1/60 s steps no matter how irregular the timer fires.
let last = performance.now();
let acc = 0;
setInterval(() => {
  const now = performance.now();
  acc = Math.min(acc + (now - last), 250);
  last = now;
  while (acc >= STEP_MS) {
    acc -= STEP_MS;
    for (const room of rooms.values()) room.step();
  }
}, 5);

setInterval(() => {
  for (const ws of wss.clients) ws.msgs = 0;
}, 1000);

// Heartbeat: drop connections that stopped answering protocol-level pings.
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, 30000);

server.listen(PORT, () => {
  console.log(`Pong online → http://localhost:${PORT}`);
});
