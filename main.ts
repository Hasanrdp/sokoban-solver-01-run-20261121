// Room-by-room push-optimal Sokoban solver for sokoban-solver-01.
//
// The levels this competition draws are a hallway with one to four rooms
// off it, each room holding 3 or 4 boxes and as many goals, and a level's
// push-optimal count is the sum of its rooms' optima: a box pushed out of
// a room's door into the hallway can never be pushed back, so every room
// is an independent problem joined only by the player's walk between
// doors. This program therefore splits each level into its rooms and
// solves every room push-optimally, then walks the player from door to
// door and concatenates the rooms' move strings. A room is solved by a
// breadth-first search over pushes: a state is the boxes' squares plus
// the region the player can reach around them, states are expanded in
// order of pushes made, so the first solved state met is push-optimal.
// Two prunings keep the search small, and neither can prune a solvable
// state: a push that lands a box on a dead square (one from which no
// sequence of pushes, ignoring the other boxes, reaches any goal) and a
// push that freezes a box inside a 2 x 2 block of walls and boxes with a
// box off its goal. When a level does not split into rooms, or a room's
// search runs out of its state budget, the program falls back to the
// same push search over the whole level, and then to a move-based A*
// that at least finishes the level. The search is fully deterministic:
// fixed direction order, a first-in-first-out queue, no clock and no
// randomness, so two runs write the same bytes.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

/** One step: the offsets, the letter for a walk and the letter for a push. */
interface Step {
  dx: number;
  dy: number;
  walk: string;
  push: string;
}
const STEPS: Step[] = [
  { dx: 0, dy: -1, walk: 'u', push: 'U' },
  { dx: 0, dy: 1, walk: 'd', push: 'D' },
  { dx: -1, dy: 0, walk: 'l', push: 'L' },
  { dx: 1, dy: 0, walk: 'r', push: 'R' },
];

/** A parsed level: width, height, walls, goals, boxes and the player. */
interface Level {
  w: number;
  h: number;
  wall: Uint8Array;
  goals: number[];
  boxes: number[];
  player: number;
}

/** A solved level: how many pushes it took and the player's moves. */
interface Solved {
  pushes: number;
  moves: string;
}

/** The most states one room search keeps, and the most the fallbacks keep. */
const ROOM_STATE_CAP = 400_000;
const WHOLE_STATE_CAP = 300_000;
const ASTAR_EXPANSION_CAP = 150_000;

/** Parse XSB text (# wall, space floor, . goal, $ box, * box on a goal, @ player). */
function parseLevel(text: string): Level {
  const rows = text.split('\n').filter((row) => row.length > 0);
  const h = rows.length;
  const w = Math.max(...rows.map((row) => row.length));
  const wall = new Uint8Array(w * h).fill(1);
  const goals: number[] = [];
  const boxes: number[] = [];
  let player = -1;
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const ch = row[x];
      const i = y * w + x;
      if (ch === '#') continue;
      wall[i] = 0;
      if (ch === '.' || ch === '*' || ch === '+') goals.push(i);
      if (ch === '$' || ch === '*') boxes.push(i);
      if (ch === '@' || ch === '+') player = i;
    }
  });
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) wall[y * w + x] = 1;
    }
  }
  boxes.sort((a, b) => a - b);
  goals.sort((a, b) => a - b);
  return { w, h, wall, goals, boxes, player };
}

/**
 * The squares a box can stand on and still be pushed onto some goal:
 * pull back from the goals, a square at a time. A square y is live when
 * a box on it can be pushed onto a live square x = y + d while the
 * player stands at y - d, so both y and y - d must be open floor.
 */
function liveSquares(level: Level): Uint8Array {
  const { w, wall, goals } = level;
  const live = new Uint8Array(wall.length);
  const queue = goals.slice();
  for (const g of goals) live[g] = 1;
  for (let qi = 0; qi < queue.length; qi++) {
    const x = queue[qi];
    for (const s of STEPS) {
      const d = s.dy * w + s.dx;
      const y = x - d;
      if (y < 0 || y >= wall.length) continue;
      if (wall[y] === 0 && wall[y - d] === 0 && live[y] === 0) {
        live[y] = 1;
        queue.push(y);
      }
    }
  }
  return live;
}

