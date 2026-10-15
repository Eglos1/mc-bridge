// dropzone: mod-break a stone near the bot, then bot walks over the drop to auto-pickup
const mineflayer = require('mineflayer');
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');
const { Vec3 } = require('vec3');
const fs = require('fs');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const MODIN = '/home/user/mc-aibridge/aibridge/in';
const bot = mineflayer.createBot({ host: 'localhost', port: 25565, username: 'OracleDrop', auth: 'offline' });
bot.loadPlugin(pathfinder);

function modOp(obj) {
  const f = `${MODIN}/op_${Date.now()}_${Math.floor(Math.random()*1000)}.json`;
  fs.writeFileSync(f, JSON.stringify(obj));
  console.log('mod op written:', f, JSON.stringify(obj));
}
function scanFor(center, radius, yLo, yHi, pred) {
  const cx = Math.floor(center.x), cy = Math.floor(center.y), cz = Math.floor(center.z);
  let best = null, bestD = Infinity;
  for (let dx = -radius; dx <= radius; dx++)
    for (let dz = -radius; dz <= radius; dz++)
      for (let dy = yLo; dy <= yHi; dy++) {
        const v = new Vec3(cx + dx, cy + dy, cz + dz);
        let b; try { b = bot.blockAt(v); } catch { continue; }
        if (b && pred(b)) { const d = center.distanceTo(v); if (d < bestD) { bestD = d; best = v; } }
      }
  return best;
}
function itemsNear(bot, center, radius) {
  const out = [];
  for (const id in bot.entities) {
    const e = bot.entities[id];
    const d = e.position.distanceTo(center);
    const isItem = e.objectType === 'Item' || (e.entityType && e.entityType.displayName === 'Item') || e.name === 'Item';
    if (isItem && d <= radius) out.push({ d: +d.toFixed(1), pos: e.position.toArray().map(v => +v.toFixed(1)) });
  }
  return out;
}
const invS = () => bot.inventory.items().map(i => i.name + 'x' + i.count).join(', ') || 'empty';

bot.once('spawn', async () => {
  for (let i = 0; i < 20; i++) { await sleep(500); if (bot.blockAt(bot.entity.position)) break; }
  await sleep(1500);
  console.log('bot at', bot.entity.position.x.toFixed(0), bot.entity.position.y.toFixed(0), bot.entity.position.z.toFixed(0));
  console.log('inv start:', invS());

  // find a stone ~2-4 blocks away
  const sp = scanFor(bot.entity.position, 6, -4, 0, (b) => b.name === 'stone' || b.name === 'cobblestone');
  if (!sp) { console.log('NO STONE'); process.exit(1); }
  const dist = bot.entity.position.distanceTo(sp.offset(0.5, 0.5, 0.5));
  console.log('target stone at', sp.toString(), 'dist', dist.toFixed(1));

  // 1) mod break it
  modOp({ op: 'break', x: sp.x, y: sp.y, z: sp.z });
  await sleep(2500);
  console.log('after break: block at target =', bot.blockAt(sp) ? bot.blockAt(sp).name : 'null');

  // 2) scan where the drop is
  const center = sp.offset(0.5, 0.5, 0.5);
  let dropPos = null;
  for (let i = 0; i < 8; i++) {
    const items = itemsNear(bot, center, 10);
    if (items.length) { dropPos = items[0].pos; console.log('DROP at', dropPos, '(d', items[0].d + ')'); break; }
    await sleep(400);
  }
  if (!dropPos) {
    // fall back: item may have landed right at the block position
    dropPos = [sp.x + 0.5, sp.y, sp.z + 0.5];
    console.log('no item entity seen; assuming drop at', dropPos);
  }

  // 3) walk over the drop
  const g = new Vec3(dropPos[0], dropPos[1], dropPos[2]);
  bot.pathfinder.setMovements(new Movements(bot));
  bot.pathfinder.setGoal(new goals.GoalNear(g.x, g.y, g.z, 0.5));
  const t0 = Date.now();
  while (Date.now() - t0 < 15000) {
    if (bot.entity.position.distanceTo(g) <= 1.5) break;
    await sleep(200);
  }
  bot.pathfinder.setGoal(null);
  console.log('reached drop area, dist now', bot.entity.position.distanceTo(g).toFixed(1));
  await sleep(2000);
  console.log('inv after walkover:', invS());
  const items = itemsNear(bot, center, 10);
  console.log('item entities remaining:', items.length);
  process.exit(0);
});
bot.on('error', (e) => { console.log('err', e.message); process.exit(1); });
setTimeout(() => { console.log('TIMEOUT'); process.exit(1); }, 45000);
