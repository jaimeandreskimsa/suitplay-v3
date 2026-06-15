/*
 * SuitPlay engine (JS) — réplica exacta del algoritmo de SuitPlay.exe.
 * Espejo de engine.py (validado contra el EXE build 27_01_2019).
 *
 * Modelo: declarante single-dummy vs defensa omnisciente (best defense);
 * el declarante elige la mano que lidera cada truco; la defensa puede
 * continuar el palo o salirse al ganar un truco.
 * Algoritmo: conjuntos Pareto de vectores de bazas por reparto
 * (unión+poda en decisiones del declarante; producto cartesiano con
 * mínimo por componente en observaciones de la defensa).
 *
 * Incluye PlaySession: reconstrucción interactiva de una línea (Play/Line
 * del SuitPlay original): el declarante juega automáticamente su estrategia
 * y el usuario juega las cartas de la defensa.
 */
'use strict';

const RANK_STR = {14:'A',13:'K',12:'Q',11:'J',10:'T',9:'9',8:'8',7:'7',6:'6',5:'5',4:'4',3:'3',2:'2'};
const STR_RANK = {};
for (const [r, s] of Object.entries(RANK_STR)) {
  STR_RANK[s] = +r;
  STR_RANK[s.toLowerCase()] = +r;
}

const bit = r => r ? (1 << (r - 2)) : 0;

function parseCards(str) {
  let m = 0;
  for (const ch of (str || '').trim()) {
    if (ch in STR_RANK) m |= bit(STR_RANK[ch]);
  }
  return m;
}

function bitsOf(mask) {
  const out = [];
  while (mask) {
    const lo = mask & -mask;
    out.push(31 - Math.clz32(lo) + 2);   // rango
    mask ^= lo;
  }
  return out;
}

function fmtMask(mask) {
  const b = bitsOf(mask).sort((a, b2) => b2 - a);
  return b.length ? b.map(r => RANK_STR[r]).join('') : '-';
}

function pc(mask) {
  let c = 0;
  while (mask) { mask &= mask - 1; c++; }
  return c;
}

function comb(n, k) {
  if (k < 0 || k > n) return 0;
  k = Math.min(k, n - k);
  let r = 1;
  for (let i = 0; i < k; i++) r = r * (n - i) / (i + 1);
  return Math.round(r);
}

const SEAT_ORDER = {
  N: ['N', 'E', 'S', 'W'],
  E: ['E', 'S', 'W', 'N'],
  S: ['S', 'W', 'N', 'E'],
  W: ['W', 'N', 'E', 'S'],
};

// ---------------------------------------------------------------- vectores
const INF = 15;

// Presupuesto de tiempo: evita que una combinación pesada congele la pestaña
// o consuma toda la memoria. Se arma en analyze() y se comprueba en los puntos
// calientes (prune/combine). Al agotarse, lanza un error que el worker reenvía.
let DEADLINE = 0;
function setDeadline(ms) { DEADLINE = ms ? Date.now() + ms : 0; }
function checkDeadline() {
  if (DEADLINE && Date.now() > DEADLINE) {
    const e = new Error('TIMEOUT'); e.code = 'TIMEOUT'; throw e;
  }
}

function vecKey(v) {
  return String.fromCharCode.apply(null, v);
}

function vecSum(v) {
  let s = 0;
  for (let i = 0; i < v.length; i++) s += v[i];
  return s;
}

/** u >= t componente a componente. */
function vecGe(u, t) {
  for (let i = 0; i < t.length; i++) {
    if (u[i] < t[i]) return false;
  }
  return true;
}

/** Pareto-máximos de una colección de Uint8Array. Si `preUniq` es true, el
 *  llamante garantiza que no hay duplicados (se ahorra una pasada de claves). */
function prune(vecs, preUniq) {
  if (vecs.length <= 1) return vecs.slice();
  let uniq;
  if (preUniq) {
    uniq = vecs;
  } else {
    const seen = new Set();
    uniq = [];
    for (const v of vecs) {
      const k = vecKey(v);
      if (!seen.has(k)) { seen.add(k); uniq.push(v); }
    }
  }
  if (uniq.length === 1) return uniq;
  // ordena por suma desc; los vectores se procesan de "mayor" a "menor", de
  // modo que un vector solo puede ser dominado por otro ya conservado.
  const withSum = uniq.map(v => [vecSum(v), v]);
  withSum.sort((a, b) => {
    if (b[0] !== a[0]) return b[0] - a[0];
    const x = a[1], y = b[1];
    for (let i = 0; i < x.length; i++) {
      if (x[i] !== y[i]) return y[i] - x[i];
    }
    return 0;
  });
  const kept = [];
  const keptSums = [];
  let guard = 0;
  outer:
  for (const [sv, v] of withSum) {
    if ((++guard & 2047) === 0) checkDeadline();
    for (let k = 0; k < kept.length; k++) {
      // un vector de igual suma no puede dominar (sería idéntico, ya único)
      if (keptSums[k] === sv) continue;
      if (vecGe(kept[k], v)) continue outer;
    }
    kept.push(v);
    keptSums.push(sv);
  }
  return kept;
}