/**
 * Flood the squares the player reaches from `from` with `occupied`
 * (boxes) in the way, stamping them into `seen` with `stamp`, and
 * return the lowest square of the region reached.
 */
function floodRegion(
  level: Level,
  occupied: Uint8Array,
  from: number,
  seen: Int32Array,
  stamp: number,
  stack: Int32Array,
): number {
  const { w, wall } = level;
  let low = from;
  let n = 0;
  stack[n++] = from;
  seen[from] = stamp;
  while (n > 0) {
    const p = stack[--n];
    if (p < low) low = p;
    for (const s of STEPS) {
      const q = p + s.dy * w + s.dx;
      if (q < 0 || q >= wall.length) continue;
      if (wall[q] === 0 && occupied[q] === 0 && seen[q] !== stamp) {
        seen[q] = stamp;
        stack[n++] = q;
      }
    }
  }
  return low;
}

/**
 * Whether the box just pushed onto `t` is caught in a frozen 2 x 2
 * block: four squares of walls and boxes holding a box off its goal.
 */
function frozenBlock(level: Level, occupied: Uint8Array, goal: Uint8Array, t: number): boolean {
  const { w, wall } = level;
  for (const a of [t, t - 1, t - w, t - w - 1]) {
    const b = a + 1;
    const c = a + w;
    const d = c + 1;
    if (a < 0 || d >= wall.length) continue;
    if (!(wall[a] || occupied[a])) continue;
    if (!(wall[b] || occupied[b])) continue;
    if (!(wall[c] || occupied[c])) continue;
    if (!(wall[d] || occupied[d])) continue;
    if ((occupied[a] && !goal[a]) || (occupied[b] && !goal[b]) || (occupied[c] && !goal[c]) || (occupied[d] && !goal[d])) {
      return true;
    }
  }
  return false;
}

/**
 * The shortest walk from `from` to `to` around walls and the boxes in
 * `occupied`, in lower-case letters, first direction first on ties.
 * Throws when `to` is out of reach (the caller only asks for squares
 * its region flood has already reached).
 */
function walkTo(level: Level, occupied: Uint8Array, from: number, to: number): string {
  const { w, wall } = level;
  if (from === to) return '';
  const prev = new Int32Array(wall.length).fill(-1);
  const how: string[] = new Array(wall.length);
  const queue = [from];
  prev[from] = from;
  for (let qi = 0; qi < queue.length; qi++) {
    const p = queue[qi];
    if (p === to) break;
    for (const s of STEPS) {
      const q = p + s.dy * w + s.dx;
      if (q < 0 || q >= wall.length) continue;
      if (wall[q] || occupied[q] || prev[q] !== -1) continue;
      prev[q] = p;
      how[q] = s.walk;
      queue.push(q);
    }
  }
  if (prev[to] === -1) throw new Error('walkTo: the push square is out of reach');
  let out = '';
  for (let p = to; p !== from; p = prev[p]) out = how[p] + out;
  return out;
}

/**
 * The push-optimal solution of `level` by breadth-first search over
 * pushes, or null when the search gives up (or the level has no
 * solution). A state is the boxes' squares and the lowest square of
 * the player's reachable region; the search expands states in order
 * of pushes made, so the first solved state it meets is optimal.
 */
