const mineflayer = require('mineflayer');
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');
const { Vec3 } = require('vec3');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const bot = mineflayer.createBot({ host: 'localhost', port: 25565, username: 'OracleInspect', auth: 'offline' });
bot.loadPlugin(pathfinder);
bot.once('spawn', async () => {
  await sleep(1500);
  // teleport-less: walk to the mining area
  bot.pathfinder.setMovements(new Movements(bot));
  bot.pathfinder.setGoal(new goals.GoalNear(-948, 69, 323, 3));
  const t0 = Date.now();
  while (Date.now() - t0 < 25000) {
    if (bot.entity.position.distanceTo(new Vec3(-948.5, 69, 323.5)) < 5) break;
    await sleep(200);
  }
  bot.pathfinder.setGoal(null);
  await sleep(500);
  console.log('near mining area, pos', bot.entity.position.x.toFixed(0), bot.entity.position.y.toFixed(0), bot.entity.position.z.toFixed(0));
  // report blocks at the mining spots
  for (const [x, y, z] of [[-953,64,321],[-952,64,321],[-952,64,322],[-952,64,323],[-951,64,323],[-950,64,323]]) {
    const b = bot.blockAt(new Vec3(x, y, z));
    console.log(`(${x},${y},${z}) =`, b ? b.name : 'null');
  }
  // report item entities (drops) nearby
  const items = Object.values(bot.entities).filter(e => e.name === 'item');
  console.log('item entities within 24:', items.length);
  for (const it of items) {
    const d = it.position.distanceTo(bot.entity.position);
    if (d < 24) console.log('  drop', it.entityType ? it.entityType.displayName : '?', 'at', it.position.x.toFixed(1), it.position.y.toFixed(1), it.position.z.toFixed(1), 'dist', d.toFixed(1));
  }
  process.exit(0);
});
bot.on('error', (e) => { console.log('err', e.message); process.exit(1); });
setTimeout(() => process.exit(1), 40000);
