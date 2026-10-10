// postMessage bridge to the IndustryProof shell when FabTwin runs in its call-screen iframe (?embed=1).
// Protocol: docs/INTEGRATION.md. We send { source: 'fabtwin', type, ... } to the parent window and
// accept { target: 'fabtwin', type, ... } only from the parent window on our own origin.
// Nothing here touches the DOM at import time, so it can be tested in Node (tests/bridge.test.mjs).

export const NAME = 'fabtwin';

export class Bridge {
  constructor({ win = globalThis.window, parent = win?.parent, origin = win?.location?.origin } = {}) {
    this.parent = parent;
    this.origin = origin;
    this.handlers = new Map(); // type -> (message) => void
    win?.addEventListener('message', (event) => {
      const msg = readInbound(event, origin, parent);
      if (!msg) return;
      try {
        this.handlers.get(msg.type)?.(msg);
      } catch (err) {
        console.error(`FabTwin: '${msg.type}' message failed:`, err);
      }
    });
  }

  // Handle one inbound message type: 'start', 'end' or 'subtitle'.
  on(type, fn) {
    this.handlers.set(type, fn);
    return this;
  }

  // Send { source: 'fabtwin', type, ...data } to the parent. Returns the message sent.
  post(type, data = {}) {
    const msg = { source: NAME, type, ...data };
    try {
      this.parent.postMessage(msg, this.origin);
    } catch (err) {
      // Something in the payload could not be structured-cloned: send a plain JSON copy instead.
      try {
        this.parent.postMessage(JSON.parse(JSON.stringify(msg)), this.origin);
      } catch {
        console.warn(`FabTwin: could not send '${type}':`, err);
      }
    }
    return msg;
  }
}

// A valid message from the shell, or null. Only the parent window on our origin may talk to us.
export function readInbound(event, origin, parent) {
  if (!event || event.origin !== origin || event.source !== parent) return null;
  const msg = event.data;
  if (!msg || typeof msg !== 'object' || msg.target !== NAME || typeof msg.type !== 'string') return null;
  return msg;
}

// The bridge messages for one SessionLog entry, as [type, data] pairs. 'ui' entries stay local.
// A scripted 'say' event also goes out as a 'say' message: in embed mode FabTwin doesn't speak it.
export function entryMessages(entry) {
  switch (entry.type) {
    case 'event': {
      const out = [['event', { event: entry }]];
      if (entry.name === 'say') out.push(['say', { t: entry.t, speaker: entry.speaker || 'Supervisor', text: entry.text }]);
      return out;
    }
    case 'action':
      return [['action', { action: entry }]];
    case 'zone':
      return [['zone', { zone: { t: entry.t, tool: entry.tool, enter: entry.enter } }]];
    default:
      return [];
  }
}

// Forward every new log entry exactly once, as it is added. Wraps log.add; the log itself is unchanged.
export function mirrorLog(log, post) {
  const add = log.add.bind(log);
  log.add = (type, data) => {
    const entry = add(type, data);
    for (const [kind, payload] of entryMessages(entry)) post(kind, payload);
    return entry;
  };
  return log;
}

// Payload of the 'ready' message.
export function scenarioSummary(def) {
  return { id: def.id, title: def.title, role: def.role, focusTool: def.focusTool, timeLimit: def.timeLimit };
}

// The shell sends the candidate as a name; accept { name } too.
export function candidateName(candidate) {
  const name = typeof candidate === 'string' ? candidate : candidate?.name;
  return String(name ?? '').trim().slice(0, 60) || 'Candidate';
}