function allIdx(nd) {
  const a = new Array(nd);
  for (let i = 0; i < nd; i++) a[i] = i;
  return a;
}

/** Producto de ramas de observación con mínimo por componente. */
function combine(branches, nd) {
  const expanded = branches.map(([idxs, vecs]) => {
    return vecs.map(v => {
      const r = new Uint8Array(nd).fill(INF);
      for (let k = 0; k < idxs.length; k++) r[idxs[k]] = v[k];
      return r;
    });
  });
  expanded.sort((a, b) => a.length - b.length);
  let partials = [new Uint8Array(nd).fill(INF)];
  for (const evecs of expanded) {
    const seen = new Set();
    const next = [];
    for (const p of partials) {
      checkDeadline();
      for (const v of evecs) {
        const m = new Uint8Array(nd);
        for (let i = 0; i < nd; i++) m[i] = p[i] < v[i] ? p[i] : v[i];
        const k = vecKey(m);
        if (!seen.has(k)) { seen.add(k); next.push(m); }
      }
    }
    partials = prune(next, true);   // next ya es único (dedup por `seen`)
  }
  return partials;
}

/** Representantes de clases de equivalencia (cartas consecutivas en ctx
 *  pertenecientes a avail son intercambiables). */
function reduceEquiv(avail, ctx) {
  const reps = [];
  let prevIn = false;
  let b = ctx;
  while (b) {
    const lo = b & -b;
    if (avail & lo) {
      if (!prevIn) reps.push(31 - Math.clz32(lo) + 2);
      prevIn = true;
    } else {
      prevIn = false;
    }
    b ^= lo;
  }
  return reps;
}

// ---------------------------------------------------------------- solver
class Solver {
  constructor(allowDefenderLead = true) {
    this.memo = new Map();
    this.stepMemo = new Map();
    this.allowDefenderLead = allowDefenderLead;
    this.nodes = 0;
    this.onProgress = null;
  }

  _rankMap(all) {
    const map = new Int8Array(13).fill(-1);
    let pos = 0;
    for (let b = 0; b < 13; b++) {
      if (all >> b & 1) map[b] = pos++;
    }
    return map;
  }

  _canonKey(n, s, ew, dists, lead) {
    const map = this._rankMap(n | s | ew);
    const remap = m => {
      let r = 0;
      while (m) {
        const lo = m & -m;
        r |= 1 << map[31 - Math.clz32(lo)];
        m ^= lo;
      }
      return r;
    };
    let key = remap(n) + '|' + remap(s) + '|' + remap(ew) + '|' + lead + '|';
    const parts = new Array(dists.length);
    for (let i = 0; i < dists.length; i++) parts[i] = remap(dists[i]);
    return key + parts.join(',');
  }

  _stepKey(n, s, ew, leader, played, subset) {
    const map = this._rankMap(n | s | ew);
    const remap = m => {
      let r = 0;
      while (m) {
        const lo = m & -m;
        r |= 1 << map[31 - Math.clz32(lo)];
        m ^= lo;
      }
      return r;
    };
    const pl = played.map(p => p[1] ? (map[p[1] - 2] + 1) : 0).join('.');
    const parts = new Array(subset.length);
    for (let i = 0; i < subset.length; i++) parts[i] = remap(subset[i]);
    return remap(n) + '|' + remap(s) + '|' + remap(ew) + '|' + leader +
           '|' + pl + '|' + parts.join(',');
  }

  /** Carreras de cartas EW consecutivas (sin carta NS entre medias) dado el
   *  conjunto de cartas presentes `ctx`. Cada carrera se devuelve de mayor a
   *  menor. Las cartas dentro de una carrera son intercambiables. */
  _runs(ctx, ew) {
    const runs = [];
    let cur = null;
    for (const r of bitsOf(ctx).sort((a, b) => b - a)) {
      const rb = bit(r);
      if (ew & rb) {
        if (!cur) { cur = []; runs.push(cur); }
        cur.push(rb);
      } else {
        cur = null;            // una carta NS rompe la carrera
      }
    }
    return runs;
  }