function solvePushOptimal(level: Level, maxStates: number): Solved | null {
  const { w, wall, goals } = level;
  const size = wall.length;
  const goal = new Uint8Array(size);
  for (const g of goals) goal[g] = 1;
  const live = liveSquares(level);
  if (level.boxes.some((b) => !live[b])) return null;
  const occupied = new Uint8Array(size);
  const seen = new Int32Array(size);
  const mark = new Int32Array(size);
  const stack = new Int32Array(size);
  let stamp = 0;
  const solved = (boxes: number[]): boolean => boxes.every((b) => goal[b]);
  // A state's key: the region's lowest square, then the boxes' squares,
  // as digits in base `size` (exact while size ** (boxes + 1) stays
  // under 2 ** 53: a room of up to four boxes on any board drawn here).
  const keyOf = (boxes: number[], low: number): number => {
    let k = low;
    for (const b of boxes) k = k * size + b;
    return k;
  };

  const stateBoxes: number[][] = [level.boxes.slice()];
  const statePlayer: number[] = [level.player];
  const parent: number[] = [-1];
  const pushFrom: number[] = [-1];
  const pushTo: number[] = [-1];
  const pushDir: number[] = [-1];
  const index = new Map<number, number>();
  for (const b of level.boxes) occupied[b] = 1;
  index.set(keyOf(level.boxes, floodRegion(level, occupied, level.player, seen, ++stamp, stack)), 0);
  for (const b of level.boxes) occupied[b] = 0;

  let found = solved(level.boxes) ? 0 : -1;
  for (let head = 0; found < 0 && head < stateBoxes.length; head++) {
    const boxes = stateBoxes[head]!;
    for (const b of boxes) occupied[b] = 1;
    floodRegion(level, occupied, statePlayer[head]!, seen, ++stamp, stack);
    const regionStamp = stamp;
    for (let bi = 0; bi < boxes.length && found < 0; bi++) {
      const b = boxes[bi]!;
      for (let di = 0; di < STEPS.length; di++) {
        const s = STEPS[di]!;
        const d = s.dy * w + s.dx;
        const t = b + d;
        if (t < 0 || t >= size) continue;
        // The player must be able to stand on the square behind the
        // box, and the box must land on open, live floor.
        if (seen[b - d] !== regionStamp) continue;
        if (wall[t] || occupied[t] || !live[t]) continue;
        occupied[b] = 0;
        occupied[t] = 1;
        const frozen = frozenBlock(level, occupied, goal, t);
        let key = -1;
        let next: number[] | null = null;
        if (!frozen) {
          next = boxes.slice();
          next[bi] = t;
          next.sort((a, b2) => a - b2);
          key = keyOf(next, floodRegion(level, occupied, b, mark, ++stamp, stack));
        }
        occupied[t] = 0;
        occupied[b] = 1;
        if (frozen || index.has(key)) continue;
        if (stateBoxes.length >= maxStates) {
          for (const x of boxes) occupied[x] = 0;
          return null;
        }
        index.set(key, stateBoxes.length);
        stateBoxes.push(next!);
        statePlayer.push(b);
        parent.push(head);
        pushFrom.push(b);
        pushTo.push(t);
        pushDir.push(di);
        if (solved(next!)) {
          found = stateBoxes.length - 1;
          break;
        }
      }
    }
    for (const x of boxes) occupied[x] = 0;
  }
  if (found < 0) return null;

  // The path of states, then the moves: walk to each push's square,
  // then push.
  const path: number[] = [];
  for (let s = found; s > 0; s = parent[s]!) path.push(s);
  path.reverse();
  let moves = '';
  let player = level.player;
  let boxes = level.boxes.slice();
  for (const s of path) {
    const nextBoxes = stateBoxes[s]!;
    const from = pushFrom[s]!;
    const to = pushTo[s]!;
    const dir = STEPS[pushDir[s]!]!;
    for (const b of boxes) occupied[b] = 1;
    moves += walkTo(level, occupied, player, from - (dir.dy * w + dir.dx));
    for (const b of boxes) occupied[b] = 0;
    moves += dir.push;
    player = from;
    boxes = nextBoxes;
  }
  return { pushes: path.length, moves };
}

/** One room of a level: its floor squares, boxes and goals. */
interface Room {
  squares: number[];
  boxes: number[];
  goals: number[];
  done: boolean;
}

/**
 * The level's rooms: cut the dead squares of the player's row (the
 * hallway: a box there reaches no goal) out of the floor, and each
 * part left that holds a box is a room. Null when some part holds more
 * or fewer boxes than goals, or a box starts in the hallway: then the
 * level is no set of rooms.
 */
