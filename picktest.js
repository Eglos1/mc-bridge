// picktest: mod-give a wooden pickaxe, then digToCollect-style dig a stone -> cobblestone?
const mineflayer = require('mineflayer');
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');
const { Vec3 } = require('vec3');
const fs = require('fs');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MODIN = '/home/user/mc-aibridge/aibridge/in';
const bot = mineflayer.createBot({ host: 'localhost', port: 25565, username: 'OraclePick', auth: 'offline' });
bot.loadPlugin(pathfinder);
const invS = () => bot.inventory.items().map(i => i.name + 'x' + i.count).join(', ') || 'empty';
const invCount = (nm) => bot.inventory.items().filter(i => i.name === nm).reduce((n, i) => n + i.count, 0);
const modOp = (obj) => { const f = `${MODIN}/op_${Date.now()}_${Math.floor(Math.random()*1000)}.json`; fs.writeFileSync(f, JSON.stringify(obj)); console.log('mod op:', JSON.stringify(obj)); };
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

bot.once('spawn', async () => {
  for (let i = 0; i < 20; i++) { await sleep(500); if (bot.blockAt(bot.entity.position)) break; }
  await sleep(1500);
  console.log('bot at', bot.entity.position.x.toFixed(0), bot.entity.position.y.toFixed(0), bot.entity.position.z.toFixed(0));
  console.log('inv start:', invS());
  if (invCount('wooden_pickaxe') === 0) {
    modOp({ op: 'give', player: 'OraclePick', item: 'minecraft:wooden_pickaxe', count: 1 });
    await sleep(2000);
  }
  console.log('after give:', invS());
  if (invCount('wooden_pickaxe') === 0) { console.log('NO PICKAXE GIVEN'); process.exit(1); }

  // equip it
  const pick = bot.inventory.items().find(i => i.name === 'wooden_pickaxe');
  await bot.equip(pick, 'hand');
  console.log('equipped:', bot.heldItem && bot.heldItem.name);

  // find a stone
  const sp = scanFor(bot.entity.position, 8, -4, 0, (b) => b.name === 'stone');
  if (!sp) { console.log('NO STONE'); process.exit(1); }
  const center = sp.offset(0.5, 0.5, 0.5);
  console.log('target stone', sp.toString(), 'dist', bot.entity.position.distanceTo(center).toFixed(1));

  // walk adjacent
  bot.pathfinder.setMovements(new Movements(bot));
  bot.pathfinder.setGoal(new goals.GoalNear(sp.x + 0.5, sp.y, sp.z + 0.5, 1.2));
  const t0 = Date.now();
  while (Date.now() - t0 < 12000) { if (bot.entity.position.distanceTo(center) <= 4.5) break; await sleep(200); }
  bot.pathfinder.setGoal(null);
  await sleep(300);
  console.log('digging...');
  const before = invCount('cobblestone');
  const blk = bot.blockAt(sp);
  try { await bot.dig(blk); console.log('dig resolved'); } catch (e) { console.log('dig threw', e.message); }

  // walk onto the broken block (pickup range)
  if (bot.entity.position.distanceTo(center) > 1.6) {
    bot.pathfinder.setMovements(new Movements(bot));
    bot.pathfinder.setGoal(new goals.GoalNear(sp.x + 0.5, sp.y, sp.z + 0.5, 1.2));
    const t2 = Date.now();
    while (Date.now() - t2 < 8000) { if (invCount('cobblestone') > before) break; await sleep(150); }
    bot.pathfinder.setGoal(null);
  }
  const t1 = Date.now();
  while (Date.now() - t1 < 3000) { if (invCount('cobblestone') > before) break; await sleep(150); }
  console.log('cobblestone delta:', invCount('cobblestone') - before);
  console.log('inv final:', invS());
  process.exit(0);
});
bot.on('error', (e) => { console.log('err', e.message); process.exit(1); });
setTimeout(() => { console.log('TIMEOUT'); process.exit(1); }, 50000);
