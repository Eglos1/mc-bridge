const mineflayer = require('mineflayer');
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');
const { Vec3 } = require('vec3');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const bot = mineflayer.createBot({ host: 'localhost', port: 25565, username: 'OracleInspect2', auth: 'offline' });
bot.loadPlugin(pathfinder);
bot.once('spawn', async () => {
  await sleep(1500);
  console.log('pos', bot.entity.position.x.toFixed(0), bot.entity.position.y.toFixed(0), bot.entity.position.z.toFixed(0));
  // walk toward the recent dig area
  bot.pathfinder.setMovements(new Movements(bot));
  bot.pathfinder.setGoal(new goals.GoalNear(-923, 70, 327, 4));
  const t0 = Date.now();
  while (Date.now() - t0 < 20000) { if (bot.entity.position.distanceTo(new Vec3(-923.5,70,327.5)) < 8) break; await sleep(200); }
  bot.pathfinder.setGoal(null);
  await sleep(500);
  console.log('near area, pos', bot.entity.position.x.toFixed(0), bot.entity.position.y.toFixed(0), bot.entity.position.z.toFixed(0));
  // check the previously "dug" blocks
  for (const [x,y,z] of [[-923,73,314],[-923,72,314],[-917,72,315],[-917,73,315],[-923,71,314],[-917,74,315],[-923,71,311],[-923,70,327],[-924,68,337]]) {
    const b = bot.blockAt(new Vec3(x,y,z));
    if (b && b.name !== 'air') console.log(`(${x},${y},${z}) =`, b.name);
  }
  // item entities
  const items = Object.values(bot.entities).filter(e => e && e.name === 'item' && e.position && e.position.distanceTo(bot.entity.position) < 20);
  console.log('item entities within 20:', items.length);
  for (const it of items.slice(0,8)) {
    const dd = it.position.distanceTo(bot.entity.position);
    console.log('  drop', it.metadata && it.metadata[8] ? it.metadata[8].displayName : '?', 'at', it.position.x.toFixed(1), it.position.y.toFixed(1), it.position.z.toFixed(1), 'dist', dd.toFixed(1));
  }
  process.exit(0);
});
bot.on('error', (e) => { console.log('err', e.message); process.exit(1); });
setTimeout(() => process.exit(1), 40000);