  /** Agrupa las distribuciones estructuralmente equivalentes: dos máscaras
   *  son equivalentes si tienen el mismo número de cartas de West en cada
   *  carrera (las cartas de una carrera son intercambiables, así que bajo
   *  cualquier estrategia fija dan las mismas bazas). Devuelve representantes
   *  canónicos y el mapeo dist->clase. */
  _classify(ctx, ew, dists) {
    const runs = this._runs(ctx, ew);
    const byKey = new Map();
    const reps = [];
    const map = new Array(dists.length);
    for (let i = 0; i < dists.length; i++) {
      const d = dists[i];
      let key = '';
      for (const run of runs) {
        let cnt = 0;
        for (const rb of run) if (d & rb) cnt++;
        key += cnt + ',';
      }
      let ci = byKey.get(key);
      if (ci === undefined) {
        ci = reps.length;
        byKey.set(key, ci);
        let repMask = 0;
        for (const run of runs) {
          let cnt = 0;
          for (const rb of run) if (d & rb) cnt++;
          for (let k = 0; k < cnt; k++) repMask |= run[k];  // top cnt a West
        }
        reps.push(repMask);
      }
      map[i] = ci;
    }
    return { reps, map };
  }

  solve(n, s, ew, dists, lead) {
    const nd = dists.length;
    if (n === 0 && s === 0) return [new Uint8Array(nd)];
    if (ew === 0) {
      const v = new Uint8Array(nd).fill(Math.max(pc(n), pc(s)));
      return [v];
    }
    // Colapsa distribuciones equivalentes: resuelve sobre representantes y
    // expande el resultado. Reduce drásticamente la dimensión de los vectores
    // (y por tanto el tamaño de las fronteras de Pareto) sin cambiar el
    // resultado: las columnas equivalentes siempre comparten valor. A medida
    // que se retiran honores, más distribuciones colapsan (igual que el EXE).
    const cls = this._classify(n | s | ew, ew, dists);
    if (cls.reps.length < nd) {
      const reduced = this.solve(n, s, ew, cls.reps, lead);
      return reduced.map(rv => {
        const full = new Uint8Array(nd);
        for (let i = 0; i < nd; i++) full[i] = rv[cls.map[i]];
        return full;
      });
    }
    const key = this._canonKey(n, s, ew, dists, lead);
    let hit = this.memo.get(key);
    if (hit === undefined) {
      this.nodes++;
      if (this.onProgress && (this.nodes & 255) === 0) {
        this.onProgress(this.nodes);
      }
      hit = this._solveNode(n, s, ew, dists, lead);
      this.memo.set(key, hit);
    }
    return hit;
  }

  _solveNode(n, s, ew, dists, lead) {
    const nd = dists.length;
    const ctx = n | s | ew;
    if (lead === 'NS') {
      const results = [];
      for (const [seat, hand] of [['N', n], ['S', s]]) {
        if (!hand) continue;
        for (const c of reduceEquiv(hand, ctx)) {
          for (const v of this._play(n, s, ew, dists, seat, c)) {
            results.push(v);
          }
        }
      }
      return prune(results);
    }
    // defensa al mando: salirse (declarante lidera) o continuar el palo
    const branches = [[allIdx(nd), this.solve(n, s, ew, dists, 'NS')]];
    if (this.allowDefenderLead) {
      const groups = this.leadGroups(ew, dists, lead);
      for (const [c, idxs] of groups) {
        if (c === 0) continue;           // sin cartas: solo puede salirse
        const sub = idxs.map(j => dists[j]);
        branches.push([idxs, this._play(n, s, ew, sub, lead, c)]);
      }
    }
    return combine(branches, nd);
  }

  /** Agrupa los repartos por carta jugable del defensor `seat` (0 = fallo). */
  followGroups(ew, subset, seat) {
    const groups = new Map();
    for (let j = 0; j < subset.length; j++) {
      const hand = seat === 'W' ? subset[j] : (ew ^ subset[j]);
      if (hand === 0) {
        let g = groups.get(0);
        if (!g) { g = []; groups.set(0, g); }
        g.push(j);
      } else {
        for (const c of bitsOf(hand)) {
          let g = groups.get(c);
          if (!g) { g = []; groups.set(c, g); }
          g.push(j);
        }
      }
    }
    return groups;
  }

  /** Cartas con las que el defensor `seat` puede liderar (sin opción de fallo). */
  leadGroups(ew, dists, seat) {
    const groups = new Map();
    for (let j = 0; j < dists.length; j++) {
      const hand = seat === 'W' ? dists[j] : (ew ^ dists[j]);
      for (const c of bitsOf(hand)) {
        let g = groups.get(c);
        if (!g) { g = []; groups.set(c, g); }
        g.push(j);
      }
    }
    return groups;
  }

  _play(n, s, ew, dists, leader, leadCard) {
    // Si lidera el declarante (carta NS, ajena a la reducción de EW), colapsa
    // las distribuciones equivalentes: la reconstrucción del primer truco
    // sobre todas las distribuciones se dispararía igual que el solver sin
    // optimizar. Las columnas equivalentes comparten valor, así que es exacto.
    if (dists.length > 1 && (bit(leadCard) & ew) === 0) {
      const cls = this._classify(n | s | ew, ew, dists);
      if (cls.reps.length < dists.length) {
        const reduced = this._play(n, s, ew, cls.reps, leader, leadCard);
        return reduced.map(rv => {
          const full = new Uint8Array(dists.length);
          for (let i = 0; i < dists.length; i++) full[i] = rv[cls.map[i]];
          return full;
        });
      }
    }
    return this._step(n, s, ew, leader, [[leader, leadCard]],
                      Array.from(dists));
  }

