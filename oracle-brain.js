// oracle-brain.js — MindCraft-style Minecraft bridge
// The brain is an isolated OpenClaw agent (openclaw/minecraft) reached via the
// Gateway's OpenAI-compatible endpoint. Provider: Ollama (llama3.2 1B & 3B).
//
// The bot is a resident of the Minecraft server (the "mod" layer, like MindCraft):
//   - relays in-game chat -> OpenClaw agent -> replies in-game
//   - gives the brain lightweight "eyes" via a compact world context block
//   - handles movement/follow/dig/look directly (fast, reliable)
//   - stays alive (head tracking, home tether, watchdog)

const mineflayer = require('mineflayer');
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');
const { Vec3 } = require('vec3');
const fs = require('fs');
const path = require('path');

const HOST = process.env.BOT_HOST || 'localhost';
const PORT = parseInt(process.env.BOT_PORT || '25565', 10);
const USERNAME = process.env.BOT_NAME || 'TheOracle';

const OPENCLAW_URL = process.env.OPENCLAW_URL || 'http://127.0.0.1:18789/v1/chat/completions';
const AGENT_MODEL = process.env.OPENCLAW_MODEL || 'openclaw/minecraft';
// fallback model list for the same endpoint (Gemini has per-model daily quotas).
// If one model is quota-exhausted (429), try the next one that still works.
const AGENT_MODEL_FALLBACKS = (process.env.OPENCLAW_MODEL_FALLBACKS || '')
  .split(',')
  .map((m) => m.trim())
  .filter(Boolean);
let modelTried = 0; // round-robin through [primary, ...fallbacks]
const OPENCLAW_TOKEN = process.env.OPENCLAW_TOKEN || (() => {
  try {
    const cfg = JSON.parse(fs.readFileSync('/home/user/.openclaw/openclaw.json', 'utf8'));
    return cfg.gateway && cfg.gateway.auth && cfg.gateway.auth.token;
  } catch { return null; }
})();

const CTRL = process.env.BOT_CTRL || '/home/user/mc-bridge/state/commands.json';
const PERC = process.env.BOT_PERC || '/home/user/mc-bridge/state/perception.json';
try { fs.mkdirSync('/home/user/mc-bridge/state', { recursive: true }); } catch {}
const CHATLOG = process.env.BOT_CHAT || '/home/user/mc-bridge/chat.log';
const LOGF = process.env.BOT_LOG || '/home/user/mc-bridge/bridge.log';

// ---------------------------------------------------------------------------
// Persistent mind: long-term memory + a todo/mission list + rolling chat
// history. The brain API is stateless (it rebuilds [WORLD] every call), so the
// ONLY way it can "remember" anything - a task the player set, a fact it
// discovered, or what it said 5 minutes ago - is if we hand it back to the
// model on every request. That's what this store is for: everything here is
// reloaded from disk on process start and injected into every WORLD context.
// ---------------------------------------------------------------------------
const MINDF = process.env.BOT_MIND || '/home/user/mc-bridge/state/mind.json';
const MAX_HISTORY = 12;      // keep the last N chat lines in the brain context
let mind = { todos: [], memory: [], history: [], keepGoing: false };
function loadMind() {
  try { mind = JSON.parse(fs.readFileSync(MINDF, 'utf8')); } catch {}
  if (!Array.isArray(mind.todos)) mind.todos = [];
  if (!Array.isArray(mind.memory)) mind.memory = [];
  if (!Array.isArray(mind.history)) mind.history = [];
  // KEEP-GOING FLAG: a durable "don't stop thinking" mission bit. Persisted with
  // the mind store so restarting the process (systemd Restart=always) or even
  // the whole box does NOT lose it - the brain keeps pursuing its mission.
  if (typeof mind.keepGoing !== 'boolean') mind.keepGoing = false;
}
function saveMind() {
  try { fs.writeFileSync(MINDF, JSON.stringify(mind)); } catch {}
}
// remember a durable fact (deduped, keeps up to 30)
function remember(fact) {
  const f = String(fact || '').trim().slice(0, 240);
  if (!f) return null;
  mind.memory = mind.memory.filter((m) => !m.toLowerCase().includes(f.slice(0, 40).toLowerCase()));
  mind.memory.push(`${new Date().toISOString().slice(5, 16)}: ${f}`);
  if (mind.memory.length > 30) mind.memory = mind.memory.slice(-30);
  saveMind();
  return f;
}
// add an open todo item (mission step); returns the item or null if already there
function addTodo(t) {
  const s = String(t || '').trim().slice(0, 160);
  if (!s) return null;
  if (mind.todos.some((x) => x && x.text.toLowerCase() === s.toLowerCase() && !x.done)) return null;
  mind.todos.push({ text: s, done: false, at: new Date().toISOString() });
  if (mind.todos.length > 40) mind.todos = mind.todos.slice(-40);
  saveMind();
  return s;
}
// mark the FIRST open todo matching the given text (or the oldest if empty) as done
function completeTodo(q) {  const want = String(q || '').toLowerCase();
  const idx = mind.todos.findIndex((x) => !x.done && (want ? x.text.toLowerCase().includes(want) : true));
  if (idx < 0) return null;
  mind.todos[idx].done = true;
  mind.todos[idx].doneAt = new Date().toISOString();
  saveMind();
  return mind.todos[idx].text;
}
function pendingTodos() { return mind.todos.filter((x) => !x.done); }
// durable "keep going" mission flag - persisted with the mind store so it survives
// process restarts (systemd Restart=always) and even full reboots. When ON the
// brain keeps thinking/acting on its own instead of throttling to silence.
function setKeepGoing(v) {
  mind.keepGoing = !!v;
  saveMind();
  return mind.keepGoing;
}
// append a chat/event line to the rolling history that's shown to the brain
function chatLine(kind, who, msg) {
  const line = `${kind === 'bot' ? 'you said' : `${who} said`}: ${String(msg || '').trim().slice(0, 200)}`;
  mind.history.push(line);
  if (mind.history.length > MAX_HISTORY) mind.history = mind.history.slice(-MAX_HISTORY);
  saveMind();
}
// compact block injected into the [WORLD] context so the model always sees its
// ongoing goal list, what it knows, and what was just said
function mindBlock() {
  const ts = pendingTodos();
  const parts = [];
  const todoTxt = ts.length ? ts.map((t, i) => `${i + 1}. ${t.text}`).join(' | ') : 'none right now';
  // KEEP-GOING flag (persistent mission mode): when ON, the player told you to
  // keep working toward the mission even when nobody is watching - so DON'T
  // stall/go quiet between commands; keep making progress on your own.
  if (mind.keepGoing) parts.push('[MISSION] keep-going is ON: the player told me to complete the game on my own - do not stop randomly, keep making progress autonomously every cycle');
  parts.push(`[GOALS] mission: ${todoTxt}`);
  if (mind.memory.length) parts.push(`[MEMORY] ${mind.memory.slice(-10).join(' | ')}`);
  if (mind.history.length) parts.push(`[RECENT] ${mind.history.join(' | ')}`);
  return parts.join('\n');
}
loadMind();

function log(line) {
  const s = `[${new Date().toISOString()}] ${line}`;
  try { fs.appendFileSync(LOGF, s + '\n'); } catch {}
  console.log(s);
}
function logChat(kind, who, msg) {
  try { fs.appendFileSync(CHATLOG, `[${new Date().toISOString()}] ${kind} ${who}: ${msg}\n`); } catch {}
}

if (!OPENCLAW_TOKEN) { log('FATAL: no openclaw token (set OPENCLAW_TOKEN)'); process.exit(1); }

const bot = mineflayer.createBot({ host: HOST, port: PORT, username: USERNAME, auth: 'offline' });
bot.loadPlugin(pathfinder);

// ---------------------------------------------------------------------------
// Brain: OpenClaw agent over the OpenAI-compatible endpoint
// (tool loop so the model can actually DO things in the world)
// ---------------------------------------------------------------------------
const RESPONSE_TIMEOUT_MS = 60000;
const MAX_TOOL_ITERS = 4;
// auto-retry budget: transient 429/5xx errors or brief network blips must not
// drop a player's message. Wait-and-retry with backoff up to ~4 minutes total.
const BRAIN_RETRY_ATTEMPTS = 7;        // number of tries per API call
const BRAIN_RETRY_DELAY_MS = 45000;    // wait between tries (fixed backoff; the actual
                                       // throttle resets are often 30-60s)
