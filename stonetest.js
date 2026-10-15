const mineflayer = require('mineflayer');
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');
const { Vec3 } = require('vec3');
const fs = require('fs');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MODIN = '/home/user/mc-aibridge/aibridge/in';
const bot = mineflayer.createBot({ host: 'localhost', port: 25565, username: 'OracleStoneTest', auth: 'offline' });
bot.loadPlugin(pathfinder);
const modOp = (obj) => { const f = `${MODIN}/op_${Date.now()}_${Math.floor(Math.random()*1000)}.json`; fs.writeFileSync(f, JSON.stringify(obj)); };
const invTotal = () => bot.inventory.items().reduce((n, i) => n + i.count, 0);
const invName = (nm) => bot.inventory.items().filter(i => i.name === nm).reduce((n, i) => n + i.count, 0);
function scanForBlock(center, radius, dyMin, dyMax, pred) {
  for (let dy = dyMin; dy <= dyMax; dy++) for (let dx = -radius; dx <= radius; dx++) for (let dz = -radius; dz <= radius; dz++) {
    const v = new Vec3(Math.floor(center.x)+dx, Math.floor(center.y)+dy, Math.floor(center.z)+dz);
    let b; try { b = bot.blockAt(v); } catch { continue; }
    if (b && pred(b)) return v;
  }
  return null;
}
bot.once('spawn', async () => {
  await sleep(1200);
  console.log('pos', bot.entity.position.x.toFixed(0), bot.entity.position.y.toFixed(0), bot.entity.position.z.toFixed(0));
  modOp({ op: 'give', player: 'OracleStoneTest', item: 'minecraft:wooden_pickaxe', count: 2 });
  await sleep(2500);
  console.log('pickaxes:', invName('wooden_pickaxe'));
  // find surface stone near home
  let sp = scanForBlock(bot.entity.position, 15, -4, 1, (b) => b.name === 'stone' || b.name === 'cobblestone');
  console.log('target stone:', sp ? sp.toString() : 'none');
  if (!sp) process.exit(1);
  const center = sp.offset(0.5, 0.5, 0.5);
  bot.pathfinder.setMovements(new Movements(bot));
  bot.pathfinder.setGoal(new goals.GoalNear(sp.x + 0.5, sp.y, sp.z + 0.5, 1.5));
  const tw = Date.now();
  while (Date.now() - tw < 15000) { if (bot.entity.position.distanceTo(center) <= 4.5) break; await sleep(200); }
  bot.pathfinder.setGoal(null);
  await sleep(400);
  console.log('dist to stone center:', bot.entity.position.distanceTo(center).toFixed(2), 'bot y:', bot.entity.position.y.toFixed(1), 'stone y:', sp.y);
  const blk = bot.blockAt(sp);
  console.log('block:', blk ? blk.name : 'null', 'diggable:', blk ? blk.diggable : '?');
  const pick = bot.inventory.items().find(i => i.name === 'wooden_pickaxe');
  if (pick) await bot.equip(pick, 'hand');
  console.log('held:', bot.heldItem ? bot.heldItem.name : 'none');
  const before = invTotal();
  try { await bot.dig(blk, 'ignore'); console.log('dig OK'); }
  catch (e) { console.log('dig ERR', e.message); }
  await sleep(500);
  console.log('block after dig:', bot.blockAt(sp) ? bot.blockAt(sp).name : 'null');
  console.log('inventory delta:', invTotal() - before);
  // item seek
  const t1 = Date.now();
  while (Date.now() - t1 < 8000) {
    const items = Object.values(bot.entities).filter(e => e && e.position && (e.name === 'item' || e.name === 'item_stack'));
    console.log('items visible:', items.length);
    for (const it of items.slice(0,3)) console.log('  item at', it.position.x.toFixed(1), it.position.y.toFixed(1), it.position.z.toFixed(1));
    if (items.length) {
      const d = items[0].position;
      bot.pathfinder.setMovements(new Movements(bot));
      bot.pathfinder.setGoal(new goals.GoalNear(d.x, d.y, d.z, 1));
    }
    await sleep(1000);
    if (invTotal() > before) { console.log('PICKED UP, delta:', invTotal() - before); break; }
  }
  bot.pathfinder.setGoal(null);
  console.log('final delta:', invTotal() - before);
  process.exit(0);
});
bot.on('error', (e) => { console.log('err', e.message); process.exit(1); });
setTimeout(() => process.exit(1), 50000);
