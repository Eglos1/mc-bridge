// tool-loop probe 3: two-phase (1 tool call max, then force-answer w/o tools)
const fs = require('fs');
const cfg = JSON.parse(fs.readFileSync('/home/user/.openclaw/openclaw.json', 'utf8'));
const TOKEN = cfg.gateway.auth.token;
const URL = 'http://127.0.0.1:18789/v1/chat/completions';

const MC_TOOLS = [
  { type: 'function', function: { name: 'get_state', description: 'Get your full current state: position, health, players nearby, blocks.', parameters: { type: 'object', properties: {}, required: [] } } },
  { type: 'function', function: { name: 'move_to', description: 'Walk or pathfind to coordinates x, y, z.', parameters: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' } }, required: ['x', 'y', 'z'] } } },
  { type: 'function', function: { name: 'inventory', description: 'List the items you are carrying.', parameters: { type: 'object', properties: {}, required: [] } } },
  { type: 'function', function: { name: 'jump', description: 'Jump once.', parameters: { type: 'object', properties: {}, required: [] } } },
];

const TOOL_RESULTS = {
  jump: 'you jumped once',
  get_state: '{"position":{"x":10,"y":64,"z":20},"health":20,"food":20,"players":[{"name":"eglos1","distance":5}],"blocksNearby":[{"x":9,"y":63,"z":20,"n":"grass_block"},{"x":10,"y":63,"z":20,"n":"grass_block"}]}',
  inventory: 'you carry: oak_logx3, stone_pickaxex1, dirtx10',
  move_to: 'you are now walking to (15, 64, 20)',
};

async function chatOnce(messages, withTools) {
  const body = { model: 'openclaw/minecraft', user: 'test:tools3', messages };
  if (withTools) { body.tools = MC_TOOLS; body.tool_choice = 'auto'; }
  const res = await fetch(URL, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) { console.log('HTTP', res.status, await res.text()); process.exit(1); }
  return res.json();
}

async function run(label, prompt) {
  console.log(`\n===== ${label} =====`);
  const messages = [{ role: 'user', content: `[WORLD] you are at (10, 64, 20) in a forest. eglos1 is 5m south.\neglos1 says: ${prompt}` }];

  // Phase 1: with tools, let it act or answer
  let data = await chatOnce(messages, true);
  let msg = data.choices[0].message;
  const calls = msg.tool_calls || [];
  console.log(`phase1: calls=${JSON.stringify(calls.map(c => c.function.name + ' ' + c.function.arguments))} content=${JSON.stringify(msg.content)}`);

  if (!calls.length) { console.log(`FINAL: ${JSON.stringify(msg.content)}`); return; }

  messages.push(msg);
  for (const tc of calls) {
    let args = {};
    try { args = JSON.parse(tc.function.arguments || '{}'); } catch {}
    const result = TOOL_RESULTS[tc.function.name] || 'ok';
    messages.push({ role: 'tool', tool_call_id: tc.id, content: result });
    console.log(`  executed ${tc.function.name} -> ${result}`);
  }

  // Phase 2: no tools -> must answer in plain chat
  messages.push({ role: 'user', content: 'Now reply to the player in one short plain chat sentence about what you did. No JSON.' });
  data = await chatOnce(messages, false);
  msg = data.choices[0].message;
  console.log(`phase2: content=${JSON.stringify(msg.content)}`);
  console.log(`FINAL: ${JSON.stringify(msg.content)}`);
}

(async () => {
  await run('jump request', 'do a jump for me');
  await run('inventory request', 'check your inventory and tell me what you have');
  await run('move request', 'go stand at 15, 64, 20');
})().catch((e) => { console.error('ERR', e); process.exit(1); });
