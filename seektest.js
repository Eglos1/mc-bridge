const mineflayer = require('mineflayer');
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');
const { Vec3 } = require('vec3');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const bot = mineflayer.createBot({ host: 'localhost', port: 25565, username: 'OracleSeek', auth: 'offline' });
bot.loadPlugin(pathfinder);
const makeMovements = () => new Movements(bot);
const invTotal = () => bot.inventory.items().reduce((n, i) => n + i.count, 0);
bot.once('spawn', async () => {
  await sleep(1200);
  const p = bot.entity.position;
  console.log('spawned at', p.x.toFixed(1), p.y.toFixed(1), p.z.toFixed(1), 'inv:', invTotal());
  const before = invTotal();
  // run the EXACT fixed seek logic for 15s
  const tEnd = Date.now() + 15000;
  let lastDropGoal = null;
  let seeks = 0;
  while (Date.now() < tEnd) {
    const after = invTotal();
    if (after > before) { console.log('COLLECTED during seek, delta', after - before); break; }
    const items = Object.values(bot.entities)
      .filter((e) => e && e.position && (e.name === 'item' || e.name === 'item_stack'))
      .sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position));
    if (items.length) {
      const d = items[0].position;
      if (!lastDropGoal || lastDropGoal.distanceTo(d) > 0.6) {
        let dx = d.x - bot.entity.position.x;
        let dz = d.z - bot.entity.position.z;
        let len = Math.sqrt(dx * dx + dz * dz);
        if (len < 0.3) { dx = 1; dz = 0; len = 1; }
        const aim = d.offset((dx / len) * 2.5, 0, (dz / len) * 2.5);
        bot.pathfinder.setMovements(makeMovements());
        bot.pathfinder.setGoal(new goals.GoalNear(aim.x, d.y, aim.z, 0.5));
        lastDropGoal = d;
        seeks++;
        console.log(`seek #${seeks} to drop at`, d.x.toFixed(1), d.y.toFixed(1), d.z.toFixed(1), 'dist', items[0].position.distanceTo(bot.entity.position).toFixed(1));
      }
    }
    await sleep(200);
  }
  console.log('final inv delta:', invTotal() - before, '| seeks issued:', seeks, '| pos now', bot.entity.position.x.toFixed(1), bot.entity.position.y.toFixed(1), bot.entity.position.z.toFixed(1));
  process.exit(0);
});
bot.on('error', (e) => { console.log('err', e.message); process.exit(1); });
setTimeout(() => process.exit(1), 25000);
