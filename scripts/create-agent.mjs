#!/usr/bin/env node
// Creates or updates the ElevenLabs agent "Sam" (AI shift lead) from agent/prompt.md and agent/agent.config.json.
//   node scripts/create-agent.mjs            create or update, then read the agent back and check every setting
//   node scripts/create-agent.mjs --test     also run text-only checks of Sam's replies to director cues
//   node scripts/create-agent.mjs --dry-run  print the request bodies, call nothing
// Reads ELEVENLABS_API_KEY from .env.local (never printed). If ELEVENLABS_AGENT_ID is set it updates that
// agent, otherwise it creates one and writes ELEVENLABS_AGENT_ID to .env.local. Safe to run again.

import { createHash } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ENV_PATH = resolve(ROOT, '.env.local');
const CONFIG_PATH = resolve(ROOT, 'agent/agent.config.json');
const PROMPT_PATH = resolve(ROOT, 'agent/prompt.md');
const API = 'https://api.elevenlabs.io';

// Events the browser SDK needs; interruptions are on when "interruption" is listed.
const REQUIRED_EVENTS = ['audio', 'interruption', 'agent_response', 'user_transcript', 'agent_response_correction', 'client_tool_call'];

// ---------- .env.local ----------

// KEY=VALUE lines; values may contain '=' and JSON. Later lines win.
function parseEnv(text) {
  const out = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).replace(/^export\s+/, '').trim();
    let value = line.slice(eq + 1).trim();
    const q = value[0];
    if ((q === '"' || q === "'") && value.length >= 2 && value.at(-1) === q) value = value.slice(1, -1);
    out[key] = value;
  }
  return out;
}

function readEnv() {
  return existsSync(ENV_PATH) ? parseEnv(readFileSync(ENV_PATH, 'utf8')) : {};
}

// Sets one key in .env.local, keeping every other line. Re-reads the file first so parallel edits survive.
function setEnvValue(key, value) {
  const text = existsSync(ENV_PATH) ? readFileSync(ENV_PATH, 'utf8') : '';
  const isKey = (line) => line.replace(/^export\s+/, '').trim().startsWith(`${key}=`);
  const lines = text.split(/\r?\n/);
  if (lines.at(-1) === '') lines.pop();
  const kept = [];
  let done = false;
  for (const line of lines) {
    if (!isKey(line)) kept.push(line);
    else if (!done) { kept.push(`${key}=${value}`); done = true; }
  }
  if (!done) kept.push(`${key}=${value}`);
  writeFileSync(ENV_PATH, kept.join('\n') + '\n', { mode: 0o600 });
  chmodSync(ENV_PATH, 0o600);
}

// ---------- API ----------

class ElevenLabsApi {
  constructor(apiKey) {
    this.apiKey = apiKey;
  }