const HOME_RADIUS = 40; // blocks from home the bot may wander freely before the tether pulls it back
const AUTONOMY_INTERVAL_MS = 60000; // autonomy fires at most once per minute (not 3x/min):
// every autonomous brain pass is a real Gemini API call, and spamming it at 20s
// intervals is what blew the daily quota. Player chat still preempts instantly.
// quota/rate-limit state - pauses autonomy (and throttles retries) so we don't
// burn the whole daily Gemini quota on background thinking when the player is away.
let quotaHitAt = 0;          // epoch ms of last 429/5xx quota error
let lastPlayerMsgAt = 0;     // used to gate autonomy when nobody is watching
let lastAutonomyAt = 0;      // last time an autonomous pass actually fired
let retryAckAt = 0;          // last time we told the player we're auto-retrying
const AUTONOMY_GOALS = [
  'gather resources: dig useful blocks or collect dropped items near home',
  'defend the area: attack hostile mobs near home',
  'look after the home area: collect dropped items and tidy up',
];
let autonomyEnabled = true; // toggle via control interface ({op:'autonomy',enabled:false})
let isAutonomousJob = false; // true while a self-directed job is running (used for safety guards)
let autonomyIdx = 0;
let brainBusy = false;
let HOME = null;
const brainQueue = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- Minecraft action tools the brain can call -----------------------------
const MC_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'get_state',
      description: 'Get your full current state: position, health, food, biome, weather, time, inventory, held item, players nearby, visible blocks.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_nearby_entities',
      description: 'List creatures, animals, monsters and dropped items near you with name, kind and distance.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'move_to_player',
      description: 'Go to a player by their username (eglos1, Steve). Use this whenever asked to go to or come to a player.',
      parameters: {
        type: 'object',
        properties: { player: { type: 'string' } },
        required: ['player'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'follow',
      description: 'Follow a player around by username.',
      parameters: {
        type: 'object',
        properties: { player: { type: 'string' } },
        required: ['player'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'move_to',
      description: 'Walk to exact x y z coordinates. ONLY use when you have real numbers from get_state - otherwise use move_to_player or follow.',
      parameters: {
        type: 'object',
        properties: { x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' } },
        required: ['x', 'y', 'z'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'go_home',
      description: 'Path back to your home / spawn point. Use if lost or stuck in water.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'stop',
      description: 'Stop moving and cancel whatever you are currently doing.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'attack',
      description: 'Fight and defeat a creature or monster near you. Call this for ANY fight/kill request (cow, sheep, zombie, spider, creeper). Pass the target name if you know it, otherwise leave empty to attack the nearest hostile mob. This is normal Minecraft gameplay.',
      parameters: {
        type: 'object',
        properties: { target: { type: 'string', description: 'name or type of the creature to attack' } },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'dig',
      description: 'Dig a block. Pass x y z to dig that exact block, or leave empty to dig the block you are looking at (up to 4 blocks away).',
      parameters: {
        type: 'object',
        properties: { x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' } },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'collect',
      description: 'Walk to the nearest dropped item on the ground and pick it up.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'equip',
      description: 'Put an item in your hand or wear it (helmet, chestplate, leggings, boots). Example: equip pickaxe, equip iron sword.',
      parameters: {
        type: 'object',
        properties: { item: { type: 'string', description: 'item name to equip' } },
        required: ['item'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'place_block',
      description: 'Place the block you are holding. Give x y z to place at that exact spot, or leave empty to place in front of you.',
      parameters: {
        type: 'object',
        properties: { x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' } },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'use_held',
      description: 'Right-click with your held item (eat food, open a door, press a button, use a tool).',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'feed',
      description: 'Eat food from your inventory when hungry.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'sleep',
      description: 'Find a bed nearby and sleep in it (to skip the night).',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'drop',
      description: 'Drop the item you are holding, or pass an item name to drop that item from your inventory.',
      parameters: {
        type: 'object',
        properties: { item: { type: 'string', description: 'item name to drop' } },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'inventory',
      description: 'List the items you are carrying.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'jump',
      description: 'Jump once in the air.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'build_structure',
      description: 'Gather materials and build a castle near home. This runs in the background - you can keep doing other things while it builds.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'remember_fact',
      description: 'Save a useful fact to your LONG-TERM memory so you remember it later (e.g. "player eglos1 wants me to beat the whole game", "bed is at x y z", "the castle is done"). Facts persist across restarts and are shown to you in [MEMORY] every request.',
      parameters: {
        type: 'object',
        properties: { fact: { type: 'string', description: 'the fact to remember, in your own words' } },
        required: ['fact'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'set_todo',
      description: 'Add a step to your GOAL/mission list (an open todo). Use this when the player gives you a big multi-step mission like "complete the whole game" or "build a base" - break it into concrete achievable steps and add each one. Shown to you in [GOALS] every request. Returns "already there" if it is already on the list.',
      parameters: {
        type: 'object',
        properties: { todo: { type: 'string', description: 'one concrete step, e.g. "craft stone pickaxe" or "defeat the Ender Dragon"' } },
        required: ['todo'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'complete_todo',
      description: 'Mark a goal/todo as DONE once you have actually finished it. Pass text matching the step (or leave empty to complete the oldest open one). Only call this after you truly did it.',
      parameters: {
        type: 'object',
        properties: { todo: { type: 'string', description: 'text of the step you finished (or empty for the oldest)' } },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'set_keep_going',
      description: 'Persistent MISSION MODE toggle. When enabled (true), you keep thinking and acting toward your mission on your own even when no human is watching, instead of throttling down to near-silence. This survives restarts. ONLY enable it when the player has clearly told you to keep working autonomously (e.g. "keep going", "complete the game", "finish it yourself"). The player can disable it anytime by saying "stop".',
      parameters: {
        type: 'object',
        properties: { enabled: { type: 'boolean', description: 'true = keep working autonomously even when unwatched / false = drop back to conservative throttling' } },
        required: ['enabled'],
      },
    },
  },
];

// smaller tool set for self-directed (autonomous) thinking - the 1B model picks
// tools far more reliably from a short list than from the full 20
const AUTONOMY_TOOL_NAMES = ['get_state', 'get_nearby_entities', 'move_to', 'go_home', 'stop', 'attack', 'dig', 'collect', 'equip', 'feed', 'sleep', 'inventory', 'jump', 'build_structure'];
const AUTONOMY_TOOLS = MC_TOOLS.filter((t) => AUTONOMY_TOOL_NAMES.includes(t.function.name));

function buildState() {
  const p = bot.entity.position;
  const facing = (() => {
    const dx = -Math.sin(bot.entity.yaw), dz = Math.cos(bot.entity.yaw);
    return Math.abs(dx) > Math.abs(dz) ? (dx > 0 ? 'east' : 'west') : (dz > 0 ? 'south' : 'north');
  })();
  const blocks = [];
  const BR = 5, px = Math.floor(p.x), py = Math.floor(p.y), pz = Math.floor(p.z);
  for (let bx = px - BR; bx <= px + BR; bx++)
    for (let bz = pz - BR; bz <= pz + BR; bz++)
      for (let by = py - 2; by <= py + 2; by++) {
        const b = bot.world.getBlock(new Vec3(bx, by, bz));
        if (b && b.name !== 'air') blocks.push({ x: bx, y: by, z: bz, n: b.name });
      }
  blocks.sort((a, b) => (Math.abs(a.x - px) + Math.abs(a.y - py) + Math.abs(a.z - pz)) - (Math.abs(b.x - px) + Math.abs(b.y - py) + Math.abs(b.z - pz)));
  return {
    position: { x: Math.round(p.x), y: Math.round(p.y), z: Math.round(p.z) },
    facing,
    health: Math.round(bot.health),
    food: Math.round(bot.food),
    biome: (() => { try { const id = bot.world.getBiome(p); const mc = require('minecraft-data')(bot.version); return (mc.biomes[id] || {}).name || String(id); } catch { return 'unknown'; } })(),
    raining: bot.isRaining,
    time: bot.time ? Math.round(bot.time.timeOfDay) : null,
    inventory: (bot.inventory ? bot.inventory.items() : []).slice(0, 36).map((i) => `${i.name}x${i.count}`),
    heldItem: bot.heldItem ? bot.heldItem.name : null,
    players: Object.values(bot.players).filter((pl) => pl.entity).map((pl) => ({
      name: pl.username, x: Math.round(pl.entity.position.x), y: Math.round(pl.entity.position.y), z: Math.round(pl.entity.position.z),
      distance: Math.round(p.distanceTo(pl.entity.position)),
    })),
    blocksNearby: blocks.slice(0, 120),
  };
}

function facingVec() {
  const yaw = bot.entity.yaw;
  return new Vec3(-Math.sin(yaw), 0, Math.cos(yaw));
}

function inventoryItems() {
  return bot.inventory ? bot.inventory.items() : [];
}

function findEntityByQuery(q) {
  const want = String(q || '').toLowerCase();
  if (!want) return null;
  return Object.values(bot.entities).find((e) => {
    if (!e || !e.position || e === bot.entity) return false;
    const names = [e.username, e.displayName, e.name];
    return names.some((n) => n && n.toLowerCase().includes(want));
  });
}

async function execTool(name, args) {
  try {
    switch (name) {
      case 'get_state':
        return JSON.stringify(buildState());
      case 'get_nearby_entities': {
        const p = bot.entity.position;
        const out = Object.values(bot.entities)
          .filter((e) => e && e.position && e !== bot.entity)
          .map((e) => ({
            name: e.username || e.displayName || e.name,
            kind: String(e.kind || e.type || '?'),
            x: Math.round(e.position.x), y: Math.round(e.position.y), z: Math.round(e.position.z),
            dist: Math.round(p.distanceTo(e.position)),
          }))
          .sort((a, b) => a.dist - b.dist)
          .slice(0, 30);
        return JSON.stringify(out);
      }
      case 'move_to': {
        const x = Number(args.x), y = Number(args.y), z = Number(args.z);
        if ([x, y, z].some((v) => !Number.isFinite(v))) return 'need real x y z numbers';
        if (Math.abs(x) + Math.abs(y) + Math.abs(z) < 3) return 'those coordinates look wrong (0,0,0) - use move_to_player instead';
        const p = bot.entity.position;
        const dist = Math.sqrt((p.x - x) ** 2 + (p.z - z) ** 2);
        if (dist > 150) return `target (${x}, ${y}, ${z}) is ${Math.round(dist)} blocks away - too far for move_to; use go_home or move_to_player instead`;
        bot.pathfinder.setMovements(makeMovements());
        bot.pathfinder.setGoal(new goals.GoalNear(x, y, z, 2));
        return `moving to (${x}, ${y}, ${z})`;
      }
      case 'move_to_player': {
        const pl = Object.values(bot.players).find((p) => p.username.toLowerCase() === String(args.player || '').toLowerCase());
        if (!pl || !pl.entity) return `cannot see player ${args.player}`;
        const t = pl.entity.position;
        bot.pathfinder.setMovements(makeMovements());
        bot.pathfinder.setGoal(new goals.GoalNear(t.x, t.y, t.z, 2));
        return `moving to ${pl.username}`;
      }
      case 'follow': {
        const pl = Object.values(bot.players).find((p) => p.username.toLowerCase() === String(args.player || '').toLowerCase());
        if (pl && pl.entity) {
          bot.pathfinder.setMovements(makeMovements());
          bot.pathfinder.setGoal(new goals.GoalFollow(pl.entity, 3));
          return `now following ${pl.username}`;
        }
        return `cannot see player ${args.player}`;
      }
      case 'go_home': {
        if (!HOME) return 'no home recorded yet';
        bot.pathfinder.setMovements(makeMovements());
        bot.pathfinder.setGoal(new goals.GoalNear(HOME.x, HOME.y, HOME.z, 2));
        return `heading home to (${HOME.x}, ${HOME.y}, ${HOME.z})`;
      }
      case 'stop':
        bot.pathfinder.setGoal(null);
        return 'stopped';
      case 'look_at': {
        const pl = Object.values(bot.players).find((p) => p.username.toLowerCase() === String(args.player || '').toLowerCase());
        if (pl && pl.entity) { bot.lookAt(pl.entity.position.offset(0, 1.6, 0)); return `looking at ${pl.username}`; }
        return `cannot see player ${args.player}`;
      }
      case 'attack': {
        const targetName = String(args.target || '').trim();
        // models pass categories like "hostile mobs" / "enemy" - treat those as "nearest hostile"
        const realTarget = targetName && !/^(none|null|undefined|nan)$/i.test(targetName) && !/hostile|monster|\bmob\b|enemy|zombie near/i.test(targetName) ? targetName : '';
        let ent = realTarget ? findEntityByQuery(realTarget) : null;
        if (realTarget && !ent) return `no ${realTarget} nearby to attack`;
        if (!ent) {
          const p = bot.entity.position;
          const hostiles = Object.values(bot.entities)
            .filter((e) => e && e.position && e !== bot.entity && e.kind === 'Hostile mobs')
            .sort((a, b) => p.distanceTo(a.position) - p.distanceTo(b.position));
          ent = hostiles[0];
          if (!ent) return 'no hostile mobs nearby';
        }
        const label = ent.displayName || ent.name || 'target';
        const id = ent.id;
        if (ent.kind === 'Players') return 'I do not attack players'; // hard guard, any job
        // autonomous safety: protect villagers/golems/pets (and avoid explosions),
        // but hunting farm animals for food is fine - it needs to survive
        if (isAutonomousJob) {
          const nm = (ent.displayName || ent.name || '').toLowerCase().replace(/\s+/g, '_');
          if (['villager', 'wandering_trader', 'iron_golem', 'snow_golem', 'wolf', 'cat', 'ocelot', 'horse', 'donkey', 'mule', 'skeleton_horse', 'zombie_horse', 'llama', 'trader_llama', 'parrot', 'bee', 'allay', 'frog', 'axolotl', 'panda', 'dolphin', 'turtle', 'armadillo', 'fox'].includes(nm)) {
            return `I don't attack ${label} on my own`;
          }
          if (nm === 'creeper') return 'Creepers explode - not fighting one on my own near home';
        }
        // LEASH: don't give chase across the map. Endermen teleport (chasing them
        // is pointless and drowns the bot), and wandering 100+ blocks from home
        // made the bot useless. Only fight things we are already near.
        const startPos = bot.entity.position;
        const distToTarget = startPos.distanceTo(ent.position);
        const targetIsEnderman = /enderman/i.test(label || '');
        if (targetIsEnderman && distToTarget > 6) {
          bot.chat(`That ${label} is too far away to catch - it teleports before I can reach it.`);
          return `enderman ${Math.round(distToTarget)} blocks away - not chasing (they teleport)`;
        }
        if (distToTarget > 15) {
          bot.chat(`${label} is ${Math.round(distToTarget)} blocks from me - too far to chase safely.`);
          return `${label} ${Math.round(distToTarget)} blocks away - out of effective range`;
        }
        const homeDist0 = HOME ? startPos.distanceTo(HOME) : 999;
        const leashReached = () => {
          const d = bot.entity.position.distanceTo(HOME);
          if (homeDist0 > 25) return d > homeDist0 + 30; // already far from home - don't go much further
          return d > 30; // near home - hard leash
        };
        // equip the best melee weapon we have
        try {
          const rank = (i) => (i.name.includes('netherite') ? 4 : i.name.includes('diamond') ? 3 : i.name.includes('iron') ? 2 : i.name.includes('stone') ? 1 : i.name.includes('wooden') ? 1 : 0);
          const weapon = inventoryItems().filter((i) => /sword|axe/.test(i.name)).sort((a, b) => rank(b) - rank(a))[0];
          if (weapon) await bot.equip(weapon, 'hand');
        } catch {}
        bot.pathfinder.setMovements(makeMovements());
        bot.pathfinder.setGoal(new goals.GoalFollow(ent, 2)); // track the moving target
        const deadline = Date.now() + 12000; // 12s max - keep the brain responsive
        let inWater = false;
        while (Date.now() < deadline) {
          const cur = bot.entities[id];
          if (!cur || !cur.position) return `defeated ${label}`;
          if (typeof cur.health === 'number' && cur.health <= 0) return `defeated ${label}`;
          if (cur.position.distanceTo(startPos) > 12 && homeDist0 > 25) return `${label} fled too far - stopping chase`;
          if (leashReached()) { bot.pathfinder.setGoal(null); return `stopped - getting too far from home (${label} still alive)`; }
          if (bot.entity.isInWater) {
            inWater = true;
            bot.setControlState('jump', true); // bob up, try to climb out
          }
          const d = bot.entity.position.distanceTo(cur.position);
          if (d <= 3.5) bot.attack(cur);
          else if (inWater) {
            // don't swim after teleporting mobs - get back to land
            bot.pathfinder.setMovements(makeMovements());
            bot.pathfinder.setGoal(new goals.GoalNear(HOME.x, HOME.y, HOME.z, 3));
          }
          await sleep(450);
        }
        bot.pathfinder.setGoal(null);
        if (bot.entity.isInWater) bot.setControlState('jump', false);
        return `${label} still alive, keep fighting`;
      }
      case 'dig': {
        // optional coords target a specific block; otherwise dig what we're looking at
        let b = null;
        if (args.x !== undefined && args.z !== undefined) {
          const y = args.y !== undefined ? args.y : bot.entity.position.y;
          b = bot.blockAt(new Vec3(Math.floor(args.x), Math.floor(y), Math.floor(args.z)));
        }
        if (!b || b.name === 'air' || b.name === 'water' || b.name === 'lava') b = bot.blockAtCursor(4);
        if (!b || b.name === 'air' || b.name === 'water' || b.name === 'lava' || b.name === 'bedrock') return 'nothing to dig ahead';
        // autonomous digging must not wreck player builds - only terrain/ore blocks
        const SAFE_DIG = ['dirt', 'grass_block', 'stone', 'cobblestone', 'gravel', 'sand', 'sandstone', 'granite', 'diorite', 'andesite', 'tuff', 'deepslate', 'coal_ore', 'iron_ore', 'copper_ore', 'gold_ore', 'redstone_ore', 'lapis_ore', 'diamond_ore', 'dirt_path', 'snow_block', 'clay', 'mud', 'packed_mud', 'oak_log', 'birch_log', 'spruce_log', 'jungle_log', 'acacia_log', 'dark_oak_log', 'mangrove_log', 'cherry_log', 'oak_leaves', 'birch_leaves', 'spruce_leaves', 'oak_planks', 'spruce_planks', 'birch_planks', 'oak_wood'];
        if (isAutonomousJob && !SAFE_DIG.includes(b.name)) return `I don't dig ${b.name} on my own - it might be part of a build`;
        await bot.dig(b, 'ignore');
        return `dug ${b.name} at (${b.position.x}, ${b.position.y}, ${b.position.z})`;
      }
      case 'collect': {
        const p = bot.entity.position;
        const drops = Object.values(bot.entities).filter((e) => e && e.position && (e.name === 'item' || e.name === 'item_stack'));
        if (!drops.length) return 'no dropped items nearby';
        const mine = drops.sort((a, b) => p.distanceTo(a.position) - p.distanceTo(b.position))[0];
        const id = mine.id;
        bot.pathfinder.setMovements(makeMovements());
        bot.pathfinder.setGoal(new goals.GoalFollow(mine, 1));
        const deadline = Date.now() + 15000;
        while (Date.now() < deadline && bot.entities[id]) await sleep(400);
        bot.pathfinder.setGoal(null);
        return bot.entities[id] ? 'moved next to the dropped item' : 'picked up a dropped item';
      }
      case 'equip': {
        const want = String(args.item || '').toLowerCase();
        const item = inventoryItems().find((i) => i.name.toLowerCase().includes(want));
        if (!item) return `no ${args.item} in your inventory`;
        let dest = 'hand';
        if (item.name.includes('helmet')) dest = 'head';
        else if (item.name.includes('chestplate') || item.name.includes('elytra')) dest = 'torso';
        else if (item.name.includes('leggings')) dest = 'legs';
        else if (item.name.includes('boots')) dest = 'feet';
        await bot.equip(item, dest);
        return `equipped ${item.name}`;
      }
      case 'place_block': {
        if (!bot.heldItem) return 'holding nothing - equip a block first';
        let target;
        if (args.x !== undefined && args.z !== undefined) {
          target = new Vec3(Math.floor(args.x), Math.floor(args.y !== undefined ? args.y : bot.entity.position.y), Math.floor(args.z));
        } else {
          const f = facingVec();
          target = bot.entity.position.plus(new Vec3(Math.round(f.x * 2.5), 0, Math.round(f.z * 2.5))).floored();
        }
        const ref = bot.blockAt(target.offset(0, -1, 0));
        if (!ref || ref.name === 'air' || ref.name === 'water' || ref.name === 'lava') return 'no solid block to place on there';
        const h = bot.heldItem;
        await bot._placeBlockWithOptions(ref, new Vec3(0, 1, 0), { swingArm: 'right', forceLook: true });
        return `placed ${h.name} at (${target.x}, ${target.y}, ${target.z})`;
      }
      case 'use_held': {
        const b = bot.blockAtCursor(3);
        if (b) {
          const interactive = ['door', 'button', 'lever', 'chest', 'furnace', 'crafting_table', 'bed', 'gate', 'trapdoor', 'sign', 'barrel', 'shulker', 'anvil', 'enchanting_table'];
          if (interactive.some((k) => b.name.includes(k))) { await bot.activateBlock(b); return `used ${b.name}`; }
        }
        if (bot.heldItem) { await bot.activateItem(); return `used held ${bot.heldItem.name}`; }
        return 'nothing to use';
      }
      case 'feed': {
        const mc = require('minecraft-data')(bot.version);
        // mc.foods is an OBJECT {itemId: [hunger, saturation]}, not an array
        const foods = new Set(Object.keys(mc.foods || {}).map(Number));
        const food = inventoryItems().find((i) => foods.has(i.type) && i.name !== 'rotten_flesh');
        if (!food) return 'no food in inventory';
        await bot.equip(food, 'hand');
        await bot.activateItem();
        await sleep(2500); // let the eating animation finish
        return `ate ${food.name}`;
      }
      case 'sleep': {
        const t = bot.time ? bot.time.timeOfDay : null;
        if (t !== null && t > 6000 && t < 13000) return `not night yet (time ${Math.round(t)})`;
        const bed = bot.findBlock({ matching: (blk) => blk.name.endsWith('_bed'), maxDistance: 64 });
        if (!bed) return 'no bed found nearby';
        if (bot.entity.position.distanceTo(bed.position) > 3) {
          bot.pathfinder.setMovements(makeMovements());
          bot.pathfinder.setGoal(new goals.GoalNear(bed.position.x, bed.position.y, bed.position.z, 2));
          const deadline = Date.now() + 20000;
          while (Date.now() < deadline && bot.entity.position.distanceTo(bed.position) > 3) await sleep(300);
          bot.pathfinder.setGoal(null);
        }
        const bedNow = bot.blockAt(bed.position);
        if (!bedNow || !bedNow.name.endsWith('_bed')) return 'bed disappeared';
        await bot.sleep(bedNow);
        return 'going to sleep';
      }
      case 'drop': {
        const want = String(args.item || '').toLowerCase();
        if (want) {
          const item = inventoryItems().find((i) => i.name.toLowerCase().includes(want));
          if (!item) return `no ${args.item} to drop`;
          await bot.tossStack(item);
          return `dropped ${item.name}x${item.count}`;
        }
        if (bot.heldItem) { await bot.tossStack(bot.heldItem); return `dropped ${bot.heldItem.name}`; }
        return 'nothing to drop';
      }
      case 'craft': {
        const mc = require('minecraft-data')(bot.version);
        const want = String(args.item || '').toLowerCase();
        const def = Object.values(mc.items).find((i) => i.name === want) || Object.values(mc.items).find((i) => i.name.includes(want));
        if (!def) return `unknown item ${args.item}`;
        let recipes = bot.recipesFor(def.id, null, null, true);
        if (!recipes || !recipes.length) recipes = bot.recipesFor(def.id);
        if (!recipes || !recipes.length) return `no recipe for ${def.name}`;
        const recipe = recipes[0];
        let table = null;
        if (recipe.requiresTable) {
          table = bot.findBlock({ matching: (blk) => blk.name === 'crafting_table', maxDistance: 8 });
          if (!table) return `need a crafting table nearby to craft ${def.name}`;
        }
        await bot.craft(recipe, 1, table);
        return `crafted ${def.name}`;
      }
      case 'inventory':
        return JSON.stringify(inventoryItems().slice(0, 36).map((i) => `${i.name}x${i.count}`));
      case 'jump':
        bot.setControlState('jump', true); await sleep(400); bot.setControlState('jump', false);
        return 'jumped';
      case 'build_structure':
        buildCastle(); // async - returns immediately so the brain isn't blocked
        return 'started building a castle (background task)';
      case 'remember_fact':
        return remember(String(args.fact || '')) ? 'stored in long-term memory' : 'nothing to remember';
      case 'set_todo':
        return addTodo(String(args.todo || '')) ? 'added to my goal list' : 'already on my goal list';
      case 'complete_todo':
        return completeTodo(String(args.todo || '')) ? 'marked that goal as done' : 'no such open step in my goal list';
      case 'keep_going':
        return setKeepGoing(Boolean(args.enabled)) ? `keep-going is now ${mind.keepGoing ? 'ON (persistent - survives restarts)' : 'OFF'}` : 'no change';
      default:
        return `unknown tool ${name}`;
    }
  } catch (e) {
    return `error: ${e.message}`;
  }
}

// one round-trip to the gateway. toolChoice: 'auto' | 'required' | 'none' | false (false = no tools, pure chat)
// Returns null on network/HTTP errors, { toolChoiceFailed: true } when the model
// refused a forced tool call (gateway 502), or the parsed response object.
 async function chatOnce(messages, toolChoice, tools) {
  // Note: we deliberately do NOT send `user` here. The gateway maps `user` ->
  // a persistent agent session and loads ALL of its history on every request,
  // which grew to a 10MB trajectory and made each call take ~25s. This bot is
  // stateless (it builds a fresh [WORLD] context per job and passes its own
  // `messages` array), so it never uses that memory - stateless is ~2s/call.
  // round-robin across [primary, ...fallbacks]: if the primary is quota-stuck
  // (429), rotate to the next model that still answers. The caller's retry loop
  // then takes over normally. currentModelId can be overwritten by a successful
  // call so subsequent requests converge on the working model.
  const modelRing = [AGENT_MODEL, ...AGENT_MODEL_FALLBACKS];
  for (let attempt = 0; attempt < modelRing.length; attempt++) {
    const model = modelRing[modelTried % modelRing.length];
    const body = { model, messages, max_tokens: parseInt(process.env.BOT_MAX_TOKENS || '140', 10) };
    if (toolChoice) {
      body.tools = tools || MC_TOOLS;
      body.tool_choice = toolChoice;
    }
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), RESPONSE_TIMEOUT_MS);
    let res;
    try {
      res = await fetch(OPENCLAW_URL, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${OPENCLAW_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      clearTimeout(t);
    } catch (e) {
      clearTimeout(t);
      log(`[brain] request error: ${e.name}: ${e.message}`);
      return null;
    }
    if (res.ok) {
      const data = await res.json();
      if (model !== AGENT_MODEL) log(`[brain] using fallback model ${model}`);
      return data;
    }
    const err = await res.text().catch(() => '');
    log(`[brain] HTTP ${res.status} (model ${model}): ${err.slice(0, 200)}`);
    if (res.status === 429 || res.status === 503 || res.status === 500) {
      quotaHitAt = Date.now();
      modelTried++; // try the next model on quota/availability errors
      continue;
    }
    if (res.status === 502) return { toolChoiceFailed: true };
    return null;
  }
  return null; // every model failed - caller's retry loop handles the backoff
}

// auto-retry wrapper: transient 429/5xx quota hits, gateway overloads (502) and
// network blips get retried with a fixed wait instead of dropping the player's
// message. Player messages retry much harder than autonomous jobs (which are
// optional - if the API is down we just skip them and save quota).
async function chatOnceRetry(messages, toolChoice, tools, urgent) {
  const attempts = urgent ? BRAIN_RETRY_ATTEMPTS : 2;
  const delayMs = urgent ? BRAIN_RETRY_DELAY_MS : 8000;
  let last = null;
  for (let a = 0; a < attempts; a++) {
    last = await chatOnce(messages, toolChoice, tools);
    if (last) return last; // success, or a forced-tool refusal we can route around
    if (a < attempts - 1) {
      const wait = delayMs * (a + 1);
      log(`[brain] retry ${a + 1}/${attempts} (${urgent ? 'player msg - waiting ' + Math.round(wait / 1000) + 's' : 'auto job - skipping retry fast'})`);
      // tell the player we're on it, but don't spam - once per 30s max
      if (urgent && Date.now() - retryAckAt > 30000) {
        retryAckAt = Date.now();
        try { bot.chat('one sec - my brain API is a bit slow, retrying automatically'); } catch (e) {}
      }
      await sleep(wait);
    }
  }
  return last;
}

// detect a hallucinated raw-JSON tool call in content (small models do this)
function contentToolCall(content) {
  if (typeof content !== 'string') return null;
  const t = content.trim();
  if (!t.startsWith('{')) return null;
  try {
    const o = JSON.parse(t);
    if (o && typeof o.name === 'string' && MC_TOOLS.some((x) => x.function.name === o.name)) {
      return { id: 'hallucinated', name: o.name, args: o.parameters || o.arguments || {} };
    }
  } catch { return null; }
  return null;
}

// run every tool_calls (or hallucinated content-JSON call) in a model message,
// push the results, return true if any tool actually ran
async function appendToolExecutions(messages, msg) {
  const calls = (msg.tool_calls || []).filter((c) => c && c.function && c.function.name);
  if (calls.length) {
    messages.push(msg);
    for (const tc of calls) {
      let args = {};
      try { args = JSON.parse(tc.function.arguments || '{}'); } catch {}
      const result = await execTool(tc.function.name, args);
      log(`[tool] ${tc.function.name}(${JSON.stringify(args)}) -> ${String(result).slice(0, 140)}`);
      messages.push({ role: 'tool', tool_call_id: tc.id, content: result });
    }
    return true;
  }
  const hc = contentToolCall(msg.content);
  if (hc) {
    const result = await execTool(hc.name, hc.args);
    log(`[tool] content-call ${hc.name}(${JSON.stringify(hc.args)}) -> ${String(result).slice(0, 140)}`);
    messages.push({ role: 'user', content: `tool result: ${result}` });
    return true;
  }
  return false;
}

// 2-stage brain. Stage 1 FORCES a tool call ('required') so the model must
// actually engage with its tools instead of narrating. Stage 2 sends no tools
// at all, guaranteeing a short plain-chat reply grounded in what actually
// happened. Max 2 requests, always terminates (llama3.2 never converges in an
// unbounded tool loop). Keeping it to 2 passes instead of 3 also cuts the
// GPU/RAM load per message roughly a third (the old stage-2 'auto' detour
// wasted a generation and caused drift like "There is no inventory to display.").
async function askBrain(worldCtx, sender, text) {
  isAutonomousJob = sender === 'the world';
  const auto = isAutonomousJob;
  const tip = auto
    ? `You are acting autonomously with no player asking. WORK IN STEPD: scan the area with get_nearby_entities, then ACT on what you find: if a hostile mob (zombie, spider, skeleton, creeper is risky) is within 15 blocks, call attack on it NOW. Otherwise gather resources (dig/collect), feed if hungry, or sleep at night. You may call multiple tools in a row to finish the job. Never attack villagers, iron golems, pets or peaceful animals. Stay within 40 blocks of home; use go_home if you are lost. Finish by deciding the SINGLE most important action and doing it.`
    : `TIP: if the player asks you to DO something in the game (go somewhere, fight something, mine, dig, collect, eat, etc.) you MUST call exactly the right tool for it - never just describe it. You may call several tools in sequence (e.g. scan with get_nearby_entities first, then attack). To answer questions about what you see, where you are, or what you have, use the [WORLD] info above directly - NO tool needed. If the player just greets you or asks what you can do, reply briefly and friendly in your own words (you are their helpful Minecraft companion) - do NOT recite your location or surroundings. If the message is only a greeting, question or statement, reply in plain text WITHOUT calling a tool. Stay near your home and do not wander far from it; only follow or chase a player when a player asks you to. Never claim you did something without calling a tool.`;
  const messages = [{
    role: 'user',
    content: `[WORLD] ${worldCtx}\n${mindBlock()}\n${tip}\n${sender} says: ${text}`,
  }];
  const tools = auto ? AUTONOMY_TOOLS : MC_TOOLS;

  // Tool loop: feed each tool result back to the model until it answers in
  // plain text (no more tool calls) or the iteration cap is hit. This lets a
  // single request CHAIN actions (look around -> spot spider -> attack it)
  // instead of the old single-tool-per-pass behaviour that observed but never
  // acted. MAX_TOOL_ITERS guards against looping models.
  let acted = false;
  let replyText = null;
  for (let iter = 0; iter < MAX_TOOL_ITERS; iter++) {
    let data = await chatOnceRetry(messages, 'auto', tools, !auto);
    if (data && data.toolChoiceFailed) {
      log('[brain] tool call unsatisfied - retrying');
      data = await chatOnceRetry(messages, 'auto', tools, !auto);
    }
    if (!data) return { reply: null, acted };
    const msg = data.choices && data.choices[0] && data.choices[0].message;
    if (!msg) return { reply: null, acted };
    const ran = await appendToolExecutions(messages, msg);
    if (ran) { acted = true; continue; }
    // no tool ran -> the model gave a plain-text answer; use it if sane
    const c = typeof msg.content === 'string' ? msg.content.trim() : '';
    if (c && !c.startsWith('{') && !c.startsWith('[')) { replyText = c; break; }
  }
  if (auto) return { reply: null, acted }; // autonomous jobs act silently - no reply generation needed
  if (replyText) return { reply: replyText, acted };

  // No usable plain-text reply (hit the tool cap or JSON/empty). Fall back to
  // a grounded, honest stage-2 answer based on what actually happened.
  const lastResult = [...messages].reverse().find((m) => m.role === 'tool' || (m.role === 'user' && String(m.content).startsWith('tool result:')));
  if (acted) {
    // a tool actually ran: reply grounded in its result, honest about failures
    const lastText = lastResult ? String(lastResult.content).slice(0, 140) : 'none';
    const isFail = /(still alive|no .+ (nearby|found|in range)|too far|error|failed|nothing|couldn.t|no recipe|not |i don.t|refus)/i.test(lastText);
    const outcome = isFail
      ? ' The tool result shows a FAILURE - say so honestly, never claim a success you did not get.'
      : ' The tool result shows SUCCESS - say what actually happened based on it.';
    messages.push({
      role: 'user',
      content: `You were asked by ${sender}: "${text.slice(0, 120)}". The tool you called returned: "${lastText}". Base your answer ONLY on that exact result - mirror it. If it says you defeated something, say you defeated it; if it says "still alive", say you could not kill it; if it says "nothing to dig", say there was nothing to dig. Do NOT describe actions other than the one tool you ran, and do NOT claim anything the result does not support.${outcome} Reply in ONE short plain sentence. No JSON, no tool syntax.`,
    });
  } else if (/kill|attack|fight|mine|dig|build|place|craft|collect|drop|equip|eat|feed|sleep|follow|come|give|pick ?up|break|hunt|use|open|goto|go to|walk|move to|teleport|tp|fetch|inventory|show me|check|list|how much/i.test(text)) {
    // the request wanted an ACTION but no tool ran: force honesty instead of a made-up claim
    messages.push({
      role: 'user',
      content: `You were asked by ${sender}: "${text.slice(0, 120)}" but you did NOT call any tool, so nothing happened in the game. If that was a request to DO something, admit honestly in one short sentence that you did not do it. If it was really just a question, answer it. No JSON, no tool syntax.`,
    });
  } else {
    messages.push({
      role: 'user',
      content: `You were asked by ${sender}: "${text.slice(0, 120)}" but you replied with nothing useful (only an empty or JSON-shaped answer), so you did NOT do anything in the game. Answer the player directly in ONE short plain sentence. No JSON, no tool syntax.`,
    });
  }
  const data2 = await chatOnce(messages, false);
  const msg2 = data2 && data2.choices && data2.choices[0] && data2.choices[0].message;
  return { reply: msg2 && typeof msg2.content === 'string' ? msg2.content.trim() : '', acted };
}

function cleanReply(raw) {
  let r = (raw || '').replace(/\s+/g, ' ').trim();
  // strip wrapping quotes the model sometimes adds
  if ((r.startsWith('"') && r.endsWith('"')) || (r.startsWith("'") && r.endsWith("'"))) {
    r = r.slice(1, -1).trim();
  }
  // refuse to relay raw JSON / tool-call shapes / instruction echoes
  if (!r || r.startsWith('{') || r.startsWith('[') || r.toLowerCase().includes('"name": "process"')) {
    return null;
  }
  if (r.length > 600) return null; // blabber / verbatim-instruction echo guard
  // (600 chars - the old 220 cap was tuned for llama3.2 and kept throwing away
  // Gemini's perfectly good multi-sentence answers like "That's a huge task!...")
  if (r.toLowerCase().includes('last tool result') || r.toLowerCase().includes('tool syntax') || r.toLowerCase().includes('reply to the player')) return null;
  if (r.toLowerCase().includes("agent couldn't generate") || r.toLowerCase().includes('please try again')) return null; // gateway error boilerplate
  // reject lazy world-context echoes (small model sometimes dumps [WORLD] verbatim)
  if (/time=\w+ weather=\w+|you are at \(-\d+.*overworld/.test(r)) return null;
  if (/^(user|system|assistant)\s*:/.test(r)) return null;
  return r;
}

function pumpBrain() {
  if (brainBusy || !brainQueue.length) return;
  brainBusy = true;
  const job = brainQueue.shift();
  (async () => {
    const { reply: raw, acted } = await askBrain(job.worldCtx, job.sender, job.text);
    // autonomous jobs act silently - no chat spam, they just do things and log
    if (job.autonomous) {
      log(`[autonomy] ${acted ? 'acted' : 'no action'}: "${job.text}"`);
      return;
    }
    const reply = cleanReply(raw);
    if (reply) {
      bot.chat(reply);
      log(`[brain] ${job.sender}: "${job.text}" -> "${reply}"`);
    } else if (quotaHitAt && Date.now() - quotaHitAt < 300000) {
      // API quota/rate limit recently blew up - say so honestly instead of
      // babbling the canned "thoughts went fuzzy" line.
      const fb = 'My brain API just hit its rate limit (429), so I went blank for a sec. Give me a couple of minutes and try again - or tell me a quick command like "follow me" that I can do without thinking.';
      bot.chat(fb);
      log(`[brain] quota fallback reply used (raw=${JSON.stringify(raw)})`);
    } else {
      const fb = 'Hmm, my thoughts went fuzzy for a sec. Say that again?';
      bot.chat(fb);
      log(`[brain] fallback reply used (raw=${JSON.stringify(raw)})`);
    }
  })()
    .catch((e) => log('[brain] pump error ' + e.message))
    .finally(() => { brainBusy = false; isAutonomousJob = false; pumpBrain(); });
}

function handleSay(sender, text) {
  lastPlayerMsgAt = Date.now();
  chatLine('player', sender, text); // feed the rolling [RECENT] history the brain reads
  // FIFO order for human messages (autonomy only fires when this queue is
  // empty, so no need to jump it - pushing keeps replies in send order)
  brainQueue.push({ worldCtx: buildWorldCtx(), sender, text });
  pumpBrain();
}

// ---------------------------------------------------------------------------
// Autonomy: the bot thinks and acts on its own every so often (no player input
// required). Runs only when idle and no human job is queued, so player chat
// always preempts it. Stays inside the home tether radius.
// ---------------------------------------------------------------------------
function maybeAutonomy() {
  try {
    if (descending || !autonomyEnabled || brainBusy || brainQueue.length) return;
    if (building) return; // let the castle builder keep full control of the bot
    if (!bot.entity || bot.health <= 0) return;
    // QUOTA GATE: if we recently hit a 429/5xx, pause autonomous thinking for 10
    // minutes and DON'T waste requests - save the remaining quota for the player.
    if (quotaHitAt && Date.now() - quotaHitAt < 600000) return;
    // PLAYER GATE: autonomous thinking costs API quota and nobody watches the
    // bot while they're offline - only think for ourselves if a person is on
    // the server right now (their explicit commands always work regardless).
    const playerOnline = Object.values(bot.players).some((p) => p && p.username !== USERNAME);
    if (!playerOnline && !mind.keepGoing) {
      // nobody watching AND the player hasn't told us to keep going: limit
      // autonomous thinking to once per 10 minutes so an idle server doesn't
      // drain the daily Gemini quota on its own
      if (lastAutonomyAt && Date.now() - lastAutonomyAt < 600000) return;
    }
    const g = bot.pathfinder.goal;
    if (g && !(g.isFinished ? g.isFinished() : false)) return; // already doing something
    // castle build is a one-shot goal: only offer it until the marker exists
    const castleDone = (() => { try { return fs.existsSync(BUILD_MARKER); } catch { return false; } })();
    // MISSION LADDER (keepGoing ON): the autonomy menu is the game's own ranked
    // climb - the open mission steps FIRST in order (wood -> stone -> iron ->
    // nether -> stronghold -> end -> dragon), then chores as filler. This is the
    // "climbing ranks to complete the game" - every tick pushes the NEXT step,
    // so it walks the whole game instead of tidying the castle yard forever.
    const missionLadder = mind.keepGoing
      ? pendingTodos().map((t, i) => `complete the game: mission step ${i + 1}/${mind.todos.filter((x) => !x.done).length}: ${t.text} - work directly toward this right now, gather what you need for it and carry it out`)
      : [];
    const goals = castleDone || building
      ? missionLadder.length ? missionLadder : AUTONOMY_GOALS
      : missionLadder.length
        ? [...missionLadder, ...AUTONOMY_GOALS, 'build a castle: gather materials and build a stone castle near home using build_structure']
        : [...AUTONOMY_GOALS, 'build a castle: gather materials and build a stone castle near home using build_structure'];
    const goal = goals[autonomyIdx++ % goals.length];
    lastAutonomyAt = Date.now();
    brainQueue.push({ worldCtx: buildWorldCtx(), sender: 'the world', text: `(autonomous) ${goal}`, autonomous: true });
    pumpBrain();
    log(`[autonomy] thinking: ${goal}`);
  } catch (e) { log('autonomy error ' + e.message); }
}
setInterval(maybeAutonomy, AUTONOMY_INTERVAL_MS);

// ---------------------------------------------------------------------------
// Deterministic survival layer - keeps the bot fed and safe WITHOUT the LLM.
// The small models are useless at "I have no food -> hunt that cow". Scripted
// rules handle eating, hunting and defending; the LLM only does higher-level
// stuff. Only acts when the bot is idle (never interrupts a player's order).
// ---------------------------------------------------------------------------
const HUNTABLE = ['cow', 'pig', 'sheep', 'chicken', 'rabbit'];
const GOAL_BUSY = () => { const g = bot.pathfinder.goal; return g && !(g.isFinished ? g.isFinished() : false); };

async function survivalTick() {
  try {
    if (descending || !bot.entity || bot.health <= 0) return;
    const critical = bot.health <= 10 || bot.food === 0;
    // respect ongoing orders, but never let the bot starve to death mid-build
    if (GOAL_BUSY() && !(critical && building)) return;
    const duringBuild = building;
    const p = bot.entity.position;
    const mc = require('minecraft-data')(bot.version);
    const foods = new Set(Object.keys(mc.foods || {}).map(Number));

    // 1) defend: hostile mob within 6 blocks (skip creepers - they explode).
    //    during a build only react to point-blank threats so the bot stays on task.
    //    while seeking drops, do NOT pathfind (GoalFollow would cancel our walk
    //    to the drop) - attack in place only.
    const threatDist = seekingDrops ? 2.5 : (duringBuild ? 3.5 : 6);
    const threat = Object.values(bot.entities)
      .filter((e) => e && e.position && e !== bot.entity && e.kind === 'Hostile mobs'
        && (e.displayName || e.name || '').toLowerCase() !== 'creeper')
      .sort((a, b) => p.distanceTo(a.position) - p.distanceTo(b.position))[0];
    // LOW-HEALTH FLEE: with no armor and <10 HP, fighting zombies usually means
    // dying and dropping everything. Run away and wait for health to recover.
    if (bot.health <= 9) {
      const nearest = Object.values(bot.entities)
        .filter((e) => e && e.position && e !== bot.entity && e.kind === 'Hostile mobs'
          && (e.displayName || e.name || '').toLowerCase() !== 'creeper')
        .sort((a, b) => p.distanceTo(a.position) - p.distanceTo(b.position))[0];
      // flee only if something is actually close enough to finish us off
      if (nearest && p.distanceTo(nearest.position) <= 12) {
        log(`[survival] low health (${bot.health}) - fleeing from ${nearest.displayName || nearest.name}`);
        const away = p.clone().add(p.subtract(nearest.position).normalize().scaled(14));
        away.y = Math.max(p.y, (HOME ? HOME.y : p.y));
        bot.pathfinder.setMovements(makeMovements());
        bot.pathfinder.setGoal(new goals.GoalNear(away.x, away.y, away.z, 2));
        // don't re-engage until health regrows or 25s passes
        const untilEscape = Date.now() + 25000;
        while (Date.now() < untilEscape && bot.health < 14) {
          const stillNear = Object.values(bot.entities)
            .some((e) => e && e.position && e !== bot.entity && e.kind === 'Hostile mobs'
              && (e.displayName || e.name || '').toLowerCase() !== 'creeper'
              && bot.entity.position.distanceTo(e.position) <= 8);
          if (!stillNear) break; // escaped - resume normal behavior immediately
          await sleep(800);
        }
        bot.pathfinder.setGoal(null);
        return;
      }
    }
    if (threat && p.distanceTo(threat.position) <= threatDist) {
      if (seekingDrops) {
        // mid-seek: we are pathing to a dropped item and every bot.attack() can
        // clear the current pathfinder goal, which stalls the collection (the
        // bot re-aims but never moves). Endure a few hits and finish the seek;
        // the normal defense resumes once the drop is collected.
        log(`[survival] ignoring ${threat.displayName || threat.name} while seeking drops`);
        return;
      }
      log(`[survival] defending vs ${threat.displayName || threat.name}`);
      const id = threat.id;
      // mid-dig: attack in place - pathfinder setGoal() calls resetPath() which
      // calls bot.stopDigging(), aborting any in-progress dig (mineflayer quirk)
      const digging = !!bot.targetDigBlock;
      if (!digging && !seekingDrops) {
        bot.pathfinder.setMovements(makeMovements());
        bot.pathfinder.setGoal(new goals.GoalFollow(threat, 2));
      }
      // keep the interruption short - a long blocking loop freezes the whole bot
      const deadline = Date.now() + (seekingDrops ? 3000 : 8000);
      while (Date.now() < deadline && bot.entities[id] && bot.entities[id].position) {
        if (bot.entity.position.distanceTo(bot.entities[id].position) <= 3.5) bot.attack(bot.entities[id]);
        await sleep(400);
      }
      if (!digging && !seekingDrops) bot.pathfinder.setGoal(null);
      return;
    }

    // 2) eat if hungry and we have food (always allowed, even mid-build)
    if (bot.food < 14) {
      const food = inventoryItems().find((i) => foods.has(i.type) && i.name !== 'rotten_flesh');
      if (food) {
        await bot.equip(food, 'hand');
        await bot.activateItem();
        await sleep(2500);
        log(`[survival] ate ${food.name}`);
        return;
      }
    }

    // 3) hunt if starving (never during a build - it drags the bot off-site)
    if (!duringBuild && bot.food < 12) {
      const prey = Object.values(bot.entities)
        .filter((e) => e && e.position && e !== bot.entity && e.name && HUNTABLE.includes(e.name.toLowerCase()))
        .sort((a, b) => p.distanceTo(a.position) - p.distanceTo(b.position))[0];
      if (prey) {
        log(`[survival] hunting ${prey.displayName || prey.name}`);
        const id = prey.id;
        bot.pathfinder.setMovements(makeMovements());
        bot.pathfinder.setGoal(new goals.GoalFollow(prey, 2));
        const deadline = Date.now() + 30000;
        while (Date.now() < deadline && bot.entities[id] && bot.entities[id].position) {
          if (bot.entity.position.distanceTo(bot.entities[id].position) <= 3.5) bot.attack(bot.entities[id]);
          await sleep(400);
        }
        bot.pathfinder.setGoal(null);
        return;
      }
    }
  } catch (e) { log('survival error ' + e.message); }
}
setInterval(survivalTick, 10000);

// ---------------------------------------------------------------------------
// Castle builder: gathers materials and places a castle from a blueprint,
// fully deterministic (no LLM in the loop). Runs async in the background so it
// never blocks chat. Triggered by the "build" chat command, the build_structure
// tool, or (once) by autonomy.
// ---------------------------------------------------------------------------
let building = false; // only one build at a time
let seekingDrops = false; // item-seek is walking to a drop - survival must not hijack the path
const BUILD_MARKER = '/home/user/mc-bridge/state/castle-built.txt';
const BUILD_BLOCKS = ['cobblestone', 'stone', 'cobbled_deepslate', 'deepslate', 'mossy_cobblestone'];

function inventoryCount(names) {
  let n = 0;
  for (const i of inventoryItems()) if (names.some((nm) => i.name.toLowerCase().includes(nm))) n += i.count;
  return n;
}

function groundLevelAt(x, z) {
  // returns the y of the topmost solid block at (x,z) (the block the bot stands ON).
  // Always scan from well above the surface: if the bot is underground in a cave,
  // starting from its own y returns the CAVE CEILING instead of the real ground.
  const start = 128;
  for (let y = start; y > -64; y--) {
    let b; try { b = bot.blockAt(new Vec3(x, y, z)); } catch { continue; }
    if (b && b.name !== 'air' && b.name !== 'cave_air' && b.name !== 'water' && b.name !== 'lava') return y;
  }
  return null;
}

// castle blueprint as a set of absolute block positions (walls + gate + towers).
// first layer sits ON the ground (origin y = ground+1).
function castlePositions(ox, oy, oz) {
  const out = [];
  const keys = new Set();
  const W = 12, H = 8;        // footprint
  const wallH = 2;            // wall layers
  const towerH = 3;           // corner towers
  const gateX = Math.floor(W / 2); // gate gap center on the south wall
  const add = (x, y, z) => {
    const k = `${x},${y},${z}`;
    if (!keys.has(k)) { keys.add(k); out.push({ x, y, z }); }
  };
  // walls (perimeter)
  for (let y = 0; y < wallH; y++) {
    for (let x = 0; x <= W; x++) {
      for (let z = 0; z <= H; z++) {
        const edge = (x === 0 || x === W || z === 0 || z === H);
        if (!edge) continue;
        if (z === H && (x === gateX - 1 || x === gateX) && y === 0) continue; // gate gap (bottom layer only)
        add(ox + x, oy + y, oz + z);
      }
    }
  }
  // corner towers (3x3 footprint, taller) - shares the corner wall blocks
  for (const [tx, tz] of [[0, 0], [W, 0], [0, H], [W, H]]) {
    for (let y = 0; y < towerH; y++) {
      for (let dx = -1; dx <= 1; dx++) {
        for (let dz = -1; dz <= 1; dz++) {
          add(ox + tx + dx, oy + y, oz + tz + dz);
        }
      }
    }
  }
  // sort bottom-up, then by row for tidy building
  out.sort((a, b) => a.y - b.y || a.z - b.z || a.x - b.x);
  return out;
}

async function gotoNear(pos, range, budgetMs) {
  bot.pathfinder.setMovements(makeMovements());
  bot.pathfinder.setGoal(new goals.GoalNear(pos.x, pos.y, pos.z, range));
  const t0 = Date.now();
  while (Date.now() - t0 < budgetMs) {
    if (bot.entity.position.distanceTo(new Vec3(pos.x, pos.y, pos.z)) <= range) break;
    await sleep(200);
  }
}

// ---------------------------------------------------------------------------
// Physical gathering / crafting / building.
// NOTE: bot.findBlock() is unreliable in this mineflayer build (it returns
// nothing), so everything here uses direct grid scans via bot.blockAt().
// ---------------------------------------------------------------------------

const DIGGABLE_GROUND = new Set(['dirt', 'grass_block', 'sand', 'gravel', 'snow_block', 'mud', 'dirt_path', 'sandstone', 'coarse_dirt', 'podzol', 'mycelium']);

function scanForBlock(center, radius, yLo, yHi, predicate) {
  // nearest block position matching predicate within a box around `center`
  const p = center;
  const cx = Math.floor(p.x), cy = Math.floor(p.y), cz = Math.floor(p.z);
  let best = null, bestD = Infinity;
  for (let dx = -radius; dx <= radius; dx++) {
    for (let dz = -radius; dz <= radius; dz++) {
      for (let dy = yLo; dy <= yHi; dy++) {
        const v = new Vec3(cx + dx, cy + dy, cz + dz);
        let b;
        try { b = bot.blockAt(v); } catch { continue; }
        if (b && predicate(b)) {
          const d = p.distanceTo(v);
          if (d < bestD) { bestD = d; best = v; }
        }
      }
    }
  }
  return best;
}

function findNearbyBlock(name, radius) {
  return scanForBlock(bot.entity.position, radius, -6, 6, (b) => b.name === name) || null;
}

function inventoryTotal() {
  let n = 0;
  for (const i of inventoryItems()) n += i.count;
  return n;
}

// Blocks that need a pickaxe to drop anything when mined.
const STONE_FAMILY = new Set(['stone', 'cobblestone', 'cobbled_deepslate', 'deepslate', 'mossy_cobblestone', 'diorite', 'andesite', 'granite', 'sandstone', 'stone_bricks', 'iron_ore', 'coal_ore', 'copper_ore', 'gold_ore']);

// Equip the best pickaxe we have (mineflayer does NOT auto-equip, and mining
// stone bare-handed breaks the block but drops nothing - that was the bug).
async function equipBestPick() {
  const order = ['netherite_pickaxe', 'diamond_pickaxe', 'iron_pickaxe', 'stone_pickaxe', 'golden_pickaxe', 'wooden_pickaxe'];
  for (const nm of order) {
    const item = inventoryItems().find((i) => i.name === nm);
    if (item) {
      try { await bot.equip(item, 'hand'); return nm; } catch (e) {}
    }
  }
  return null;
}

// walk next to a block, dig it, then get within pickup range of the drop.
// When levelGuard is set, blocks that are far above/below the bot's feet are
// skipped (returns -1): their drops land out of pickup range (the cliff-face
// digging bug) and item-seeking can't reliably retrieve them.
async function digToCollect(pos, budgetMs = 15000, levelGuard = false) {
  const target = pos instanceof Vec3 ? pos : new Vec3(pos.x, pos.y, pos.z);
  const center = target.offset(0.5, 0.5, 0.5);
  const before = inventoryTotal();
  if (levelGuard) {
    const feetY = bot.entity.position.y - 1.62;
    if (target.y < feetY - 2.5 || target.y > feetY + 2) {
      return -1;
    }
  }
  if (bot.entity.position.distanceTo(center) > 4.5) {
    bot.pathfinder.setMovements(makeMovements());
    bot.pathfinder.setGoal(new goals.GoalNear(target.x + 0.5, target.y, target.z + 0.5, 1));
    const t0 = Date.now();
    while (Date.now() - t0 < budgetMs) {
      if (bot.entity.position.distanceTo(center) <= 4.5) break;
      await sleep(200);
    }
    bot.pathfinder.setGoal(null);
    await sleep(250);
  }
  if (bot.entity.position.distanceTo(center) > 4.8) return 0;
  const blk = bot.blockAt(target);
  if (!blk || blk.name === 'air' || blk.name === 'cave_air' || blk.name === 'water' || blk.name === 'lava') return 0;
  if (STONE_FAMILY.has(blk.name)) await equipBestPick();
  // dig with retries: transient pathfinder setGoal() calls elsewhere abort digs,
  // so retry a couple of times before giving up on this block
  let dug = false;
  for (let attempt = 0; attempt < 3 && !dug; attempt++) {
    if (attempt > 0) await sleep(500);
    try {
      await bot.dig(blk, 'ignore');
      dug = true;
    } catch (e) {
      const goal = bot.pathfinder.goal;
      log(`[gather] dig err (attempt ${attempt + 1}) ${e.message} | targetDig=${bot.targetDigBlock ? 'set' : 'null'} goal=${goal ? (goal.constructor ? goal.constructor.name : '?') : 'null'}`);
      await sleep(600);
    }
  }
  if (!dug) return 0;
  // the server only auto-picks up drops when we're within ~1.5 blocks, and
  // tree/falling drops land at ground level below the broken block, so seek
  // out the item entity itself rather than the block's position
  const waitUntil = Date.now() + 15000;
  let lastDropGoal = null;
  let seekFlip = 0; // alternate the side we walk PAST the drop so we keep moving
  let seenDropLog = false;
  let lastSeekDiag = 0;
  let lastSeekPos = bot.entity.position.clone();
  seekingDrops = true;
  try {
    while (Date.now() < waitUntil) {
      const after = inventoryTotal();
      if (after > before) break;
      // chase the nearest reachable drop wherever it fell - drops can land several
      // blocks from the broken block (leaf canopies, slopes, tree tops). Only
      // chase drops we can actually get to: within 12 blocks and within +/-3.5
      // blocks vertically (cliff-top drops can't be routed to with canDig=false).
      const myPos = bot.entity.position;
      const items = Object.values(bot.entities)
        .filter((e) => e && e.position && (e.name === 'item' || e.name === 'item_stack'))
        .filter((e) => {
          const dist = e.position.distanceTo(myPos);
          const dy = e.position.y - myPos.y;
          return dist <= 12 && Math.abs(dy) <= 3.5;
        })
        .sort((a, b) => a.position.distanceTo(myPos) - b.position.distanceTo(myPos));
      if (items.length) {
        const d = items[0].position;
        if (Date.now() - lastSeekDiag > 3000) {
          lastSeekDiag = Date.now();
          const bg = bot.pathfinder.goal;
          log(`[seek-diag] bot=(${bot.entity.position.x.toFixed(1)},${bot.entity.position.y.toFixed(1)},${bot.entity.position.z.toFixed(1)}) drop=(${d.x.toFixed(1)},${d.y.toFixed(1)},${d.z.toFixed(1)}) dist=${d.distanceTo(bot.entity.position).toFixed(1)} inv=${inventoryTotal()} goal=${bg ? bg.constructor.name : 'null'} moved=${bot.entity.position.distanceTo(lastSeekPos).toFixed(2)}m`);
          lastSeekPos = bot.entity.position.clone();
        }
        // This server only picks up drops while the player is MOVING, so the bot
        // must always walk through the drop - even when it is already within
        // arm's reach (standing still next to a drop collects nothing).
        const g = bot.pathfinder.goal;
        const goalHijacked = !g || g instanceof goals.GoalFollow || (g.isFinished ? g.isFinished() : false);
        if (goalHijacked) {
          // pathfinder clears the goal as soon as it is reached (or defence
          // stole it). If it is the SAME drop and we already arrived, cross it
          // from the opposite side so we keep MOVING through it (pickup only
          // happens while moving) - re-aiming at the same point would just get
          // cleared instantly again and the bot would stand still forever.
          if (lastDropGoal && d.distanceTo(lastDropGoal) <= 0.6) seekFlip ^= 1;
          lastDropGoal = null; // re-aim
        }
        if (!lastDropGoal || lastDropGoal.distanceTo(d) > 0.6) {
          if (lastDropGoal && d.distanceTo(lastDropGoal) > 0.6) seekFlip = 0; // fresh drop - walk straight at it
          let dx = d.x - bot.entity.position.x;
          let dz = d.z - bot.entity.position.z;
          let len = Math.sqrt(dx * dx + dz * dz);
          if (len < 0.3) { dx = 1; dz = 0; len = 1; } // standing on it - step aside
          const side = seekFlip ? -1 : 1;
          const aim = d.offset(((dx / len) * 2.5) * side, 0, ((dz / len) * 2.5) * side);
          // Walk past the drop so the bot MOVES THROUGH it (pickup only happens
          // while moving). Use a radius-2 GoalNear at the DROP's own y: a radius
          // of 0.5 at the item's y is unreachable (the item rests ~1.5 below the
          // bot's center), but radius 2 makes it reachable so the pathfinder
          // routes the bot down to the drop's level and through its position.
          bot.pathfinder.setMovements(makeMovements());
          bot.pathfinder.setGoal(new goals.GoalNear(aim.x, d.y, aim.z, 2.0));
          lastDropGoal = d;
          if (!seenDropLog) { seenDropLog = true; log(`[seek] chasing drop at (${Math.round(d.x)},${Math.round(d.y)},${Math.round(d.z)}) dist=${items[0].position.distanceTo(bot.entity.position).toFixed(1)}`); }
        }
      }
      await sleep(150);
    }
  } finally {
    seekingDrops = false;
  }
  bot.pathfinder.setGoal(null);
  await sleep(200);
  // wait for the drop to fly to us
  const t1 = Date.now();
  while (Date.now() - t1 < 3000) {
    const after = inventoryTotal();
    if (after > before) return after - before;
    await sleep(150);
  }
  return Math.max(0, inventoryTotal() - before);
}

// walk to within `range` of a position (returns true if we got there)
async function walkNear(pos, range, budgetMs) {
  bot.pathfinder.setMovements(makeMovements());
  bot.pathfinder.setGoal(new goals.GoalNear(pos.x, pos.y, pos.z, range));
  const t0 = Date.now();
  while (Date.now() - t0 < budgetMs) {
    if (bot.entity.position.distanceTo(new Vec3(pos.x + 0.5, pos.y, pos.z + 0.5)) <= range + 2) break;
    await sleep(200);
  }
  bot.pathfinder.setGoal(null);
  await sleep(250);
  return bot.entity.position.distanceTo(new Vec3(pos.x + 0.5, pos.y, pos.z + 0.5)) <= range + 3;
}

// dig oak logs until we have `want` of them
async function gatherWood(want, budgetMs = 240000) {
  const t0 = Date.now();
  const failed = new Set();
  const key = (v) => v.x + ',' + v.y + ',' + v.z;
  let fruitless = 0;
  while (inventoryCount(['oak_log']) < want && Date.now() - t0 < budgetMs) {
    const p = bot.entity.position;
    // find the nearest tree: lowest nearest log, penalising out-of-reach ones
    let best = null, bestScore = Infinity;
    for (let dx = -40; dx <= 40; dx++) {
      for (let dz = -40; dz <= 40; dz++) {
        for (let dy = -10; dy <= 16; dy++) {
          const v = new Vec3(Math.floor(p.x) + dx, Math.floor(p.y) + dy, Math.floor(p.z) + dz);
          if (failed.has(key(v))) continue;
          let b; try { b = bot.blockAt(v); } catch { continue; }
          if (b && b.name === 'oak_log') {
            const reachPenalty = (dy > 6 || dy < -4) ? 60 : 0;
            const score = p.distanceTo(v) + Math.abs(dy) * 2 + reachPenalty;
            if (score < bestScore) { bestScore = score; best = v; }
          }
        }
      }
    }
    if (!best) { log('[gather] no oak logs within 40 blocks'); break; }
    // walk near the tree trunk first (generous budget), then dig the reachable local logs
    await walkNear(best, 2.5, 30000);
    const beforeLocal = inventoryCount(['oak_log']);
    let dugAny = false;
    for (let pass = 0; pass < 8; pass++) {
      // dig the tree BOTTOM-UP: a low log's drop falls through clear air to the
      // ground, while a high log's drop lands on the leaf canopy out of reach
      const logsHere = [];
      for (let dy = -3; dy <= 8; dy++) {
        for (let dx = -6; dx <= 6; dx++) {
          for (let dz = -6; dz <= 6; dz++) {
            const v = new Vec3(Math.floor(bot.entity.position.x) + dx, Math.floor(bot.entity.position.y) + dy, Math.floor(bot.entity.position.z) + dz);
            if (failed.has(key(v))) continue;
            let b; try { b = bot.blockAt(v); } catch { continue; }
            if (b && b.name === 'oak_log') logsHere.push({ v, y: v.y, ady: Math.abs(dy - 1) });
          }
        }
      }
      if (!logsHere.length) break;
      logsHere.sort((a, b) => (a.y - b.y) || (a.ady - b.ady));
      const local = logsHere[0].v;
      const got = await digToCollect(local, 15000);
      if (got > 0) { dugAny = true; }
      else {
        // one failed attempt is often transient (drop resting on a canopy) -
        // retry the same log before writing it off, but don't loop forever
        failed.add(key(local));
        const retry = await digToCollect(local, 12000);
        if (retry > 0) { dugAny = true; failed.delete(key(local)); }
        else log(`[gather] log (${local.x},${local.y},${local.z}) not collectable`);
      }
      await sleep(150);
    }
    if (inventoryCount(['oak_log']) === beforeLocal) {
      fruitless++;
      if (fruitless >= 3) { log('[gather] no reachable logs - giving up'); break; }
    } else fruitless = 0;
    if (!dugAny) await sleep(400);
  }
  return inventoryCount(['oak_log']);
}

// make sure we can reach stone: prefer stone at the bot's own level so drops
// land at our feet (walking to a cliff-face stone mined from above fails -
// the drop falls out of pickup range). If no same-level stone, dig a gentle
// STAIRCASE down through the ground - NEVER straight down, because the bot
// cannot climb back out of a 1-wide vertical shaft (it respawns in those pits).
async function reachStone() {
  const p0 = bot.entity.position;
  const near = scanForBlock(p0, 20, -2, 1, (b) => b.name === 'stone' || b.name === 'cobblestone');
  if (near) return near;
  for (let i = 0; i < 12; i++) {
    const p = bot.entity.position;
    const below = bot.blockAt(p.offset(0, -1, 0));
    if (below && (below.name === 'stone' || below.name === 'cobblestone')) return below.position;
    // dig one stair-step down-forward so we always leave climbable steps behind
    let step = null;
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]]) {
      const cand = p.offset(dx, -2, dz);
      const v = new Vec3(Math.floor(cand.x), Math.floor(cand.y), Math.floor(cand.z));
      const b = bot.blockAt(v);
      if (b && DIGGABLE_GROUND.has(b.name)) { step = v; break; }
    }
    if (!step) {
      const b = bot.blockAt(p.offset(0, -1, 0));
      if (b && DIGGABLE_GROUND.has(b.name)) step = b.position;
    }
    if (!step) return null;
    await digToCollect(step);
    // step down into the freshly dug stair
    bot.pathfinder.setMovements(makeMovements());
    bot.pathfinder.setGoal(new goals.GoalNear(step.x + 0.5, step.y + 0.5, step.z + 0.5, 1));
    const tw = Date.now();
    while (Date.now() - tw < 8000) {
      if (bot.entity.position.distanceTo(new Vec3(step.x + 0.5, step.y + 0.5, step.z + 0.5)) <= 2.5) break;
      await sleep(200);
    }
    bot.pathfinder.setGoal(null);
    await sleep(300);
  }
  return null;
}

// dig stone until we have `want` cobblestone-family blocks in inventory
async function gatherCobble(want, budgetMs) {
  const t0 = Date.now();
  const failed = new Set();
  const key = (v) => v.x + ',' + v.y + ',' + v.z;
  while (inventoryCount(BUILD_BLOCKS) < want && Date.now() - t0 < budgetMs) {
    const sp = await reachStone();
    if (!sp || failed.has(key(sp))) { log('[gather] cannot reach any new stone'); break; }
    const got = await digToCollect(sp, 15000, true);
    if (got === -1) continue; // out of level range - not this spot's fault, keep trying
    if (got > 0) continue;
    failed.add(key(sp));
    log(`[gather] stone at (${sp.x},${sp.y},${sp.z}) not collectable - moving on`);
    await sleep(300);
  }
  return { ok: inventoryCount(BUILD_BLOCKS) >= want, count: inventoryCount(BUILD_BLOCKS) };
}

// craft `count` copies of item `name` (count = times to run the recipe)
async function craftSimple(name, count, needTable) {
  const mc = require('minecraft-data')(bot.version);
  const def = mc.itemsByName[name];
  if (!def) { log('[craft] unknown item ' + name); return false; }
  let table = null;
  if (needTable) {
    const t = findNearbyBlock('crafting_table', 8);
    if (!t) { log('[craft] no crafting table nearby for ' + name); return false; }
    table = bot.blockAt(t);
  }
  let recipes = bot.recipesFor(def.id, null, null, !!needTable);
  if (!recipes || !recipes.length) recipes = bot.recipesFor(def.id);
  if (!recipes || !recipes.length) { log('[craft] no recipe for ' + name); return false; }
  try {
    await bot.craft(recipes[0], count, table);
    log(`[craft] crafted ${name}x${count * ((recipes[0].result && recipes[0].result.count) || 1)}`);
    return true;
  } catch (e) {
    log('[craft] ' + name + ' failed: ' + e.message);
    return false;
  }
}

// place a crafted workshop block (crafting table / furnace) on the ground beside us
// find a flat open 3x3 patch of solid ground with two blocks of air above, near the bot
function findFlatSpot(radius = 8) {
  const p = bot.entity.position;
  for (let dy = -1; dy >= -6; dy--) {
    const gy = Math.floor(p.y) + dy;
    for (let dx = -radius; dx <= radius; dx++) {
      for (let dz = -radius; dz <= radius; dz++) {
        if (dx * dx + dz * dz > radius * radius) continue;
        const gx = Math.floor(p.x) + dx, gz = Math.floor(p.z) + dz;
        let ok = true;
        for (let ox = -1; ox <= 1 && ok; ox++) {
          for (let oz = -1; oz <= 1 && ok; oz++) {
            const g = bot.blockAt(new Vec3(gx + ox, gy, gz + oz));
            if (!g || g.name === 'air' || g.name === 'water' || g.name === 'lava') { ok = false; break; }
          }
        }
        // only the center column needs clear air above for the block itself
        if (ok) {
          const c = bot.blockAt(new Vec3(gx, gy + 1, gz));
          if (!c || (c.name !== 'air' && c.name !== 'cave_air')) ok = false;
          const a = bot.blockAt(new Vec3(gx, gy + 2, gz));
          if (!a || (a.name !== 'air' && a.name !== 'cave_air')) ok = false;
        }
        if (ok) {
          const ground = bot.blockAt(new Vec3(gx, gy, gz));
          const dest = new Vec3(gx, gy + 1, gz);
          return { ground, dest };
        }
      }
    }
  }
  return null;
}

async function placeWorkshopBlock(blockName) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const spot = findFlatSpot();
    if (!spot) { log('[build] no flat spot to place ' + blockName); return false; }
    const item = inventoryItems().find((i) => i.name === blockName); // fresh each attempt
    if (!item) { log('[build] no ' + blockName + ' in inventory to place'); return false; }
    // walk to the spot so the placement is within reach
    bot.pathfinder.setMovements(makeMovements());
    bot.pathfinder.setGoal(new goals.GoalNear(spot.dest.x, spot.dest.y, spot.dest.z, 2));
    const tw = Date.now();
    while (Date.now() - tw < 15000) {
      if (bot.entity.position.distanceTo(spot.dest.offset(0.5, 0, 0.5)) <= 3) break;
      await sleep(200);
    }
    bot.pathfinder.setGoal(null);
    await sleep(300);
    try {
      await bot.equip(item, 'hand');
      // placement validates the player's facing, so look at the face and let the
      // rotation packet reach the server (300ms) before sending block_place
      await bot.lookAt(spot.ground.position.offset(0.5, 1.5, 0.5), true);
      await sleep(300);
      await bot._genericPlace(spot.ground, new Vec3(0, 1, 0), { swingArm: 'right', forceLook: 'ignore' });
      const t1 = Date.now();
      while (Date.now() - t1 < 4000) {
        await sleep(150);
        const b = bot.blockAt(spot.dest);
        if (b && b.name === blockName) { log('[build] placed ' + blockName + ' at ' + spot.dest); return true; }
      }
      log('[build] place ' + blockName + ' verify failed at ' + spot.dest);
    } catch (e) { log('[build] place ' + blockName + ' err ' + e.message); }
    await sleep(500);
  }
  return false;
}

// physically place one block of `blockItem` at `target` (attaches to a solid neighbour)
async function placeBlockAt(target, blockItem) {
  const tv = new Vec3(Math.floor(target.x), Math.floor(target.y), Math.floor(target.z));
  const cur = bot.blockAt(tv);
  if (cur && cur.name !== 'air' && cur.name !== 'cave_air' && cur.name !== 'water') return true; // already filled
  let ref = null, face = null;
  const below = bot.blockAt(tv.offset(0, -1, 0));
  if (below && below.name !== 'air' && below.name !== 'cave_air' && below.name !== 'water' && below.name !== 'lava') {
    ref = below; face = new Vec3(0, 1, 0);
  }
  if (!ref) {
    for (const d of [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]]) {
      const nb = bot.blockAt(tv.offset(d[0], d[1], d[2]));
      if (nb && nb.name !== 'air' && nb.name !== 'cave_air' && nb.name !== 'water' && nb.name !== 'lava') {
        ref = nb; face = new Vec3(-d[0], -d[1], -d[2]);
        break;
      }
    }
  }
  if (!ref) return false;
  const refCenter = ref.position.offset(0.5, 0.5, 0.5);
  if (bot.entity.position.distanceTo(refCenter) > 3.8) {
    bot.pathfinder.setMovements(makeMovements());
    bot.pathfinder.setGoal(new goals.GoalNear(tv.x, tv.y, tv.z, 2));
    const t0 = Date.now();
    while (Date.now() - t0 < 10000) {
      if (bot.entity.position.distanceTo(refCenter) <= 3.8) break;
      await sleep(150);
    }
    bot.pathfinder.setGoal(null);
    await sleep(150);
  }
  if (bot.entity.position.distanceTo(refCenter) > 5) return false;
  const item = inventoryItems().find((i) => i.name === blockItem);
  if (!item) return false;
  try {
    await bot.equip(item, 'hand');
    // placement validates the player's facing, so look at the face and let the
    // rotation packet reach the server (300ms) before sending block_place
    const faceCenter = ref.position.offset(0.5 + face.x * 0.5, 0.5 + face.y * 0.5, 0.5 + face.z * 0.5);
    await bot.lookAt(faceCenter, true);
    await sleep(300);
    await bot._genericPlace(ref, face, { swingArm: 'right', forceLook: 'ignore' });
    const t0 = Date.now();
    while (Date.now() - t0 < 4000) {
      await sleep(150);
      const b = bot.blockAt(tv);
      if (b && b.name === blockItem) return true;
    }
    log('[build] place verify failed at ' + tv);
    return false;
  } catch (e) {
    log('[build] placeBlock err ' + e.message);
    return false;
  }
}

// build every block in posList with the given item, moving only when out of reach
async function physicallyBuild(posList, blockItem) {
  let placed = 0, failed = 0;
  const total = posList.length;
  for (let i = 0; i < total; i++) {
    let ok = false;
    for (let attempt = 0; attempt < 3 && !ok; attempt++) {
      ok = await placeBlockAt(posList[i], blockItem);
      if (!ok) await sleep(300);
    }
    if (ok) placed++; else failed++;
    if (i % 25 === 24 || i === total - 1) log(`[build] placed ${placed}/${i + 1} (${failed} failed)`);
  }
  return { placed, failed };
}

// ---------------------------------------------------------------------------
// Physical castle build: gather wood -> craft tools -> mine cobblestone ->
// craft furniture -> place every block by hand. No server-side fill tricks.
// ---------------------------------------------------------------------------
async function buildCastle() {
  if (building) return 'already building';
  building = true;
  try {
    const home = HOME || bot.entity.position;
    // pick a clear site south-east of home, away from the old demo castle
    const baseX = Math.round(home.x) + 24;
    const baseZ = Math.round(home.z) + 20;
    const gy = groundLevelAt(baseX, baseZ) ?? Math.floor(home.y) - 1;
    const origin = { x: baseX, y: gy + 1, z: baseZ };
    log(`[build] physical castle plan at (${origin.x}, ${origin.y}, ${origin.z})`);
    bot.chat('On it - real gathering, crafting and building. Give me a few minutes.');

    // ---- STEP 1: wood -> tools. Gather in the forest SOUTH of home: home's
    // own trees are chopped down from all the earlier failed runs, while the
    // forest at (-955,285) still has ~227 fresh oak logs (scout.js).
    bot.chat('Step 1: gathering wood for tools...');
    const forestX = -955, forestZ = 285;
    const fg = groundLevelAt(forestX, forestZ) ?? (Math.floor(home.y) - 1);
    await walkNear({ x: forestX + 0.5, y: fg, z: forestZ + 0.5 }, 8, 25000);
    const logs = await gatherWood(10);
    log(`[build] gathered ${logs} oak logs`);
    if (logs < 6) { bot.chat('Could not find enough wood to craft tools - aborting the build.'); return 'not enough wood'; }
    // craft tools at HOME: the forest floor is too sloped for a crafting table
    // ("no flat spot"), while home's carved flagstone is flat.
    const hg2 = groundLevelAt(Math.floor(home.x), Math.floor(home.z)) ?? (Math.floor(home.y) - 1);
    await walkNear({ x: Math.floor(home.x) + 0.5, y: hg2, z: Math.floor(home.z) + 0.5 }, 3, 25000);
    await craftSimple('oak_planks', logs);          // logs -> planks
    await craftSimple('stick', 3);                  // 3 crafts = 12 sticks (8 for the picks, spare for the stone pick)
    await craftSimple('crafting_table', 1);
    await placeWorkshopBlock('crafting_table');
    let picks = 0;
    for (let i = 0; i < 4; i++) {                   // wooden picks only last 59 digs each
      if (await craftSimple('wooden_pickaxe', 1, true)) picks++;
    }
    bot.chat(picks > 0 ? `${picks} wooden pickaxes crafted - time to mine.` : 'Tool crafting hiccup, continuing anyway.');

    // ---- STEP 2: get to the build site at ground level ----
    await walkNear({ x: baseX, y: gy, z: baseZ }, 2.5, 30000);
    // if still stuck up high (pathfinder cannot descend off roofs/trees), walk off
    const gNow = groundLevelAt(baseX, baseZ) ?? gy;
    if (bot.entity.position.y > gNow + 3) {
      await wanderOffHighGround();
      await walkNear({ x: baseX, y: gy, z: baseZ }, 2.5, 20000);
    }
    log(`[build] at build site (${Math.round(bot.entity.position.x)}, ${Math.round(bot.entity.position.y)}, ${Math.round(bot.entity.position.z)})`);

    // ---- STEP 3: mine cobblestone ----
    // castle = 162 blocks, plus 8 for a furnace and 3 for a stone pickaxe
    bot.chat('Step 2: mining cobblestone for the castle...');
    const got = await gatherCobble(180, 12 * 60 * 1000);
    log(`[build] gathered ${got.count} cobblestone-family blocks`);

    // ---- STEP 4: furniture ----
    // the crafts below need the crafting table, so head back to the workshop
    bot.chat('Step 3: crafting furniture for the castle...');
    const tablePos = findNearbyBlock('crafting_table', 80);
    if (tablePos) await walkNear({ x: tablePos.x, y: tablePos.y, z: tablePos.z }, 6, 20000);
    await craftSimple('stone_pickaxe', 1, true);    // faster mining for the rest
    await craftSimple('furnace', 1);
    await placeWorkshopBlock('furnace');
    const door = await craftSimple('oak_door', 1, true);
    const chest = await craftSimple('chest', 1, true);
    log(`[build] door=${door} chest=${chest}`);

    // ---- STEP 4: physically place the castle ----
    bot.chat('Step 4: placing the castle block by block...');
    const blocks = castlePositions(origin.x, origin.y, origin.z);
    const res = await physicallyBuild(blocks, 'cobblestone');
    log(`[build] castle placed: ${res.placed} blocks (${res.failed} failed)`);

    // ---- STEP 5: door in the gate, chest inside ----
    if (door && inventoryCount(['oak_door']) > 0) {
      const gateX = Math.floor(12 / 2);
      await placeBlockAt({ x: origin.x + gateX, y: origin.y, z: origin.z + 8 }, 'oak_door');
    }
    if (chest && inventoryCount(['chest']) > 0) {
      await placeBlockAt({ x: origin.x + 1, y: origin.y, z: origin.z + 4 }, 'chest');
    }

    bot.chat(`Done! Castle is up - ${res.placed} cobblestone blocks placed by hand.`);
    try { fs.writeFileSync(BUILD_MARKER, new Date().toISOString()); } catch {}
    return `built a physical castle (${res.placed} blocks) from gathered cobblestone`;
  } catch (e) {
    log('[build] error ' + e.message);
    bot.chat('The castle build hit a problem - check the log.');
    return 'castle build hit a problem';
  } finally {
    building = false;
  }
}

// ---------------------------------------------------------------------------
// World context ("eyes") for the brain
// ---------------------------------------------------------------------------
const round = (n, d = 1) => Math.round(n * 10 ** d) / 10 ** d;

function buildWorldCtx() {
  try {
    const p = bot.entity.position;
    const facing = (() => {
      const dx = -Math.sin(bot.entity.yaw), dz = Math.cos(bot.entity.yaw);
      return Math.abs(dx) > Math.abs(dz) ? (dx > 0 ? 'east' : 'west') : (dz > 0 ? 'south' : 'north');
    })();
    const biome = (() => {
      try {
        const id = bot.world.getBiome(p);
        const mc = require('minecraft-data')(bot.version);
        return (mc.biomes[id] || {}).name || String(id);
      } catch { return 'unknown'; }
    })();
    const below = (() => { try { return bot.blockAt(p.offset(0, -1, 0))?.name || 'air'; } catch { return 'unknown'; } })();
    const ahead = (() => { try { return bot.blockAtCursor(4)?.name || null; } catch { return null; } })();
    const time = (() => {
      if (!bot.time) return 'unknown';
      const t = bot.time.timeOfDay;
      if (t < 6000) return 'day';
      if (t < 13000) return 'noon';
      if (t < 18000) return 'dusk';
      return 'night';
    })();
    const weather = bot.isRaining ? (bot.thunderState ? 'thunderstorm' : 'rain') : 'clear';
    const players = Object.values(bot.players)
      .filter((pl) => pl.entity && pl.username !== USERNAME)
      .map((pl) => {
        const e = pl.entity.position;
        return `${pl.username} ${round(p.distanceTo(e))}m ${dirFromTo(p, e)}`;
      })
      .join(', ');
    const dim = bot.game.dimension || 'overworld';
    const parts = [
      `you are at (${Math.round(p.x)}, ${Math.round(p.y)}, ${Math.round(p.z)}) in ${dim} (${biome})`,
      `time=${time} weather=${weather}`, `facing=${facing}`,
      `health=${Math.round(bot.health)} food=${Math.round(bot.food)}`,
      `block below=${below}${ahead ? ` block ahead=${ahead}` : ''}`,
      `held item=${bot.heldItem ? bot.heldItem.name : 'nothing'}`,
    ];
    if (players) parts.push(`players nearby: ${players}`);
    return parts.join('; ') + '.';
  } catch (e) {
    return 'you are in a minecraft world.';
  }
}
function dirFromTo(a, b) {
  const dx = b.x - a.x, dz = b.z - a.z;
  if (Math.abs(dx) > Math.abs(dz)) return dx > 0 ? 'east' : 'west';
  return dz > 0 ? 'south' : 'north';
}

// ---------------------------------------------------------------------------
// Movement / action layer (fast, direct, MindCraft-style)
// ---------------------------------------------------------------------------
function makeMovements() {
  const mc = new Movements(bot);
  mc.allowParkour = true; // lets it climb down hills/roofs - off it got STUCK churning
  mc.allowSprinting = true;
  mc.allow1by1towers = false;
  mc.canDig = false;
  mc.canOpenDoors = true;
  mc.canBreakDoors = false;
  mc.liquidCost = 8; // prefer land routes, but allow crossing water when necessary
  return mc;
}

function tryFollow(name) {
  const pl = Object.values(bot.players).find((p) => p.username.toLowerCase() === name.toLowerCase());
  if (pl && pl.entity) {
    bot.pathfinder.setMovements(makeMovements());
    bot.pathfinder.setGoal(new goals.GoalFollow(pl.entity, 3));
    bot.chat(`on my way, ${pl.username}`);
    return true;
  }
  bot.chat(`I don't see ${name} around here`);
  return false;
}

function tryGoto(name) {
  const pl = Object.values(bot.players).find((p) => p.username.toLowerCase() === name.toLowerCase());
  if (pl && pl.entity) {
    bot.pathfinder.setMovements(makeMovements());
    const t = pl.entity.position;
    bot.pathfinder.setGoal(new goals.GoalNear(t.x, t.y, t.z, 2));
    bot.chat(`heading to ${pl.username}`);
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Event handlers
// ---------------------------------------------------------------------------
bot.once('spawn', () => {
  HOME = (bot.spawnPoint && (bot.spawnPoint.x || bot.spawnPoint.z)) ? bot.spawnPoint.clone() : bot.entity.position.clone();
  log(`spawned at ${bot.entity.position.floored().toString()} (home=${HOME.floored().toString()})`);
  bot.chat(`yo, ${USERNAME} here. what\u2019s up?`);
  bot.chat(`psst, eglos1 \u2014 everything still good?`);
});

// greet players as they come online so the bot is visibly alive
bot.on('playerJoined', (player) => {
   if (!player || player.username === USERNAME) return;
   log(`playerJoined: ${player.username}`);
   setTimeout(() => {
     try {
       if (player.username === 'eglos1') {
         bot.chat(`yo ${player.username}, good to see you back`);
       } else {
         bot.chat(`hey ${player.username}, welcome`);
       }
     } catch (e) { log('greet error ' + e.message); }
   }, 2000);
 });

// death/respawn handling - auto-respawn and come home instead of sitting dead
let respawning = false;
bot.on('death', () => {
  respawning = true;
  log('bot died - respawning');
  try { bot.chat('oof, i died! give me a sec to get back up'); } catch (e) {}
  try { bot.respawn(); } catch (e) {}
});
bot._client.on('respawn', () => {
  if (!respawning) return;
  respawning = false;
  log('bot respawned');
  const goal = HOME ? new Vec3(HOME.x, HOME.y, HOME.z) : bot.entity.position.clone();
  setTimeout(() => {
    try {
      // if a respawn dumped us far from HOME (bug: world spawn land can be
      // thousands of blocks away), do NOT try to path all the way back - the
      // pathfinder churns into the endless STUCK loop. Force a reconnect: a
      // fresh login spawns us exactly at the correct worldspawn position.
      const d = HOME ? bot.entity.position.distanceTo(HOME) : 0;
      if (HOME && d > 100) {
        log(`respawned ${Math.round(d)} blocks from home - too far to walk, reconnecting`);
        try { bot.chat('respawn put me miles from home - give me a sec, restarting fast'); } catch (e) {}
        setTimeout(() => process.exit(0), 2500); // systemd Restart=always brings us back
        return;
      }
      if (HOME) {
        bot.pathfinder.setMovements(makeMovements());
        bot.pathfinder.setGoal(new goals.GoalNear(goal.x, goal.y, goal.z, 2));
      }
      bot.chat('back up! heading home');
    } catch (e) { log('respawn home error ' + e.message); }
  }, 4000);
});

const NAME_ESC = String(USERNAME).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const NAME_LOWER = String(USERNAME).toLowerCase();
// extra aliases so players can just say "gemini" / "pal" / "buddy"
const BOT_ALIAS = new Set(['gemini', 'pal', 'buddy']);
const NAME_ALIAS = Array.from(BOT_ALIAS).filter((a) => a !== NAME_LOWER && !NAME_LOWER.includes(a)).join('|');
// match direct address (bot name or generic oracle/hey/hi/yo/oi)
const DIRECTED = new RegExp(`(^|[\\s,!?@])(oracle|the ?oracle|${NAME_ESC}${NAME_ALIAS ? '|' + NAME_ALIAS : ''}|hey|hi|yo|oi)([\\s,!?@]|$)`, 'i');

bot.on('chat', (username, message) => {
  if (username === USERNAME) return;
  logChat('in', username, message);
  console.log(`[chat] ${username}: ${message}`);
  const m = message.trim();

  // direct movement commands (skip the brain, act now). Strip any addressing
  // prefix first ("oracle go to 1 2 3" should act like "go to 1 2 3").
  const lm0 = m.toLowerCase();
  const cmd = lm0.replace(new RegExp(`^(?:(?:hey|hi|yo|oi)[\\s,]*)?(?:the\\s+)?(?:oracle|${NAME_ESC}${NAME_ALIAS ? '|' + NAME_ALIAS : ''})[\\s,:!]*`, 'i'), '');
  // "go to <x> <y> <z>" / "goto x y z" / "walk to x y z" / "tp x y z"
  const goTo = cmd.match(/^(?:go(?: to)?|goto|walk to|teleport to|tp|move to)\s+(-?\d+)\s+(-?\d+)\s+(-?\d+)/);
  if (goTo) {
    bot.pathfinder.setMovements(makeMovements());
    bot.pathfinder.setGoal(new goals.GoalNear(+goTo[1], +goTo[2], +goTo[3], 2));
    bot.chat(`heading to ${goTo[1]}, ${goTo[2]}, ${goTo[3]}`);
    return;
  }
  if (cmd.startsWith('follow ')) return tryFollow(cmd.slice(7));
  if (cmd.startsWith('come to ')) return tryGoto(cmd.slice(8));
  if (cmd === 'follow') {
    const t = Object.values(bot.players).find((p) => p.entity && p.username !== USERNAME);
    return t ? tryFollow(t.username) : bot.chat('nobody to follow right now');
  }
  if (cmd.startsWith('stop') || cmd.startsWith('stay')) { bot.pathfinder.setGoal(null); return bot.chat('stopping here'); }
  if (cmd.startsWith('look at ')) {
    const t = Object.values(bot.players).find((p) => p.username.toLowerCase() === cmd.slice(8).toLowerCase());
    if (t && t.entity) return bot.lookAt(t.entity.position.offset(0, 1.6, 0));
  }
  if (cmd.startsWith('dig')) {
    const b = bot.blockAtCursor(4);
    if (b) { bot.dig(b, 'ignore').then(() => log('dug ' + b.name)).catch((e) => log('dig err ' + e.message)); return; }
    return bot.chat('nothing to dig ahead');
  }
  if (cmd === 'jump') { bot.setControlState('jump', true); setTimeout(() => bot.setControlState('jump', false), 400); return; }
  if (cmd.startsWith('build')) {
    bot.chat('On it - starting the castle build now.');
    buildCastle(); // fire-and-forget async
    return;
  }

  // send ALL non-command player chat to the brain (this is the user's own
  // server - the bot should react to everything said to/about it, not only
  // when it hears its own name). Quick commands above are handled directly.
  handleSay(username, m);
});

bot.on('whisper', (username, message) => {
  if (username === USERNAME) return;
  logChat('whisper', username, message);
  console.log(`[whisper] ${username}: ${message}`);
  handleSay(username, message.trim());
});

// ---------------------------------------------------------------------------
// Perception file (kept for external tooling / debugging)
// ---------------------------------------------------------------------------
setInterval(() => {
  try {
    const p = bot.entity.position;
    const entityList = Object.values(bot.entities)
      .filter((e) => e.position && e !== bot.entity)
      .map((e) => ({
        name: e.username || e.name || e.displayName || 'unknown',
        kind: String(e.kind || e.type || 'entity'),
        x: round(e.position.x), y: round(e.position.y), z: round(e.position.z),
        distance: round(p.distanceTo(e.position)),
      }))
      .sort((a, b) => a.distance - b.distance)
      .slice(0, 60);
    fs.writeFileSync(PERC, JSON.stringify({
      ts: new Date().toISOString(),
      me: USERNAME,
      position: { x: round(p.x), y: round(p.y), z: round(p.z) },
      health: round(bot.health), food: round(bot.food),
      isMoving: !!(bot.entity.velocity && (bot.entity.velocity.x * bot.entity.velocity.x + bot.entity.velocity.z * bot.entity.velocity.z) > 0.0025),
      players: Object.values(bot.players).filter((pl) => pl.entity).map((pl) => ({
        name: pl.username,
        x: round(pl.entity.position.x), y: round(pl.entity.position.y), z: round(pl.entity.position.z),
        distance: round(p.distanceTo(pl.entity.position)),
      })),
      entities: entityList,
    }, null, 2));
  } catch (e) { log('perceive error ' + e.message); }
}, 2500);

// ---------------------------------------------------------------------------
// Commands polling (external controller via commands.json)
// ---------------------------------------------------------------------------
const SEQLOG = process.env.BOT_SEQ || '/home/user/mc-bridge/lastseq.txt';
let lastSeq = 0;
try { lastSeq = parseInt(fs.readFileSync(SEQLOG, 'utf8'), 10) || 0; } catch {}

setInterval(() => {
  try {
    if (!fs.existsSync(CTRL)) return;
    const arr = JSON.parse(fs.readFileSync(CTRL, 'utf8'));
    const fresh = arr.filter((c) => (c.seq || 0) > lastSeq).sort((a, b) => a.seq - b.seq);
    if (!fresh.length) return;
    for (const c of fresh) {
      if (c.op === 'chat') bot.chat(c.msg);
      else if (c.op === 'goto') { bot.pathfinder.setMovements(makeMovements()); bot.pathfinder.setGoal(new goals.GoalNear(c.x, c.y, c.z, 2)); }
      else if (c.op === 'follow') { if (c.player) tryFollow(c.player); }
      else if (c.op === 'look' && c.player) {
        const t = bot.players[c.player] && bot.players[c.player].entity;
        if (t) bot.lookAt(t.position.offset(0, 1.6, 0));
      } else if (c.op === 'dig') {
        const b = bot.blockAtCursor(4);
        if (b) bot.dig(b, 'ignore').then(() => log('dug ' + b.name)).catch((e) => log('dig err ' + e.message));
      } else if (c.op === 'stop') bot.pathfinder.setGoal(null);
      else if (c.op === 'autonomy') {
        autonomyEnabled = c.enabled !== false;
        log('autonomy ' + (autonomyEnabled ? 'enabled' : 'disabled'));
      }
      log('processed command ' + c.op);
    }
    lastSeq = Math.max(...fresh.map((c) => c.seq || 0));
    fs.writeFileSync(SEQLOG, String(lastSeq));
  } catch (e) { log('ctrl error ' + e.message); }
}, 500);

// ---------------------------------------------------------------------------
// Aliveness: head-track the nearest player. Do NOT auto-follow them - the bot
// only follows when explicitly told (follow / move_to_player tools). Instead
// keep a loose home tether: when idle and more than HOME_RADIUS from home,
// stroll back so it never wanders too far.
// ---------------------------------------------------------------------------
let stuckUntil = 0; // don't re-arm a goal right after the watchdog cancelled one

// Roof/hill descent: the bot spawns on top of a build (y=80, home y=73) and the
// pathfinder cannot route straight down, which used to STUCK-churn forever. When
// elevated near home, physically walk each direction until the height drops.
let descending = false;
async function wanderOffHighGround() {
  descending = true;
  try {
    bot.pathfinder.setGoal(null);
    await sleep(400); // let the pathfinder fully stop
    const startY = bot.entity.position.y;
    for (let i = 0; i < 4; i++) {
      if (bot.entity.position.y < startY - 1) break; // already coming down
      bot.look(bot.entity.yaw + (i === 0 ? 0 : (Math.PI / 2) * i), 0, true);
      bot.setControlState('forward', true);
      const t0 = Date.now();
      let descended = false;
      while (Date.now() - t0 < 6000) {
        await sleep(150);
        if (bot.entity.position.y < startY - 1) { descended = true; break; }
      }
      bot.setControlState('forward', false);
      await sleep(300);
      if (descended) {
        bot.setControlState('forward', true); // land on the lower ground
        await sleep(1200);
        bot.setControlState('forward', false);
        log('descended from high ground');
        return true;
      }
    }
    return false;
  } finally {
    descending = false;
  }
}

setInterval(() => {
  try {
    if (building) return; // hands off during a build - the bot is busy
    const target = Object.values(bot.players).find((pl) => pl.entity && pl.username !== USERNAME);
    if (target) {
      const tp = target.entity.position;
      const g = bot.pathfinder.goal;
      const idle = !g || (g.isFinished ? g.isFinished() : false);
      if (idle) bot.lookAt(tp.offset(0, 1.6, 0), false);
    }

    // home tether: only when no active follow (that's an explicit order) and
    // the current goal is done/empty, and we've strayed past HOME_RADIUS
    const g = bot.pathfinder.goal;
    const following = g instanceof goals.GoalFollow;
    const done = !g || (g.isFinished ? g.isFinished() : false);
    if (!descending && !following && done && HOME && Date.now() > stuckUntil && !building) {
      const p = bot.entity.position;
      const d = p.distanceTo(HOME);
      const elevated = p.y > HOME.y + 3; // on a roof / hill - come back to home level
      if (elevated && d < HOME_RADIUS) {
        // near home but high up (usually a rooftop): can't path straight down,
        // so physically walk until we find an edge and drop off
        log(`home tether: elevated ${Math.round(p.y - HOME.y)} above home - walking off high ground`);
        wanderOffHighGround().then((ok) => {
          if (!ok) {
            // fallback: best-effort path home; the stuck watchdog will manage it
            bot.pathfinder.setMovements(makeMovements());
            bot.pathfinder.setGoal(new goals.GoalNear(HOME.x, HOME.y, HOME.z, 3));
          }
        });
      } else if (d > HOME_RADIUS && !mind.keepGoing) {
        // MISSION MODE (keepGoing ON): the home tether lifts so the brain can
        // roam outward to reach the Nether, a stronghold, or the End - you told
        // it to complete the game, and the last steps live far from home. The
        // quota gate + stuck watchdog still protect it; only the *tether* drops.
        bot.pathfinder.setMovements(makeMovements());
        bot.pathfinder.setGoal(new goals.GoalNear(HOME.x, HOME.y, HOME.z, 3));
        log(`home tether: wandering too far (${Math.round(d)} blocks) - heading home`);
      }
    }
  } catch (e) { log('alive error ' + e.message); }
}, 2500);

// ---------------------------------------------------------------------------
// Stuck watchdog
// ---------------------------------------------------------------------------
let lastPos = null;
let lastMoveTime = Date.now();
setInterval(() => {
  try {
    if (building) return; // hands off during a build - the bot is busy
    if (!bot.pathfinder.goal) return;
    const g = bot.pathfinder.goal;
    if (g instanceof goals.GoalFollow && g.entity) {
      const d = bot.entity.position.distanceTo(g.entity.position);
      if (d <= (g.range || 2) + 1.5) { lastPos = bot.entity.position.clone(); lastMoveTime = Date.now(); return; }
    }
    const p = bot.entity.position;
    if (lastPos && p.distanceTo(lastPos) < 0.6) {
      if (Date.now() - lastMoveTime > 15000) {
        log('STUCK - cancelling path');
        bot.pathfinder.setGoal(null);
        stuckUntil = Date.now() + 30000; // back off 30s so the re-follow loop doesn't churn
        // no chat spam - the player sees enough noise already; just fix the path
      }
    } else { lastPos = p.clone(); lastMoveTime = Date.now(); }
  } catch (e) { log('watchdog error ' + e.message); }
}, 3000);

bot.on('error', (e) => log('bot error ' + e.message));
bot.on('end', (reason) => { log('bot ended: ' + reason); process.exit(0); });

// ---------------------------------------------------------------------------
// "Hopelessly lost" watchdog: if HOME is known but we are >100 blocks away for
// 90 continuous seconds (respawning at world origin, void fall, teleport bug),
// walking back is impossible and the tether+stuck loop churns forever. Force a
// reconnect - a clean login always puts the bot at its proper spawn position.
// ---------------------------------------------------------------------------
let lostSince = 0;
setInterval(() => {
  try {
    if (!HOME || !bot.entity || bot.health <= 0) return;
    const d = bot.entity.position.distanceTo(HOME);
    if (d > 100) {
      if (!lostSince) lostSince = Date.now();
      else if (Date.now() - lostSince > 90000) {
        log(`lost watchdog: ${Math.round(d)} blocks from home for 90s - reconnecting`);
        try { bot.chat('im way off course - restarting myself fast, one sec'); } catch (e) {}
        setTimeout(() => process.exit(0), 2500);
        lostSince = 0;
      }
    } else lostSince = 0;
  } catch (e) { log('lost watchdog error ' + e.message); }
}, 5000);

log(`oracle-brain starting: ${HOST}:${PORT} as ${USERNAME} (brain=${AGENT_MODEL})`);
