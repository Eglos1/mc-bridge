const mineflayer = require('mineflayer');
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');
const { Vec3 } = require('vec3');
const fs = require('fs');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MODIN = '/home/user/mc-aibridge/aibridge/in';
const bot = mineflayer.createBot({ host: 'localhost', port: 25565, username: 'OraclePlaceTest', auth: 'offline' });
bot.loadPlugin(pathfinder);
const modOp = (obj) => { const f = `${MODIN}/op_${Date.now()}_${Math.floor(Math.random()*1000)}.json`; fs.writeFileSync(f, JSON.stringify(obj)); };
const invCount = (nm) => bot.inventory.items().filter(i => i.name === nm).reduce((n, i) => n + i.count, 0);
function findFlatSpot(radius = 8) {
  const p = bot.entity.position;
  for (let dy = -1; dy >= -6; dy--) {
    const gy = Math.floor(p.y) + dy;
    for (let dx = -radius; dx <= radius; dx++) for (let dz = -radius; dz <= radius; dz++) {
      if (dx*dx + dz*dz > radius*radius) continue;
      const gx = Math.floor(p.x)+dx, gz = Math.floor(p.z)+dz;
      let ok = true;
      for (let ox=-1; ox<=1 && ok; ox++) for (let oz=-1; oz<=1 && ok; oz++) {
        const g = bot.blockAt(new Vec3(gx+ox, gy, gz+oz));
        if (!g || g.name === 'air' || g.name === 'water' || g.name === 'lava') { ok=false; break; }
        const c = bot.blockAt(new Vec3(gx+ox, gy+1, gz+oz));
        if (!c || (c.name !== 'air' && c.name !== 'cave_air')) { ok=false; break; }
      }
      if (ok) return { ground: bot.blockAt(new Vec3(gx,gy,gz)), dest: new Vec3(gx,gy+1,gz) };
    }
  }
  return null;
}
bot.once('spawn', async () => {
  await sleep(1200);
  modOp({ op: 'give', player: 'OraclePlaceTest', item: 'minecraft:crafting_table', count: 5 });
  await sleep(2500);
  console.log('tables:', invCount('crafting_table'));
  let ok = 0;
  for (let i = 0; i < 5; i++) {
    const spot = findFlatSpot();
    if (!spot) { console.log('no flat spot'); break; }
    bot.pathfinder.setMovements(new Movements(bot));
    bot.pathfinder.setGoal(new goals.GoalNear(spot.dest.x, spot.dest.y, spot.dest.z, 2));
    const tw = Date.now();
    while (Date.now() - tw < 12000) { if (bot.entity.position.distanceTo(spot.dest.offset(0.5,0,0.5)) <= 3) break; await sleep(200); }
    bot.pathfinder.setGoal(null);
    await sleep(300);
    const item = bot.inventory.items().find(x => x.name === 'crafting_table');
    if (!item) { console.log('ran out of tables'); break; }
    try {
      await bot.equip(item, 'hand');
      await bot._genericPlace(spot.ground, new Vec3(0,1,0), { swingArm: 'right', forceLook: 'ignore' });
      let placed = false;
      const t1 = Date.now();
      while (Date.now() - t1 < 4000) {
        await sleep(150);
        if (bot.blockAt(spot.dest) && bot.blockAt(spot.dest).name === 'crafting_table') { placed = true; break; }
      }
      console.log('attempt', i+1, placed ? 'PLACED' : 'FAILED', 'at', spot.dest);
      if (placed) ok++;
    } catch (e) { console.log('attempt', i+1, 'ERR', e.message.slice(0,60)); }
    await sleep(800);
  }
  console.log('RESULT:', ok, '/ 5');
  process.exit(0);
});
bot.on('error', (e) => { console.log('err', e.message); process.exit(1); });
setTimeout(() => process.exit(1), 90000);