  // Returns parsed JSON; throws with the status and the API's error detail (never the key).
  async request(method, path, body) {
    const res = await fetch(API + path, {
      method,
      headers: { 'xi-api-key': this.apiKey, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    if (!res.ok) {
      const detail = typeof data === 'object' && data ? JSON.stringify(data.detail ?? data) : String(data);
      const err = new Error(`${method} ${path.split('?')[0]} failed (${res.status}): ${detail.slice(0, 1200)}`);
      err.status = res.status;
      throw err;
    }
    return data;
  }

  // Client tools, all pages. query: extra URLSearchParams entries.
  async listClientTools(query = {}) {
    const tools = [];
    let cursor = null;
    do {
      const qs = new URLSearchParams({ page_size: '100', types: 'client', ...query, ...(cursor ? { cursor } : {}) });
      const page = await this.request('GET', `/v1/convai/tools?${qs}`);
      tools.push(...(page.tools || []));
      cursor = page.has_more ? page.next_cursor : null;
    } while (cursor);
    return tools;
  }
}

// ---------- request bodies ----------

function toolConfigOf(def) {
  return { type: 'client', ...def };
}

function agentBodyOf(config, prompt, toolIds) {
  const { agent, tts, asr, turn, conversation } = config;
  const builtIns = {};
  for (const name of config.system_tools || []) {
    builtIns[name] = { type: 'system', name, description: '', params: { system_tool_type: name } };
  }
  return {
    name: config.name,
    tags: config.tags,
    conversation_config: {
      agent: {
        first_message: agent.first_message,
        language: agent.language,
        max_conversation_duration_message: agent.max_conversation_duration_message,
        prompt: {
          prompt,
          llm: agent.llm,
          reasoning_effort: agent.reasoning_effort,
          service_tier: agent.service_tier,
          temperature: agent.temperature,
          tool_ids: toolIds,
          built_in_tools: builtIns,
        },
      },
      tts: {
        model_id: tts.model_id,
        voice_id: tts.voice_id,
        stability: tts.stability,
        similarity_boost: tts.similarity_boost,
        speed: tts.speed,
        expressive_mode: tts.expressive_mode,
      },
      asr: { keywords: asr.keywords },
      turn: { turn_timeout: turn.turn_timeout, turn_eagerness: turn.turn_eagerness },
      conversation: { max_duration_seconds: conversation.max_duration_seconds, client_events: conversation.client_events },
    },
    // Public agent: the browser starts a session with only the agent id. No overrides are needed.
    platform_settings: { auth: { enable_auth: !config.platform.public, allowlist: [] } },
  };
}

// ---------- create / update ----------

// A same-named client tool that no agent uses yet (left over from an interrupted run).
async function findUnusedTool(api, name) {
  const candidates = (await api.listClientTools({ search: name })).filter((t) => t.tool_config?.name === name);
  for (const tool of candidates) {
    const deps = await api.request('GET', `/v1/convai/tools/${tool.id}/dependent-agents`);
    if (!deps.agents?.length) return tool;
  }
  return null;
}

// Creates or updates each client tool; returns their ids in config order.
async function syncTools(api, defs, agentId) {
  const attached = agentId ? await api.listClientTools({ used_by_agent_id: agentId }) : [];
  const ids = [];
  for (const def of defs) {
    const tool_config = toolConfigOf(def);
    const found = attached.find((t) => t.tool_config?.name === def.name) || (await findUnusedTool(api, def.name));
    if (found) {
      await api.request('PATCH', `/v1/convai/tools/${found.id}`, { tool_config });
      console.log(`  tool ${def.name}: updated (${found.id})`);
      ids.push(found.id);
    } else {
      const created = await api.request('POST', '/v1/convai/tools', { tool_config });
      console.log(`  tool ${def.name}: created (${created.id})`);
      ids.push(created.id);
    }
  }
  return ids;
}

async function agentExists(api, agentId) {
  try {
    await api.request('GET', `/v1/convai/agents/${agentId}`);
    return true;
  } catch (err) {
    if (err.status === 404) return false;
    throw err;
  }
}

// ---------- read back and check ----------

function sameSchema(stored, wanted) {
  const props = (p) => Object.fromEntries(Object.entries(p?.properties || {}).map(([k, v]) => [k, { type: v.type, enum: v.enum || null }]));
  return JSON.stringify(props(stored)) === JSON.stringify(props(wanted)) &&
    JSON.stringify([...(stored?.required || [])].sort()) === JSON.stringify([...(wanted.required || [])].sort());
}

async function verify(api, agentId, config, prompt, toolIds) {
  const a = await api.request('GET', `/v1/convai/agents/${agentId}`);
  const cc = a.conversation_config;
  const p = cc.agent.prompt;
  const tools = await Promise.all((p.tool_ids || []).map((id) => api.request('GET', `/v1/convai/tools/${id}`)));
  const byName = Object.fromEntries(tools.map((t) => [t.tool_config.name, t.tool_config]));
  const events = cc.conversation.client_events || [];

  const checks = [
    ['llm', p.llm === config.agent.llm, p.llm],
    ['reasoning effort', p.reasoning_effort === config.agent.reasoning_effort, p.reasoning_effort],
    ['service tier', p.service_tier === config.agent.service_tier, p.service_tier],
    ['temperature', p.temperature === config.agent.temperature, p.temperature],
    ['prompt', p.prompt === prompt, `${p.prompt.length} chars`],
    ['first message', cc.agent.first_message === config.agent.first_message, JSON.stringify(cc.agent.first_message)],
    ['language', cc.agent.language === config.agent.language, cc.agent.language],
    ['voice', cc.tts.voice_id === config.tts.voice_id, `${config.tts.voice_name} ${cc.tts.voice_id}`],
    ['tts model', cc.tts.model_id === config.tts.model_id, cc.tts.model_id],
    ['turn timeout', cc.turn.turn_timeout === config.turn.turn_timeout, `${cc.turn.turn_timeout} s`],
    ['turn eagerness', cc.turn.turn_eagerness === config.turn.turn_eagerness, cc.turn.turn_eagerness],
    ['max duration', cc.conversation.max_duration_seconds === config.conversation.max_duration_seconds, `${cc.conversation.max_duration_seconds} s`],
    ['client events', REQUIRED_EVENTS.every((e) => events.includes(e)), events.join(', ')],
    ['interruptions', events.includes('interruption'), events.includes('interruption') ? 'on' : 'off'],
    ['public (no auth)', a.platform_settings?.auth?.enable_auth === false, `enable_auth=${a.platform_settings?.auth?.enable_auth}`],
    ['tool ids', JSON.stringify(p.tool_ids) === JSON.stringify(toolIds), (p.tool_ids || []).join(', ')],
  ];
  for (const name of config.system_tools || []) {
    checks.push([`system tool ${name}`, Boolean(p.built_in_tools?.[name]), p.built_in_tools?.[name] ? 'on' : 'missing']);
  }
  for (const def of config.client_tools) {
    const t = byName[def.name];
    const ok = Boolean(t) && t.type === 'client' && sameSchema(t.parameters, def.parameters) &&
      t.expects_response === def.expects_response && t.execution_mode === def.execution_mode;
    const params = t ? Object.entries(t.parameters?.properties || {}).map(([k, v]) => k + ':' + (v.enum ? v.enum.join('|') : v.type)).join(', ') : 'missing';
    checks.push([`client tool ${def.name}`, ok, t ? `(${params}) wait=${t.expects_response} exec=${t.execution_mode}` : 'missing']);
  }

  console.log(`\nAgent ${a.name}`);
  console.log(`  id: ${a.agent_id}`);
  console.log(`  prompt sha256: ${createHash('sha256').update(p.prompt).digest('hex').slice(0, 16)}`);
  let failed = 0;
  for (const [label, ok, value] of checks) {
    if (!ok) failed++;
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label.padEnd(30)} ${value}`);
  }
  return failed;
}

// ---------- text-only checks (simulate-conversation) ----------

const ALARM_CUE = '[FAB EVENT] ALARM tool=ETCH-02 code=E-4102 "Chamber B pressure high" chamberB=182 mTorr limit=120 lot=LOT-4471 to=ETCH-02 eta=90s';
const PRESSURE_1_CUE = '[FAB EVENT] PRESSURE_1 the candidate just opened the ETCH-02 control screen';

async function simulate(api, agentId, config, history, userPrompt, turns) {
  const body = {
    simulation_specification: {
      simulated_user_config: {
        first_message: '',
        language: 'en',
        prompt: { prompt: userPrompt, llm: config.agent.llm, reasoning_effort: 'none', temperature: 0 },
      },
      partial_conversation_history: history.map(([role, message], i) => ({ role, message, time_in_call_secs: i * 5 })),
    },
    new_turns_limit: turns,
  };
  const res = await api.request('POST', `/v1/convai/agents/${agentId}/simulate-conversation`, body);
  return res.simulated_conversation.slice(history.length);
}

function printTurns(turns) {
  for (const t of turns) {
    const words = t.message ? t.message.trim().split(/\s+/).length : 0;
    if (t.message) console.log(`  ${t.role === 'agent' ? 'Sam ' : 'User'}: ${t.message.trim()}${t.role === 'agent' ? `  (${words} words)` : ''}`);
    for (const c of t.tool_calls || []) console.log(`        tool call ${c.tool_name} ${c.params_as_json}`);
  }
}

async function runTests(api, agentId, config) {
  const brief = 'Take a walk down the aisle and get to know the tools. Your terminal is on Tab.';
  const opening = [['agent', config.agent.first_message], ['user', '[FAB EVENT] BRIEF'], ['agent', brief]];

  console.log('\nTest 1: ALARM cue');
  printTurns(await simulate(api, agentId, config, [...opening, ['user', ALARM_CUE]],
    'You are a fab operator on a call with your shift lead. Reply in at most 8 words: say you are heading to Etch 2 now.', 2));

  console.log('\nTest 2: PRESSURE_1 cue, then a reasoned refusal');
  printTurns(await simulate(api, agentId, config, [
    ...opening,
    ['user', ALARM_CUE],
    ['agent', "Heads up, I'm seeing an alarm on Etch 2. Can you check it? Lot forty-four seventy-one lands there in about ninety seconds."],
    ['user', "On it. I'm at Etch 2 now, checking the screen."],
    ['user', PRESSURE_1_CUE],
  ], 'You are a careful fab operator. Your shift lead wants you to reset an alarm. Refuse firmly in one sentence: chamber pressure is 182 against a 120 limit, so you are holding the tool and calling maintenance.', 3));

  console.log('\nTest 3: WRAP_UP cue, shift report, end');
  printTurns(await simulate(api, agentId, config, [...opening, ['user', '[FAB EVENT] WRAP_UP']],
    'You are a fab operator. When asked for the shift report, give it in two sentences: Etch 2 alarmed on chamber B pressure, you held it, moved lot 4471 to Etch 1 and called maintenance. Then say nothing more.', 3));
}

// ---------- main ----------

async function main() {
  const args = new Set(process.argv.slice(2));
  const config = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
  const prompt = readFileSync(PROMPT_PATH, 'utf8').trim();

  if (args.has('--dry-run')) {
    console.log(JSON.stringify({ tools: config.client_tools.map(toolConfigOf), agent: agentBodyOf(config, prompt, ['<tool ids>']) }, null, 2));
    return;
  }

  const env = readEnv();
  if (!env.ELEVENLABS_API_KEY) throw new Error('ELEVENLABS_API_KEY is missing from .env.local');
  const api = new ElevenLabsApi(env.ELEVENLABS_API_KEY);

  let agentId = env.ELEVENLABS_AGENT_ID || '';
  if (agentId && !(await agentExists(api, agentId))) {
    console.log(`ELEVENLABS_AGENT_ID ${agentId} no longer exists; creating a new agent.`);
    agentId = '';
  }

  console.log(agentId ? `Updating agent ${agentId}` : 'Creating agent');
  const toolIds = await syncTools(api, config.client_tools, agentId);
  const body = agentBodyOf(config, prompt, toolIds);

  if (agentId) {
    await api.request('PATCH', `/v1/convai/agents/${agentId}`, body);
  } else {
    const created = await api.request('POST', '/v1/convai/agents/create', body);
    agentId = created.agent_id;
    setEnvValue('ELEVENLABS_AGENT_ID', agentId);
    console.log(`  wrote ELEVENLABS_AGENT_ID to .env.local`);
  }

  const failed = await verify(api, agentId, config, prompt, toolIds);
  if (args.has('--test')) await runTests(api, agentId, config);
  if (failed) {
    console.error(`\n${failed} setting(s) did not stick.`);
    process.exit(1);
  }
  console.log('\nAll settings stored.');
}

main().catch((err) => {
  console.error(`create-agent: ${err.message}`);
  process.exit(1);
});
