const mineflayer = require('mineflayer');
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');
const { Vec3 } = require('vec3');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const bot = mineflayer.createBot({ host: 'localhost', port: 25565, username: 'OracleInspect4', auth: 'offline' });
bot.loadPlugin(pathfinder);
bot.once('spawn', async () => {
  await sleep(1200);
  bot.pathfinder.setMovements(new Movements(bot));
  bot.pathfinder.setGoal(new goals.GoalNear(-937, 72, 249, 4));
  const t0 = Date.now();
  while (Date.now() - t0 < 20000) { if (bot.entity.position.distanceTo(new Vec3(-937.5,72,249.5)) < 6) break; await sleep(200); }
  bot.pathfinder.setGoal(null);
  await sleep(500);
  console.log('at', bot.entity.position.x.toFixed(0), bot.entity.position.y.toFixed(0), bot.entity.position.z.toFixed(0));
  for (const [x,y,z] of [[-937,72,249],[-942,64,331],[-946,63,335],[-944,64,335],[-944,64,336]]) {
    const b = bot.blockAt(new Vec3(x,y,z));
    console.log(`(${x},${y},${z}) =`, b ? b.name : 'null');
  }
  const items = Object.values(bot.entities).filter(e => e && e.position && e.name === 'item' && e.position.distanceTo(bot.entity.position) < 16);
  console.log('drops within 16:', items.length);
  for (const it of items.slice(0,6)) {
    console.log('  drop at', it.position.x.toFixed(1), it.position.y.toFixed(1), it.position.z.toFixed(1));
  }
  process.exit(0);
});
bot.on('error', (e) => { console.log('err', e.message); process.exit(1); });
setTimeout(() => process.exit(1), 35000);
