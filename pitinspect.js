const mineflayer = require('mineflayer');
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');
const { Vec3 } = require('vec3');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const bot = mineflayer.createBot({ host: 'localhost', port: 25565, username: 'OraclePit', auth: 'offline' });
bot.loadPlugin(pathfinder);
bot.once('spawn', async () => {
  await sleep(1000);
  // walk to the pit at (-933, 65, 269)
  bot.pathfinder.setMovements(new Movements(bot));
  bot.pathfinder.setGoal(new goals.GoalNear(-933, 66, 269, 2));
  const t = Date.now();
  while (Date.now() - t < 30000) { if (bot.entity.position.distanceTo(new Vec3(-933,66,269)) < 4) break; await sleep(300); }
  bot.pathfinder.setGoal(null);
  const p = bot.entity.position;
  console.log('inspect at', p.x.toFixed(1), p.y.toFixed(1), p.z.toFixed(1));
  // cross-section around the pit at the bot's y level
  for (let dy = 3; dy >= -3; dy--) {
    let row = '';
    for (let dx = -3; dx <= 3; dx++) {
      const b = bot.blockAt(new Vec3(Math.floor(p.x) + dx, Math.floor(p.y) + dy, Math.floor(p.z)));
      const n = b ? b.name : 'null';
      row += (n === 'air' ? '.' : n[0].toUpperCase()) + ' ';
    }
    console.log('y+' + (dy >= 0 ? '+' : '') + dy + ': ' + row);
  }
  // is there open air directly above the bot?
  let above = 0;
  for (let dy = 1; dy <= 12; dy++) {
    const b = bot.blockAt(new Vec3(Math.floor(p.x), Math.floor(p.y) + dy, Math.floor(p.z)));
    if (b && b.name === 'air') above++; else break;
  }
  console.log('open air directly above:', above);
  process.exit(0);
});
bot.on('error', (e) => { console.log('err', e.message); process.exit(1); });
setTimeout(() => process.exit(1), 40000);
