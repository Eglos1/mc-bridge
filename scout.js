const mineflayer = require('mineflayer');
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');
const { Vec3 } = require('vec3');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const bot = mineflayer.createBot({ host: 'localhost', port: 25565, username: 'OracleScout', auth: 'offline' });
bot.loadPlugin(pathfinder);
function scanLogs(radius) {
  const p = bot.entity.position;
  const out = [];
  for (let dx = -radius; dx <= radius; dx++) for (let dz = -radius; dz <= radius; dz++) for (let dy = -8; dy <= 10; dy++) {
    const v = new Vec3(Math.floor(p.x) + dx, Math.floor(p.y) + dy, Math.floor(p.z) + dz);
    let b; try { b = bot.blockAt(v); } catch { continue; }
    if (b && b.name === 'oak_log') out.push({ x: v.x, y: v.y, z: v.z, d: Math.round(Math.sqrt(dx*dx+dz*dz)) });
  }
  return out;
}
bot.once('spawn', async () => {
  await sleep(1000);
  console.log('scout at', bot.entity.position.x.toFixed(0), bot.entity.position.y.toFixed(0), bot.entity.position.z.toFixed(0));
  // walk to the forest area
  bot.pathfinder.setMovements(new Movements(bot));
  bot.pathfinder.setGoal(new goals.GoalNear(-955, 72, 285, 5));
  const t = Date.now();
  while (Date.now() - t < 60000) { if (bot.entity.position.distanceTo(new Vec3(-955,72,285)) < 10) break; await sleep(300); }
  bot.pathfinder.setGoal(null);
  console.log('scout now at', bot.entity.position.x.toFixed(0), bot.entity.position.y.toFixed(0), bot.entity.position.z.toFixed(0));
  const logs = scanLogs(45);
  console.log('oak_log within 45 blocks:', logs.length);
  logs.sort((a,b)=>a.d-b.d);
  for (const l of logs.slice(0,15)) console.log('  log', l.x, l.y, l.z, 'dist', l.d);
  // saplings on ground?
  const items = Object.values(bot.entities).filter(e => e && e.position && e.name === 'item');
  console.log('item entities visible:', items.length);
  process.exit(0);
});
bot.on('error', (e) => { console.log('err', e.message); process.exit(1); });
setTimeout(() => process.exit(1), 80000);