  /** Nodo dentro de un truco: `played` = [[asiento, carta]...] ya jugadas. */
  _step(n, s, ew, leader, played, subset) {
    if (played.length === 4) {
      return this._finish(n, s, ew, leader, played, subset);
    }
    const key = this._stepKey(n, s, ew, leader, played, subset);
    let hit = this.stepMemo.get(key);
    if (hit === undefined) {
      hit = this._stepNode(n, s, ew, leader, played, subset);
      this.stepMemo.set(key, hit);
    }
    return hit;
  }

  _stepNode(n, s, ew, leader, played, subset) {
    const idx = played.length;
    const seat = SEAT_ORDER[leader][idx];
    const ctx = n | s | ew;
    if (seat === 'N' || seat === 'S') {
      const hand = seat === 'N' ? n : s;
      if (hand === 0) {
        return this._step(n, s, ew, leader, played.concat([[seat, 0]]), subset);
      }
      const results = [];
      for (const c of reduceEquiv(hand, ctx)) {
        for (const v of this._step(n, s, ew, leader,
                                   played.concat([[seat, c]]), subset)) {
          results.push(v);
        }
      }
      return prune(results);
    }
    const groups = this.followGroups(ew, subset, seat);
    const branches = [];
    for (const [c, idxs] of groups) {
      const sub = idxs.map(j => subset[j]);
      branches.push([idxs, this._step(n, s, ew, leader,
                                      played.concat([[seat, c]]), sub)]);
    }
    return combine(branches, subset.length);
  }

  _finish(n, s, ew, leader, played, subset) {
    let wseat = null, wcard = -1;
    const cards = {N: 0, S: 0, W: 0, E: 0};
    for (const [seat, c] of played) {
      cards[seat] = c;
      if (c > wcard) { wseat = seat; wcard = c; }
    }
    const td = (wseat === 'N' || wseat === 'S') ? 1 : 0;
    const n2 = n & ~bit(cards.N);
    const s2 = s & ~bit(cards.S);
    const wb = bit(cards.W), eb = bit(cards.E);
    const ew2 = ew & ~(wb | eb);
    const nds = subset.map(d => d & ~wb);
    const nlead = td ? 'NS' : wseat;
    const sub = this.solve(n2, s2, ew2, nds, nlead);
    if (!td) return sub;
    return sub.map(v => {
      const r = new Uint8Array(v.length);
      for (let i = 0; i < v.length; i++) r[i] = v[i] + 1;
      return r;
    });
  }
}

// ---------------------------------------------------------------- análisis
class Analysis {
  constructor(north, south, vacW = 13, vacE = 13, opts = {}) {
    this.northStr = (north || '').toUpperCase();
    this.southStr = (south || '').toUpperCase();
    this.n = parseCards(north);
    this.s = parseCards(south);
    let full = 0;
    for (let r = 2; r <= 14; r++) full |= bit(r);
    this.ew = full & ~(this.n | this.s);
    this.t = pc(this.ew);
    this.vacW = vacW;
    this.vacE = vacE;

    const ewb = bitsOf(this.ew).sort((a, b) => a - b);
    const dists = [];
    for (let msk = 0; msk < (1 << this.t); msk++) {
      let w = 0;
      for (let i = 0; i < this.t; i++) {
        if (msk >> i & 1) w |= bit(ewb[i]);
      }
      dists.push(w);
    }
    this.dists = dists;
    const tot = comb(vacW + vacE, this.t);
    this.probs = dists.map(w => {
      const nw = pc(w), ne = this.t - nw;
      return comb(vacW, nw) * comb(vacE, ne) / (tot * comb(this.t, nw));
    });

    this.solver = new Solver(opts.allowDefenderLead !== false);
    if (opts.onProgress) this.solver.onProgress = opts.onProgress;
    const packed = this.solver.solve(this.n, this.s, this.ew, dists, 'NS');
    this.frontier = packed.map(v => Array.from(v));
    this.maxTricks = 0;
    for (const v of this.frontier) {
      for (const t of v) if (t > this.maxTricks) this.maxTricks = t;
    }
    this.solverNodes = this.solver.nodes;
  }

  pGe(vec, goal) {
    let p = 0;
    for (let i = 0; i < vec.length; i++) {
      if (vec[i] >= goal) p += this.probs[i];
    }
    return p;
  }

  expected(vec) {
    let e = 0;
    for (let i = 0; i < vec.length; i++) e += this.probs[i] * vec[i];
    return e;
  }

