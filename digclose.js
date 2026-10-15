// digclose: does bot.dig drop when the bot is RIGHT NEXT to the block?
const mineflayer = require('mineflayer');
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');
const { Vec3 } = require('vec3');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const bot = mineflayer.createBot({ host: 'localhost', port: 25565, username: 'OracleClose', auth: 'offline' });
bot.loadPlugin(pathfinder);

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
function itemsNear(radius) {
  const out = [];
  for (const id in bot.entities) {
    const e = bot.entities[id];
    const isItem = e.objectType === 'Item' || (e.entityType && e.entityType.displayName === 'Item') || e.name === 'Item';
    if (isItem && e.position.distanceTo(bot.entity.position) <= radius) out.push(e.position.toArray().map(v => +v.toFixed(1)));
  }
  return out;
}
const invS = () => bot.inventory.items().map(i => i.name + 'x' + i.count).join(', ') || 'empty';

bot.once('spawn', async () => {
  for (let i = 0; i < 20; i++) { await sleep(500); if (bot.blockAt(bot.entity.position)) break; }
  await sleep(1500);
  console.log('bot at', bot.entity.position.x.toFixed(0), bot.entity.position.y.toFixed(0), bot.entity.position.z.toFixed(0), 'inv:', invS());

  // pick a stone within reach
  const sp = scanFor(bot.entity.position, 6, -4, 0, (b) => b.name === 'stone' || b.name === 'cobblestone');
  if (!sp) { console.log('NO STONE'); process.exit(1); }
  console.log('target', sp.toString(), 'dist', bot.entity.position.distanceTo(sp.offset(0.5,0.5,0.5)).toFixed(1));

  // walk adjacent to the block (stand on the block below/next to it)
  bot.pathfinder.setMovements(new Movements(bot));
  bot.pathfinder.setGoal(new goals.GoalNear(sp.x + 0.5, sp.y + 1, sp.z + 0.5, 1.2));
  const t0 = Date.now();
  while (Date.now() - t0 < 12000) { if (bot.entity.position.distanceTo(new Vec3(sp.x+0.5, sp.y+1, sp.z+0.5)) <= 2) break; await sleep(200); }
  bot.pathfinder.setGoal(null);
  await sleep(400);
  const d = bot.entity.position.distanceTo(sp.offset(0.5,0.5,0.5));
  console.log('dist to target now', d.toFixed(1));
  const before = bot.inventory.items().reduce((n,i)=>n+i.count,0);
  try { await bot.dig(bot.blockAt(sp)); console.log('dig resolved'); } catch (e) { console.log('dig threw', e.message); }
  await sleep(3000);
  console.log('inv after dig:', invS());
  const after = bot.inventory.items().reduce((n,i)=>n+i.count,0);
  console.log('item count delta:', after - before);
  console.log('items within 6:', itemsNear(6).length);
  process.exit(0);
});
bot.on('error', (e) => { console.log('err', e.message); process.exit(1); });
setTimeout(() => { console.log('TIMEOUT'); process.exit(1); }, 40000);