function roomsOf(level: Level): Room[] | null {
  const { w, wall, goals, boxes, player } = level;
  const live = liveSquares(level);
  const row = Math.floor(player / w);
  const cut = new Uint8Array(wall.length);
  for (let i = row * w; i < (row + 1) * w; i++) {
    if (!wall[i] && !live[i]) cut[i] = 1;
  }
  if (boxes.some((b) => cut[b])) return null;
  const part = new Int32Array(wall.length).fill(-1);
  const rooms: Room[] = [];
  for (let s = 0; s < wall.length; s++) {
    if (wall[s] || cut[s] || part[s] >= 0) continue;
    const squares = [s];
    part[s] = rooms.length;
    for (let i = 0; i < squares.length; i++) {
      for (const st of STEPS) {
        const q = squares[i]! + st.dy * w + st.dx;
        if (q < 0 || q >= wall.length) continue;
        if (!wall[q] && !cut[q] && part[q] < 0) {
          part[q] = rooms.length;
          squares.push(q);
        }
      }
    }
    rooms.push({ squares, boxes: [], goals: [], done: false });
  }
  for (const b of boxes) rooms[part[b]!]!.boxes.push(b);
  for (const g of goals) {
    if (part[g]! >= 0) rooms[part[g]!]!.goals.push(g);
  }
  if (goals.some((g) => part[g]! < 0)) return null;
  if (rooms.some((r) => r.boxes.length !== r.goals.length)) return null;
  return rooms.filter((r) => r.boxes.length > 0);
}

/**
 * The level solved room by room: each room's push-optimal solution in
 * turn, the other rooms' boxes standing as walls (on their goals once
 * their room is done), the player walking on from where the last room
 * left it. A box never leaves its room, so the rooms' optima add up
 * to the level's. Null when a room's search gives up, or the level is
 * no set of rooms.
 */
function solveByRooms(level: Level): Solved | null {
  const rooms = roomsOf(level);
  if (rooms === null) return null;
  let player = level.player;
  let pushes = 0;
  let moves = '';
  for (const room of rooms) {
    const wall = level.wall.slice();
    for (const other of rooms) {
      if (other === room) continue;
      for (const b of other.done ? other.goals : other.boxes) wall[b] = 1;
    }
    const sub: Level = {
      w: level.w,
      h: level.h,
      wall,
      goals: room.goals.slice().sort((a, b) => a - b),
      boxes: room.boxes.slice().sort((a, b) => a - b),
      player,
    };
    const solved = solvePushOptimal(sub, ROOM_STATE_CAP);
    if (solved === null) return null;
    pushes += solved.pushes;
    moves += solved.moves;
    player = endOf(level.w, player, solved.moves);
    room.done = true;
  }
  return { pushes, moves };
}

/** The square the player stands on after `moves` from `from` on a board `w` wide. */
function endOf(w: number, from: number, moves: string): number {
  let p = from;
  for (const ch of moves.toLowerCase()) {
    p += ch === 'u' ? -w : ch === 'd' ? w : ch === 'l' ? -1 : 1;
  }
  return p;
}

/**
 * A plain move-based A* over the whole level, the last resort: a state
 * is the player's square and the boxes', every step costs 1, and the
 * estimate is each box's grid distance to its nearest goal, summed.
 * It finds a solution when the push searches give up, at the cost of
 * more pushes than optimal. Null when it runs out of expansions.
 */
