// Scenario runner: plays a scenario file's timeline, tracks wafer lots, fires reactions
// to what the candidate does, and decides when the exercise ends.
// Pure logic (no DOM / three.js): world effects happen in the onEvent callback.
import { evaluateExpectations } from './scoring.js';

export const LOT_APPROACH_SECONDS = 12; // overhead vehicle appears this long before a lot's ETA

export class ScenarioRunner {
  constructor(def, { log, onEvent = () => {} }) {
    this.def = def;
    this.log = log;
    this.onEvent = onEvent;
    this.t = 0;
    this.started = false;
    this.ended = false;
    this.endReason = null;
    this.endScheduled = false;
    this.lots = new Map();
    this.firedReactions = new Set();
    this.queue = (def.timeline || []).map((e) => ({ ...e })).sort((a, b) => a.at - b.at);
  }

  start() {
    this.started = true;
    this.t = 0;
    this.emit({ type: 'scenario_start', scenario: this.def.id });
  }

  update(t) {
    if (!this.started || this.ended) return;
    this.t = t;
    while (this.queue.length && this.queue[0].at <= t && !this.ended) this.fire(this.queue.shift());

    for (const lot of this.lots.values()) {
      if (!lot.approaching && t >= lot.eta - LOT_APPROACH_SECONDS) {
        lot.approaching = true;
        this.emit({ type: 'lot_approach', lot: lot.id, to: lot.to, eta: lot.eta });
      }
      if (!lot.arrived && t >= lot.eta) {
        lot.arrived = true;
        this.emit({ type: 'lot_arrived', lot: lot.id, tool: lot.to });
        this.react([`lot_arrived:${lot.to}`, `lot_arrived:${lot.id}`, 'lot_arrived']);
      }
    }

    // Everything was done but we were waiting for a lot to land (so the candidate sees the result).
    if (this.pendingEnd && !this.endScheduled) this.checkComplete();

    if (!this.ended && this.def.timeLimit && t >= this.def.timeLimit) this.end('time_limit');
  }

  // The candidate did something. Returns the log entry.
  // Failed attempts (ok: false) are logged but don't trigger reactions or count as done.
  act(action) {
    const entry = this.log.add('action', action);
    if (this.ended || action.ok === false) return entry;
    const keys = [action.tool, action.lot, action.to].filter(Boolean).map((k) => `${action.action}:${k}`);
    this.react([...keys, action.action]);
    this.checkComplete();
    return entry;
  }

  // Change a lot's destination. Not possible once the vehicle has started its approach.
  reroute(lotId, to) {
    const lot = this.lots.get(lotId);
    if (!lot || lot.approaching || lot.arrived) return false;
    lot.history.push({ t: this.t, from: lot.to, to });
    lot.to = to;
    return true;
  }

  end(reason) {
    if (this.ended) return;
    this.ended = true;
    this.endReason = reason;
    this.emit({ type: 'scenario_end', reason });
  }

  // ---- internals ----
  fire(evt) {
    if (evt.type === 'lot') {
      this.lots.set(evt.lot, {
        id: evt.lot,
        wafers: evt.wafers,
        product: evt.product,
        to: evt.to,
        plannedTo: evt.to,
        eta: this.t + evt.eta,
        approaching: false,
        arrived: false,
        history: [],
      });
    }
    if (evt.type === 'end') {
      this.end(evt.reason || 'complete');
      return;
    }
    this.emit(evt);
  }

  emit(evt) {
    const { at, delay, type, ...rest } = evt;
    this.log.add('event', { name: type, ...rest });
    this.onEvent(evt);
  }

  react(keys) {
    const reactions = this.def.reactions || {};
    const key = keys.find((k) => reactions[k]);
    if (!key || this.firedReactions.has(key)) return;
    this.firedReactions.add(key);
    this.schedule(reactions[key]);
  }

  schedule(events) {
    for (const e of events) this.queue.push({ ...e, at: this.t + (e.delay || 0) });
    this.queue.sort((a, b) => a.at - b.at);
  }

  checkComplete() {
    if (this.endScheduled) return;
    const status = evaluateExpectations(this.def, this.log.entries);
    if (!status.length || !status.every((x) => x.done)) return;
    const end = this.def.end || {};
    const waitLot = end.waitForLot && this.lots.get(end.waitForLot);
    if (waitLot && !waitLot.arrived) {
      this.pendingEnd = true;
      return;
    }
    this.pendingEnd = false;
    this.endScheduled = true;
    const followUps = [];
    if (end.say) followUps.push({ type: 'say', delay: 1.5, ...end.say });
    followUps.push({ type: 'end', delay: end.delay ?? 6, reason: 'complete' });
    this.schedule(followUps);
  }
}
