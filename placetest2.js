const mineflayer = require('mineflayer');
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');
const { Vec3 } = require('vec3');
const fs = require('fs');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MODIN = '/home/user/mc-aibridge/aibridge/in';
const bot = mineflayer.createBot({ host: 'localhost', port: 25565, username: 'OraclePlaceTest2', auth: 'offline' });
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
async function tryPlace(spot, method) {
  const faceCenter = spot.ground.position.offset(0.5, 1.5, 0.5);
  try {
    if (method === 'smoothLook') {
      await bot.lookAt(faceCenter, false);
      await sleep(300);
      await bot._genericPlace(spot.ground, new Vec3(0,1,0), { swingArm: 'right', forceLook: 'ignore' });
    } else if (method === 'forceLookDelay') {
      await bot.lookAt(faceCenter, true);
      await sleep(300);
      await bot._genericPlace(spot.ground, new Vec3(0,1,0), { swingArm: 'right', forceLook: 'ignore' });
    } else if (method === 'options') {
      await bot._placeBlockWithOptions(spot.ground, new Vec3(0,1,0), { swingArm: 'right', forceLook: true });
    }
    const t1 = Date.now();
    while (Date.now() - t1 < 4000) {
      await sleep(150);
      const b = bot.blockAt(spot.dest);
      if (b && b.name === 'crafting_table') return true;
    }
    return false;
  } catch (e) { return 'ERR:' + e.message.slice(0, 40); }
}
bot.once('spawn', async () => {
  await sleep(1200);
  modOp({ op: 'give', player: 'OraclePlaceTest2', item: 'minecraft:crafting_table', count: 18 });
  await sleep(2500);
  console.log('tables:', invCount('crafting_table'));
  for (const method of ['smoothLook', 'forceLookDelay', 'options']) {
    let ok = 0; const fails = [];
    for (let i = 0; i < 5; i++) {
      const spot = findFlatSpot();
      if (!spot) { fails.push('no spot'); break; }
      bot.pathfinder.setMovements(new Movements(bot));
      bot.pathfinder.setGoal(new goals.GoalNear(spot.dest.x, spot.dest.y, spot.dest.z, 2));
      const tw = Date.now();
      while (Date.now() - tw < 12000) { if (bot.entity.position.distanceTo(spot.dest.offset(0.5,0,0.5)) <= 3) break; await sleep(200); }
      bot.pathfinder.setGoal(null);
      await sleep(300);
      const item = bot.inventory.items().find(x => x.name === 'crafting_table');
      if (!item) { fails.push('no item'); break; }
      try { await bot.equip(item, 'hand'); } catch {}
      const r = await tryPlace(spot, method);
      if (r === true) ok++; else fails.push(String(r));
      await sleep(600);
    }
    console.log(method, '->', ok, '/5  fails:', fails);
    // move to a different area for each method to avoid reusing identical spots
    modOp({ op: 'give', player: 'OraclePlaceTest2', item: 'minecraft:crafting_table', count: 18 });
    await sleep(2000);
  }
  process.exit(0);
});
bot.on('error', (e) => { console.log('err', e.message); process.exit(1); });
setTimeout(() => process.exit(1), 150000);