  /** Selección de líneas como el EXE (ver engine.py). */
  selectLines() {
    const eps = 1e-12;
    const goals = [];
    for (let g = this.maxTricks; g >= 1; g--) goals.push(g);
    this.bestP = {};
    for (const g of goals) {
      let best = 0;
      for (const v of this.frontier) {
        const p = this.pGe(v, g);
        if (p > best) best = p;
      }
      this.bestP[g] = best;
    }
    const chosen = [];
    const chosenKeys = new Set();
    const add = v => {
      const k = v.join(',');
      if (!chosenKeys.has(k)) { chosenKeys.add(k); chosen.push(v); }
    };
    const consideredGoals = [];
    for (const g of goals) {
      consideredGoals.push(g);
      const cands = this.frontier.filter(
        v => this.pGe(v, g) >= this.bestP[g] - eps);
      const classes = new Map();
      for (const v of cands) {
        const key = v.map((t, i) => t >= g ? i : -1)
                     .filter(i => i >= 0).join(',');
        let cls = classes.get(key);
        if (!cls) { cls = []; classes.set(key, cls); }
        cls.push(v);
      }
      // por clase: todas las que empatan la esperanza maxima de la clase
      const reps = [];
      for (const cls of classes.values()) {
        let maxE = -1;
        for (const v of cls) {
          const e = this.expected(v);
          if (e > maxE) maxE = e;
        }
        for (const v of cls) {
          if (this.expected(v) >= maxE - 1e-9) reps.push(v);
        }
      }
      reps.sort((a, b) => this.expected(b) - this.expected(a));
      for (const v of reps) add(v);
      if (this.bestP[g] >= 1 - eps) break;
    }
    this.consideredGoals = consideredGoals;
    let mpVec = this.frontier[0];
    for (const v of this.frontier) {
      if (this.expected(v) > this.expected(mpVec)) mpVec = v;
    }
    add(mpVec);
    // orden: esperanza desc; en empate exacto, mas bazas en los repartos
    // con West mas largo primero (orden del EXE)
    chosen.sort((a, b) => {
      const ea = this.expected(a), eb = this.expected(b);
      if (Math.abs(ea - eb) > 1e-9) return eb - ea;
      for (let i = a.length - 1; i >= 0; i--) {
        if (a[i] !== b[i]) return b[i] - a[i];
      }
      return 0;
    });
    const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    this.lines = chosen.map((v, i) => [letters[i] || ('L' + i), v]);
    // mp-best: todas las lineas empatadas en esperanza maxima
    const maxE = this.expected(mpVec);
    this.mpLabel = this.lines
      .filter(([, v]) => this.expected(v) >= maxE - 1e-9)
      .map(([lb]) => lb).join('');
    // goals mostrados (regla del EXE): un goal al 100% se oculta si sus
    // lineas optimas son las mismas que las del goal mostrado anterior
    this.goalsShown = [];
    let prevLabels = null;
    for (const g of this.consideredGoals) {
      const labels = this.lines
        .filter(([, v]) => this.pGe(v, g) >= this.bestP[g] - eps)
        .map(([lb]) => lb).join('');
      if (this.bestP[g] < 1 - eps || labels !== prevLabels) {
        this.goalsShown.push(g);
        prevLabels = labels;
      }
      if (this.bestP[g] >= 1 - eps) break;
    }
    return this.lines;
  }

  /** Cartas EW 'x': pequeñas (<T) equivalentes a la más baja para todas las
   *  líneas. Los honores (A K Q J T) nunca se pliegan: siempre se muestran con
   *  su rango en la tabla West-East, aunque su posición no cambie las bazas
   *  (p. ej. un As de la defensa que siempre gana una baza esté donde esté). */
  honorClasses() {
    const vecs = this.lines.map(([, v]) => v);
    const ewb = bitsOf(this.ew).sort((a, b) => a - b);
    if (!ewb.length) return [0, 0];
    const HONOR = 10;                       // T o superior: siempre visible
    const spots = ewb.filter(r => r < HONOR);
    if (!spots.length) return [this.ew, 0]; // solo honores: mostrar todo
    const lowest = spots[0];
    const out = new Map();
    this.dists.forEach((w, i) => {
      out.set(w, vecs.map(v => v[i]).join(','));
    });
    let xmask = bit(lowest);
    const lb = bit(lowest);
    for (const c of spots.slice(1)) {
      const cb = bit(c);
      let ok = true;
      for (const w of this.dists) {
        if (((w & cb) !== 0) !== ((w & lb) !== 0)) {
          if (out.get(w) !== out.get(w ^ cb ^ lb)) { ok = false; break; }
        }
      }
      if (ok) xmask |= cb;
    }
    return [this.ew & ~xmask, xmask];
  }