function solveMoveAStar(level: Level): Solved | null {
  const { w, wall, goals } = level;
  const size = wall.length;
  const goal = new Uint8Array(size);
  for (const g of goals) goal[g] = 1;
  const distToGoal = (b: number): number => {
    let best = Infinity;
    for (const g of goals) {
      const d = Math.abs((g % w) - (b % w)) + Math.abs(Math.floor(g / w) - Math.floor(b / w));
      if (d < best) best = d;
    }
    return best;
  };
  const estimate = (bs: number[]): number => {
    let sum = 0;
    for (const b of bs) sum += distToGoal(b);
    return sum;
  };
  const keyOf = (p: number, bs: number[]): string => `${p}|${bs.join(',')}`;
  const solved = (bs: number[]): boolean => bs.every((b) => goal[b]);

  const sp: number[] = [level.player];
  const sb: number[][] = [level.boxes.slice()];
  const sg: number[] = [0];
  const parent: number[] = [-1];
  const step: string[] = [''];
  const best = new Map<string, number>([[keyOf(level.player, level.boxes), 0]]);
  // A binary heap on (moves + estimate), deeper g first on ties.
  const heap: [number, number, number][] = [[estimate(level.boxes), 0, 0]];
  const less = (a: [number, number, number], b: [number, number, number]): boolean =>
    a[0] < b[0] || (a[0] === b[0] && (a[1] > b[1] || (a[1] === b[1] && a[2] < b[2])));
  const heapPush = (e: [number, number, number]): void => {
    let i = heap.length;
    heap.push(e);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!less(heap[i]!, heap[p]!)) break;
      [heap[i], heap[p]] = [heap[p]!, heap[i]!];
      i = p;
    }
  };
  const heapPop = (): [number, number, number] => {
    const top = heap[0]!;
    const last = heap.pop()!;
    if (heap.length > 0) {
      heap[0] = last;
      for (let i = 0; ; ) {
        let c = 2 * i + 1;
        if (c >= heap.length) break;
        if (c + 1 < heap.length && less(heap[c + 1]!, heap[c]!)) c++;
        if (!less(heap[c]!, heap[i]!)) break;
        [heap[i], heap[c]] = [heap[c]!, heap[i]!];
        i = c;
      }
    }
    return top;
  };

  let expanded = 0;
  while (heap.length > 0 && expanded < ASTAR_EXPANSION_CAP) {
    const [, g, s] = heapPop();
    if (best.get(keyOf(sp[s]!, sb[s]!)) !== s) continue;
    const bs = sb[s]!;
    if (solved(bs)) {
      let moves = '';
      let pushes = 0;
      for (let t = s; t > 0; t = parent[t]!) {
        moves = step[t]! + moves;
        if (step[t]! >= 'A' && step[t]! <= 'Z') pushes++;
      }
      return { pushes, moves };
    }
    expanded++;
    const p = sp[s]!;
    for (const st of STEPS) {
      const d = st.dy * w + st.dx;
      const q = p + d;
      if (q < 0 || q >= size || wall[q]) continue;
      let nb = bs;
      let move = st.walk;
      const at = bs.indexOf(q);
      if (at >= 0) {
        if (wall[q + d] || bs.includes(q + d)) continue;
        nb = bs.slice();
        nb[at] = q + d;
        nb.sort((a, b) => a - b);
        move = st.push;
      }
      const k = keyOf(q, nb);
      const seen = best.get(k);
      if (seen !== undefined && sg[seen]! <= g + 1) continue;
      const t = sp.length;
      sp.push(q);
      sb.push(nb);
      sg.push(g + 1);
      parent.push(s);
      step.push(move);
      best.set(k, t);
      heapPush([g + 1 + estimate(nb), g + 1, t]);
    }
  }
  return null;
}

/** Solve one level's text: rooms first, then the whole level, then A*. */
function solveLevel(text: string): string {
  const level = parseLevel(text);
  const byRooms = solveByRooms(level);
  if (byRooms !== null) return byRooms.moves;
  const whole = solvePushOptimal(level, WHOLE_STATE_CAP);
  if (whole !== null) return whole.moves;
  const astar = solveMoveAStar(level);
  if (astar !== null) return astar.moves;
  return '';
}

for (const id of readdirSync(INPUT_DIR).sort()) {
  const moves = solveLevel(readFileSync(join(INPUT_DIR, id, 'level.txt'), 'utf8'));
  mkdirSync(join(OUTPUT_DIR, id), { recursive: true });
  writeFileSync(join(OUTPUT_DIR, id, 'solution.txt'), `${moves}\n`);
}
