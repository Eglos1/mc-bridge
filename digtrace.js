const mineflayer = require('mineflayer');
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');
const { Vec3 } = require('vec3');
const fs = require('fs');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MODIN = '/home/user/mc-aibridge/aibridge/in';
const bot = mineflayer.createBot({ host: 'localhost', port: 25565, username: 'OracleDigTrace', auth: 'offline' });
bot.loadPlugin(pathfinder);
const modOp = (obj) => { const f = `${MODIN}/op_${Date.now()}_${Math.floor(Math.random()*1000)}.json`; fs.writeFileSync(f, JSON.stringify(obj)); };
const invTotal = () => bot.inventory.items().reduce((n, i) => n + i.count, 0);
const invName = (nm) => bot.inventory.items().filter(i => i.name === nm).reduce((n, i) => n + i.count, 0);
bot.once('spawn', async () => {
  await sleep(1500);
  const p = bot.entity.position;
  console.log('spawned at', p.x.toFixed(1), p.y.toFixed(1), p.z.toFixed(1));
  modOp({ op: 'give', player: 'OracleDigTrace', item: 'minecraft:wooden_pickaxe', count: 1 });
  await sleep(2500);
  console.log('pickaxes:', invName('wooden_pickaxe'));
  const pick = bot.inventory.items().find(i => i.name === 'wooden_pickaxe');
  await bot.equip(pick, 'hand');
  console.log('equipped, held:', bot.heldItem.name);
  const target = new Vec3(-953, 64, 321);
  const center = target.offset(0.5, 0.5, 0.5);
  // walk near
  bot.pathfinder.setMovements(new Movements(bot));
  bot.pathfinder.setGoal(new goals.GoalNear(target.x + 0.5, target.y, target.z + 0.5, 1.5));
  const t0 = Date.now();
  while (Date.now() - t0 < 20000) {
    if (bot.entity.position.distanceTo(center) <= 4.5) break;
    await sleep(200);
  }
  bot.pathfinder.setGoal(null);
  await sleep(400);
  console.log('after walk: dist to center =', bot.entity.position.distanceTo(center).toFixed(2), 'pos', bot.entity.position.x.toFixed(1), bot.entity.position.y.toFixed(1), bot.entity.position.z.toFixed(1));
  const blk = bot.blockAt(target);
  console.log('target block:', blk ? blk.name : 'null', 'diggable:', blk ? blk.diggable : '?', 'canDig:', blk ? bot.canDigBlock(blk) : '?');
  if (!blk) process.exit(1);
  console.log('digTime ms:', bot.digTime(blk));
  const before = invTotal();
  const t1 = Date.now();
  try {
    await bot.dig(blk, 'ignore');
    console.log('dig resolved in', Date.now() - t1, 'ms; block now:', bot.blockAt(target) ? bot.blockAt(target).name : 'null');
  } catch (e) {
    console.log('dig ERROR:', e.message, 'after', Date.now() - t1, 'ms');
  }
  // walk onto the broken spot
  bot.pathfinder.setGoal(new goals.GoalNear(target.x + 0.5, target.y, target.z + 0.5, 1.2));
  const t2 = Date.now();
  while (Date.now() - t2 < 8000) {
    if (invTotal() > before) break;
    await sleep(150);
  }
  bot.pathfinder.setGoal(null);
  console.log('pickup walk done; inv delta =', invTotal() - before);
  // drop entity check
  for (const e of Object.values(bot.entities)) {
    if (e.name === 'item') {
      const d = e.position.distanceTo(bot.entity.position);
      if (d < 20) console.log('  drop at', e.position.x.toFixed(1), e.position.y.toFixed(1), e.position.z.toFixed(1), 'dist', d.toFixed(1));
    }
  }
  process.exit(0);
});
bot.on('error', (e) => { console.log('err', e.message); process.exit(1); });
setTimeout(() => { console.log('TIMEOUT'); process.exit(1); }, 60000);