  buildTable() {
    const [hmask] = this.honorClasses();
    this.honorMask = hmask;
    const groups = new Map();
    this.dists.forEach((w, i) => {
      const wh = w & hmask;
      const nwSmall = pc(w) - pc(wh);
      const key = wh + '|' + nwSmall;
      let g = groups.get(key);
      if (!g) {
        g = {wh, nwSmall, count: 0, prob: 0, rep: i};
        groups.set(key, g);
      }
      g.count++;
      g.prob += this.probs[i];
    });
    const rows = [];
    for (const g of groups.values()) {
      const i = g.rep;
      const eFull = this.ew ^ this.dists[i];
      const eh = eFull & hmask;
      const tricks = {};
      for (const [lb, v] of this.lines) tricks[lb] = v[i];
      rows.push({
        wh: g.wh, eh,
        nwSmall: g.nwSmall,
        neSmall: pc(eFull) - pc(eh),
        count: g.count, prob: g.prob, tricks,
      });
    }
    rows.sort((a, b) => {
      const ha = bitsOf(a.wh).sort((x, y) => y - x);
      const hb = bitsOf(b.wh).sort((x, y) => y - x);
      for (let i = 0; i < Math.max(ha.length, hb.length); i++) {
        const x = ha[i] ?? -1, y = hb[i] ?? -1;
        if (x !== y) return y - x;
      }
      const la = pc(a.wh) + a.nwSmall, lbn = pc(b.wh) + b.nwSmall;
      return lbn - la;
    });
    this.table = rows;
    return rows;
  }
}

// ---------------------------------------------------------------- play
/**
 * Sesión interactiva de juego para una línea (Play/Line del original).
 * El declarante juega su estrategia automáticamente; el usuario juega
 * las cartas de la defensa. La estrategia se reconstruye siguiendo un
 * vector objetivo: en cada decisión del declarante se elige una jugada
 * cuyo conjunto de estrategias contenga un vector >= objetivo.
 */
class PlaySession {
  constructor(analysis) {
    this.a = analysis;
    this.solver = analysis.solver;
    this.lineLabel = null;
  }

  start(lineLabel) {
    const line = this.a.lines.find(([lb]) => lb === lineLabel);
    if (!line) throw new Error('línea desconocida: ' + lineLabel);
    this.lineLabel = lineLabel;
    this.st = {
      n: this.a.n, s: this.a.s, ew: this.a.ew,
      dists: this.a.dists.slice(),
      probs: this.a.probs.slice(),
      target: line[1].slice(),
      leader: 'NS',           // 'NS' o asiento defensor que lidera
      trick: null,            // {leaderSeat, plays: [[seat, card]...]}
      tricksWon: 0, trickNum: 1,
      log: [], finished: false, finalNote: null,
      waiting: null,          // {type:'follow'|'lead', seat, groups}
    };
    this.hist = [];
    this._advance();
    return this.getState();
  }

  _snap() {
    const st = this.st;
    this.hist.push(JSON.parse(JSON.stringify({
      n: st.n, s: st.s, ew: st.ew, dists: st.dists, probs: st.probs,
      target: st.target, leader: st.leader, trick: st.trick,
      tricksWon: st.tricksWon, trickNum: st.trickNum, log: st.log,
      finished: st.finished, finalNote: st.finalNote,
    })));
  }

  back() {
    if (this.hist.length) {
      const prev = this.hist.pop();
      this.st = prev;
      this.st.waiting = null;
      this._advance();
    }
    return this.getState();
  }

  restart() {
    return this.start(this.lineLabel);
  }

  /** opción del usuario: {kind:'card', rank} | {kind:'showout'} | {kind:'exit'} */
  choose(opt) {
    const st = this.st;
    if (!st.waiting) return this.getState();
    this._snap();
    const seat = st.waiting.seat;
    if (st.waiting.type === 'lead') {
      if (opt.kind === 'exit') {
        const set = this.solver.solve(st.n, st.s, st.ew, st.dists, 'NS');
        st.target = this._pick(set, st.target);
        st.leader = 'NS';
      } else {
        const groups = this.solver.leadGroups(st.ew, st.dists, seat);
        const idxs = groups.get(opt.rank);
        this._filter(idxs);
        const set = this.solver._play(st.n, st.s, st.ew, st.dists, seat, opt.rank);
        st.target = this._pick(set, st.target);
        st.trick = {leaderSeat: seat, plays: [[seat, opt.rank]]};
      }
    } else {
      // follow: carta del defensor dentro del truco (0 = fallo)
      const rank = opt.kind === 'showout' ? 0 : opt.rank;
      const groups = this.solver.followGroups(st.ew, st.dists, seat);
      const idxs = groups.get(rank);
      this._filter(idxs);
      const plays = st.trick.plays.concat([[seat, rank]]);
      const set = this.solver._step(st.n, st.s, st.ew, st.trick.leaderSeat,
                                    plays, st.dists);
      st.target = this._pick(set, st.target);
      st.trick.plays = plays;
    }
    st.waiting = null;
    this._advance();
    return this.getState();
  }

  /** Juega automáticamente la opción "natural" de la defensa (la más baja). */
  autoPlay() {
    const st = this.st;
    if (!st.waiting) return this.getState();
    const opts = this._options();
    let best = opts.find(o => o.kind === 'card');
    if (!best) best = opts[0];
    return this.choose(best);
  }

