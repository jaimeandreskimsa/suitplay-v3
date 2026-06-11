/* Worker de cálculo de SuitPlay Pro: motor + sesiones de juego. */
'use strict';
importScripts('engine.js');

const analyses = new Map();
let session = null;

function summarize(a) {
  const goals = a.goalsShown.map(g => ({
    g, prob: a.bestP[g],
    labels: a.lines.filter(([, v]) => a.pGe(v, g) >= a.bestP[g] - 1e-12)
                   .map(([lb]) => lb).join(''),
  }));
  const lines = a.lines.map(([lb, v]) => ({
    label: lb, expected: a.expected(v),
    pGoals: a.goalsShown.map(g => ({g, p: a.pGe(v, g)})),
  }));
  const rows = a.table.map(r => ({
    we: SuitPlayEngine.fmtWE(r.wh, r.nwSmall) + ' - ' +
        SuitPlayEngine.fmtWE(r.eh, r.neSmall),
    count: r.count, prob: r.prob, tricks: r.tricks,
  }));
  return {goals, lines, rows, mpLabel: a.mpLabel,
          ewStr: SuitPlayEngine.fmtMask(a.ew), t: a.t,
          frontier: a.frontier.length, nodes: a.solverNodes};
}

self.onmessage = function (e) {
  const m = e.data;
  try {
    if (m.cmd === 'analyze') {
      const key = m.key;
      let a = analyses.get(key);
      const t0 = Date.now();
      const cached = !!a;
      if (!a) {
        a = SuitPlayEngine.analyze(m.north, m.south, m.vacW, m.vacE, {
          onProgress: n => self.postMessage({id: m.id, type: 'progress', nodes: n}),
        });
        analyses.set(key, a);
      }
      const data = summarize(a);
      data.secs = (Date.now() - t0) / 1000;
      data.cached = cached;
      self.postMessage({id: m.id, type: 'done', data});
    } else if (m.cmd === 'isCached') {
      self.postMessage({id: m.id, type: 'cached', cached: analyses.has(m.key)});
    } else if (m.cmd === 'playStart') {
      const a = analyses.get(m.key);
      if (!a) { self.postMessage({id: m.id, type: 'reanalyze'}); return; }
      session = new SuitPlayEngine.PlaySession(a);
      self.postMessage({id: m.id, type: 'playState', state: session.start(m.line)});
    } else if (m.cmd === 'playChoose') {
      self.postMessage({id: m.id, type: 'playState', state: session.choose(m.option)});
    } else if (m.cmd === 'playAuto') {
      self.postMessage({id: m.id, type: 'playState', state: session.autoPlay()});
    } else if (m.cmd === 'playBack') {
      self.postMessage({id: m.id, type: 'playState', state: session.back()});
    } else if (m.cmd === 'playRestart') {
      self.postMessage({id: m.id, type: 'playState', state: session.restart()});
    }
  } catch (err) {
    const msg = (err && err.code === 'TIMEOUT')
      ? 'Esta combinación (honores muy repartidos en la defensa) supera el tiempo ' +
        'límite del cálculo exacto. Prueba otra combinación.'
      : String(err && err.stack || err);
    self.postMessage({id: m.id, type: 'error', message: msg});
  }
};
