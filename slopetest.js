const mineflayer = require('mineflayer');
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');
const { Vec3 } = require('vec3');
const fs = require('fs');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MODIN = '/home/user/mc-aibridge/aibridge/in';
const bot = mineflayer.createBot({ host: 'localhost', port: 25565, username: 'OracleSlope', auth: 'offline' });
bot.loadPlugin(pathfinder);
const modOp = (obj) => { const f = `${MODIN}/op_${Date.now()}_${Math.floor(Math.random()*1000)}.json`; fs.writeFileSync(f, JSON.stringify(obj)); };
const invItems = () => bot.inventory.items();
const invTotal = () => invItems().reduce((n, i) => n + i.count, 0);
const invName = (nm) => invItems().filter(i => i.name === nm).reduce((n, i) => n + i.count, 0);
function scanForBlock(center, radius, dyMin, dyMax, pred) {
  for (let dy = dyMin; dy <= dyMax; dy++) for (let dx = -radius; dx <= radius; dx++) for (let dz = -radius; dz <= radius; dz++) {
    const v = new Vec3(Math.floor(center.x)+dx, Math.floor(center.y)+dy, Math.floor(center.z)+dz);
    let b; try { b = bot.blockAt(v); } catch { continue; }
    if (b && pred(b)) return v;
  }
  return null;
}
async function equipPick() {
  const order = ['netherite_pickaxe','diamond_pickaxe','iron_pickaxe','stone_pickaxe','golden_pickaxe','wooden_pickaxe'];
  for (const nm of order) { const item = invItems().find(i => i.name === nm); if (item) { try { await bot.equip(item, 'hand'); return; } catch {} } }
}
async function digToCollect(pos) {
  const target = pos instanceof Vec3 ? pos : new Vec3(pos.x, pos.y, pos.z);
  const center = target.offset(0.5, 0.5, 0.5);
  const before = invTotal();
  if (bot.entity.position.distanceTo(center) > 4.5) {
    bot.pathfinder.setMovements(new Movements(bot));
    bot.pathfinder.setGoal(new goals.GoalNear(target.x + 0.5, target.y, target.z + 0.5, 1));
    const t0 = Date.now();
    while (Date.now() - t0 < 15000) { if (bot.entity.position.distanceTo(center) <= 4.5) break; await sleep(200); }
    bot.pathfinder.setGoal(null);
    await sleep(250);
  }
  if (bot.entity.position.distanceTo(center) > 4.8) { console.log('  -> too far, abort'); return 0; }
  const blk = bot.blockAt(target);
  if (!blk || blk.name === 'air' || blk.name === 'cave_air') return 0;
  if (blk.name === 'oak_log') await equipPick();
  let dug = false;
  for (let attempt = 0; attempt < 3 && !dug; attempt++) {
    if (attempt > 0) await sleep(500);
    try { await bot.dig(blk, 'ignore'); dug = true; } catch (e) { console.log('  dig err', e.message); await sleep(600); }
  }
  if (!dug) return 0;
  console.log('  dug OK, block now', bot.blockAt(target) ? bot.blockAt(target).name : 'null');
  const waitUntil = Date.now() + 8000;
  let lastDropGoal = null;
  while (Date.now() < waitUntil) {
    const after = invTotal();
    if (after > before) { console.log('  PICKED UP via seek, delta', after - before); return after - before; }
    const items = Object.values(bot.entities)
      .filter((e) => e && e.position && (e.name === 'item' || e.name === 'item_stack'))
      .filter((e) => e.position.distanceTo(center) < 10)
      .sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position));
    if (items.length && items[0].position.distanceTo(bot.entity.position) > 1.4) {
      const d = items[0].position;
      if (!lastDropGoal || lastDropGoal.distanceTo(d) > 0.6) {
        bot.pathfinder.setMovements(new Movements(bot));
        bot.pathfinder.setGoal(new goals.GoalNear(d.x, d.y, d.z, 1));
        lastDropGoal = d;
        console.log('  seek -> drop at', d.x.toFixed(1), d.y.toFixed(1), d.z.toFixed(1));
      }
    }
    await sleep(150);
  }
  bot.pathfinder.setGoal(null);
  await sleep(200);
  const t1 = Date.now();
  while (Date.now() - t1 < 3000) { const after = invTotal(); if (after > before) return after - before; await sleep(150); }
  return Math.max(0, invTotal() - before);
}
bot.once('spawn', async () => {
  await sleep(1200);
  console.log('spawned at', bot.entity.position.x.toFixed(1), bot.entity.position.y.toFixed(1), bot.entity.position.z.toFixed(1));
  // teleport near the slope logs at (-915, 72, 308)
  modOp({ op: 'teleport', player: 'OracleSlope', x: -912, y: 75, z: 309 });
  await sleep(3000);
  console.log('after teleport:', bot.entity.position.x.toFixed(1), bot.entity.position.y.toFixed(1), bot.entity.position.z.toFixed(1));
  // find an oak log
  let lp = scanForBlock(bot.entity.position, 12, -3, 4, (b) => b.name === 'oak_log');
  console.log('nearest log:', lp ? lp.toString() : 'none');
  if (!lp) { process.exit(1); }
  const before = invTotal();
  const got = await digToCollect(lp);
  console.log('RESULT: got', got, '(before', before + ')');
  // what does the drop situation look like now?
  const items = Object.values(bot.entities).filter(e => e && e.position && (e.name === 'item' || e.name === 'item_stack'));
  console.log('items within 30 of test bot:', items.filter(e => e.position.distanceTo(bot.entity.position) < 30).length);
  process.exit(0);
});
bot.on('error', (e) => { console.log('err', e.message); process.exit(1); });
setTimeout(() => process.exit(1), 40000);