  _filter(idxs) {
    const st = this.st;
    st.dists = idxs.map(j => st.dists[j]);
    st.probs = idxs.map(j => st.probs[j]);
    st.target = idxs.map(j => st.target[j]);
  }

  _pick(set, target) {
    for (const u of set) {
      if (vecGe(u, target)) return Array.from(u);
    }
    throw new Error('reconstrucción fallida: objetivo inalcanzable');
  }

  _advance() {
    const st = this.st;
    while (!st.finished && !st.waiting) {
      if (!st.trick) {
        if (st.n === 0 && st.s === 0) {
          st.finished = true;
          st.finalNote = 'la jugada ha terminado — bazas NS: ' + st.tricksWon;
          break;
        }
        if (st.ew === 0) {
          const rest = Math.max(pc(st.n), pc(st.s));
          st.tricksWon += rest;
          st.finished = true;
          st.finalNote = 'la defensa no tiene cartas: NS cobra el resto (+' +
                         rest + ') — bazas NS: ' + st.tricksWon;
          break;
        }
        if (st.leader === 'NS') {
          this._declarerLead();
        } else {
          // defensor al mando
          const groups = this.solver.leadGroups(st.ew, st.dists, st.leader);
          if (groups.size === 0 || !this.solver.allowDefenderLead) {
            const set = this.solver.solve(st.n, st.s, st.ew, st.dists, 'NS');
            st.target = this._pick(set, st.target);
            st.leader = 'NS';
          } else {
            st.waiting = {type: 'lead', seat: st.leader};
          }
        }
        continue;
      }
      // dentro del truco
      const plays = st.trick.plays;
      if (plays.length === 4) {
        this._endTrick();
        continue;
      }
      const seat = SEAT_ORDER[st.trick.leaderSeat][plays.length];
      if (seat === 'N' || seat === 'S') {
        this._declarerFollow(seat);
      } else {
        const groups = this.solver.followGroups(st.ew, st.dists, seat);
        if (groups.size === 1) {
          // sin alternativas (p. ej. fallo seguro): automático
          const [rank, idxs] = groups.entries().next().value;
          this._filter(idxs);
          const npl = plays.concat([[seat, rank]]);
          const set = this.solver._step(st.n, st.s, st.ew,
                                        st.trick.leaderSeat, npl, st.dists);
          st.target = this._pick(set, st.target);
          st.trick.plays = npl;
        } else {
          st.waiting = {type: 'follow', seat};
        }
      }
    }
  }

  _declarerLead() {
    const st = this.st;
    const ctx = st.n | st.s | st.ew;
    for (const [seat, hand] of [['N', st.n], ['S', st.s]]) {
      if (!hand) continue;
      // Preferencia humana: cuando hay que perder una baza igual, cobra los
      // honores antes que pinchar chico. Probamos las cartas de mayor a menor;
      // como solo se acepta una jugada que alcance el vector objetivo, en
      // posiciones de finesse seguirá jugando chico (cobrar sería subóptimo).
      for (const c of reduceEquiv(hand, ctx).sort((x, y) => y - x)) {
        const set = this.solver._play(st.n, st.s, st.ew, st.dists, seat, c);
        for (const u of set) {
          if (vecGe(u, st.target)) {
            st.target = Array.from(u);
            st.trick = {leaderSeat: seat, plays: [[seat, c]]};
            return;
          }
        }
      }
    }
    throw new Error('reconstrucción fallida en el liderazgo');
  }

  _declarerFollow(seat) {
    const st = this.st;
    const hand = seat === 'N' ? st.n : st.s;
    const plays = st.trick.plays;
    if (hand === 0) {
      const npl = plays.concat([[seat, 0]]);
      const set = this.solver._step(st.n, st.s, st.ew, st.trick.leaderSeat,
                                    npl, st.dists);
      st.target = this._pick(set, st.target);
      st.trick.plays = npl;
      return;
    }
    const ctx = st.n | st.s | st.ew;
    // misma preferencia que en el liderazgo: cartas de mayor a menor.
    for (const c of reduceEquiv(hand, ctx).sort((x, y) => y - x)) {
      const npl = plays.concat([[seat, c]]);
      const set = this.solver._step(st.n, st.s, st.ew, st.trick.leaderSeat,
                                    npl, st.dists);
      for (const u of set) {
        if (vecGe(u, st.target)) {
          st.target = Array.from(u);
          st.trick.plays = npl;
          return;
        }
      }
    }
    throw new Error('reconstrucción fallida (mano ' + seat + ')');
  }

