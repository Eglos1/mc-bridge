const mineflayer = require('mineflayer');
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');
const { Vec3 } = require('vec3');
const fs = require('fs');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MODIN = '/home/user/mc-aibridge/aibridge/in';
const bot = mineflayer.createBot({ host: 'localhost', port: 25565, username: 'OraclePlaceLab', auth: 'offline' });
bot.loadPlugin(pathfinder);
const modOp = (obj) => { const f = `${MODIN}/op_${Date.now()}_${Math.floor(Math.random()*1000)}.json`; fs.writeFileSync(f, JSON.stringify(obj)); };
const invCount = (nm) => bot.inventory.items().filter(i => i.name === nm).reduce((n, i) => n + i.count, 0);
function findGround(center, radius) {
  for (let dx = -radius; dx <= radius; dx++) for (let dz = -radius; dz <= radius; dz++) {
    for (let dy = -3; dy <= 0; dy++) {
      const v = new Vec3(Math.floor(center.x)+dx, Math.floor(center.y)+dy, Math.floor(center.z)+dz);
      let g; try { g = bot.blockAt(v); } catch { continue; }
      if (g && g.name !== 'air' && g.name !== 'water' && g.name !== 'lava') {
        const cell = bot.blockAt(v.plus(new Vec3(0,1,0)));
        if (cell && cell.name === 'air') return { ground: g, dest: v.plus(new Vec3(0,1,0)) };
      }
    }
  }
  return null;
}
async function tryPlace(method, ground, face) {
  try {
    if (method === 'plain') await bot.placeBlock(ground, face);
    else if (method === 'forceLook') await bot._placeBlockWithOptions(ground, face, { swingArm: 'right', forceLook: true });
    else await bot._placeBlockWithOptions(ground, face, { swingArm: 'right', forceLook: false });
    const b = bot.blockAt(ground.position.plus(face));
    return b ? b.name : 'null';
  } catch (e) { return 'ERR:' + e.message.slice(0, 60); }
}
bot.once('spawn', async () => {
  for (let i = 0; i < 20; i++) { await sleep(500); if (bot.blockAt(bot.entity.position)) break; }
  await sleep(1500);
  console.log('bot at', bot.entity.position.x.toFixed(0), bot.entity.position.y.toFixed(0), bot.entity.position.z.toFixed(0));
  if (invCount('crafting_table') === 0) { modOp({ op: 'give', player: 'OraclePlaceLab', item: "minecraft:crafting_table", count: 20 }); await sleep(2500); }
  console.log('tables:', invCount('crafting_table'));
  for (const method of ['plain', 'forceLook', 'forceLookFalse']) {
    let ok = 0, detail = [];
    for (let i = 0; i < 4; i++) {
      const spot = findGround(bot.entity.position, 10);
      if (!spot) { console.log('no ground'); break; }
      // walk within 2.5 of the dest
      bot.pathfinder.setMovements(new Movements(bot));
      bot.pathfinder.setGoal(new goals.GoalNear(spot.dest.x, spot.dest.y, spot.dest.z, 2));
      const t0 = Date.now();
      while (Date.now() - t0 < 10000) { if (bot.entity.position.distanceTo(spot.dest) <= 3) break; await sleep(200); }
      bot.pathfinder.setGoal(null);
      await sleep(400);
      let item = bot.inventory.items().find(x => x.name === "crafting_table"); if (!item) { modOp({ op: "give", player: "OraclePlaceLab", item: "minecraft:crafting_table", count: 20 }); await sleep(2500); item = bot.inventory.items().find(x => x.name === "crafting_table"); }
      await bot.equip(item, 'hand');
      await bot.lookAt(spot.dest.offset(0, 0.2, 0), true);
      const res = await tryPlace(method, spot.ground, new Vec3(0,1,0));
      if (res === 'crafting_table') ok++; else detail.push(res);
      await sleep(1000);
    }
    console.log(method, "-> ok", ok, "/ 4  fails:", detail);
  }
  process.exit(0);
});
bot.on('error', (e) => { console.log('err', e.message); process.exit(1); });
setTimeout(() => { console.log('TIMEOUT'); process.exit(1); }, 120000);