  _endTrick() {
    const st = this.st;
    const plays = st.trick.plays;
    let wseat = null, wcard = -1;
    const cards = {N: 0, S: 0, W: 0, E: 0};
    for (const [seat, c] of plays) {
      cards[seat] = c;
      if (c > wcard) { wseat = seat; wcard = c; }
    }
    const td = (wseat === 'N' || wseat === 'S') ? 1 : 0;
    st.log.push({
      num: st.trickNum,
      plays: plays.map(([seat, c]) => [seat, c]),
      winner: wseat, ns: td === 1,
    });
    st.tricksWon += td;
    st.trickNum++;
    st.n &= ~bit(cards.N);
    st.s &= ~bit(cards.S);
    const wb = bit(cards.W), eb = bit(cards.E);
    st.ew &= ~(wb | eb);
    st.dists = st.dists.map(d => d & ~wb);
    st.target = st.target.map(t => t - td);
    st.leader = td ? 'NS' : wseat;
    st.trick = null;
  }

  _options() {
    const st = this.st;
    if (!st.waiting) return [];
    const seat = st.waiting.seat;
    const out = [];
    if (st.waiting.type === 'lead') {
      const groups = this.solver.leadGroups(st.ew, st.dists, seat);
      const cards = Array.from(groups.keys()).sort((a, b) => b - a);
      for (const c of cards) {
        const idxs = groups.get(c);
        out.push({kind: 'card', rank: c, count: idxs.length,
                  prob: idxs.reduce((p, j) => p + st.probs[j], 0)});
      }
      out.push({kind: 'exit', count: st.dists.length,
                prob: st.probs.reduce((a, b) => a + b, 0)});
    } else {
      const groups = this.solver.followGroups(st.ew, st.dists, seat);
      const cards = Array.from(groups.keys()).sort((a, b) => b - a);
      for (const c of cards) {
        const idxs = groups.get(c);
        if (c === 0) {
          out.push({kind: 'showout', count: idxs.length,
                    prob: idxs.reduce((p, j) => p + st.probs[j], 0)});
        } else {
          out.push({kind: 'card', rank: c, count: idxs.length,
                    prob: idxs.reduce((p, j) => p + st.probs[j], 0)});
        }
      }
    }
    return out;
  }

  getState() {
    const st = this.st;
    return {
      line: this.lineLabel,
      finished: st.finished,
      finalNote: st.finalNote,
      tricksWon: st.tricksWon,
      trickNum: st.trickNum,
      northRem: fmtMask(st.n), southRem: fmtMask(st.s),
      trick: st.trick ? {
        leaderSeat: st.trick.leaderSeat,
        plays: st.trick.plays.map(([seat, c]) => ({
          seat, rank: c, str: c ? RANK_STR[c] : '—',
        })),
      } : null,
      waiting: st.waiting ? {
        type: st.waiting.type, seat: st.waiting.seat,
        options: this._options().map(o => ({
          ...o, str: o.kind === 'card' ? RANK_STR[o.rank] :
                     o.kind === 'showout' ? 'fallo' : 'salirse',
        })),
      } : null,
      compat: {
        count: st.dists.length,
        prob: st.probs.reduce((a, b) => a + b, 0),
      },
      log: st.log.map(e => ({
        num: e.num, winner: e.winner, ns: e.ns,
        plays: e.plays.map(([seat, c]) => ({
          seat, str: c ? RANK_STR[c] : '—',
        })),
      })),
      canBack: this.hist.length > 0,
    };
  }
}

function fmtWE(hmask, nsmall) {
  const h = bitsOf(hmask).sort((a, b) => b - a)
    .map(r => RANK_STR[r]).join('');
  return h + 'x'.repeat(nsmall);
}

/** Juega una línea de principio a fin con la defensa "natural" (carta más
 *  baja) y devuelve la secuencia completa de bazas, para narrar cómo se juega
 *  la línea sin obligar al usuario a jugarla carta por carta. */
function autoLine(analysis, label) {
  const ps = new PlaySession(analysis);
  ps.start(label);
  let guard = 0;
  while (!ps.st.finished && guard++ < 200) ps.autoPlay();
  const st = ps.getState();
  return { line: label, tricks: st.log, tricksWon: st.tricksWon,
           finalNote: st.finalNote };
}

function analyze(north, south, vacW = 13, vacE = 13, opts = {}) {
  const limit = opts.timeLimitMs !== undefined ? opts.timeLimitMs : 60000;
  setDeadline(limit);
  try {
    const a = new Analysis(north, south, vacW, vacE, opts);
    a.selectLines();
    a.buildTable();
    return a;
  } finally {
    setDeadline(0);
  }
}

// exports (Node + browser)
const SuitPlayEngine = {
  Analysis, PlaySession, analyze, autoLine, parseCards, fmtMask, fmtWE,
  bitsOf, pc, bit, RANK_STR, STR_RANK, comb,
};
if (typeof module !== 'undefined' && module.exports) {
  module.exports = SuitPlayEngine;
}
if (typeof self !== 'undefined') {
  self.SuitPlayEngine = SuitPlayEngine;
}
