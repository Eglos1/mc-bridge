// Craft-chain validation: dig logs physically, then craft planks -> sticks -> table -> pickaxe
const mineflayer = require('mineflayer');
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');
const { Vec3 } = require('vec3');
const fs = require('fs');

const bot = mineflayer.createBot({ host: 'localhost', port: 25565, username: 'OracleCraft', auth: 'offline' });
bot.loadPlugin(pathfinder);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const LOGF = '/tmp/opencode/craft-test.log';
const log = (s) => { fs.appendFileSync(LOGF, `[${new Date().toISOString()}] ${s}\n`); console.log(s); };

const inv = () => bot.inventory.items().map((i) => i.name + 'x' + i.count).join(', ');
const count = (nm) => bot.inventory.items().filter((i) => i.name === nm).reduce((n, i) => n + i.count, 0);

function scanFor(center, radius, yLo, yHi, pred) {
  const cx = Math.floor(center.x), cy = Math.floor(center.y), cz = Math.floor(center.z);
  let best = null, bestD = Infinity;
  for (let dx = -radius; dx <= radius; dx++)
    for (let dz = -radius; dz <= radius; dz++)
      for (let dy = yLo; dy <= yHi; dy++) {
        const v = new Vec3(cx + dx, cy + dy, cz + dz);
        let b; try { b = bot.blockAt(v); } catch { continue; }
        if (b && pred(b)) {
          const d = center.distanceTo(v);
          if (d < bestD) { bestD = d; best = v; }
        }
      }
  return best;
}

async function digToCollect(pos) {
  const target = pos instanceof Vec3 ? pos : new Vec3(pos.x, pos.y, pos.z);
  const center = target.offset(0.5, 0.5, 0.5);
  const before = bot.inventory.items().reduce((n, i) => n + i.count, 0);
  if (bot.entity.position.distanceTo(center) > 3.8) {
    bot.pathfinder.setMovements(new Movements(bot));
    bot.pathfinder.setGoal(new goals.GoalNear(target.x + 0.5, target.y, target.z + 0.5, 1));
    const t0 = Date.now();
    while (Date.now() - t0 < 20000) {
      if (bot.entity.position.distanceTo(center) <= 3.8) break;
      await sleep(200);
    }
    bot.pathfinder.setGoal(null);
    await sleep(250);
  }
  if (bot.entity.position.distanceTo(center) > 4.5) return 0;
  const blk = bot.blockAt(target);
  if (!blk || blk.name === 'air') return 0;
  try { await bot.dig(blk); } catch (e) { log('dig err ' + e.message); return 0; }
  const t1 = Date.now();
  while (Date.now() - t1 < 3000) {
    const after = bot.inventory.items().reduce((n, i) => n + i.count, 0);
    if (after > before) return after - before;
    await sleep(150);
  }
  return 0;
}

async function craftItem(name, count, needTable) {
  const mc = require('minecraft-data')(bot.version);
  const def = mc.itemsByName[name];
  if (!def) { log('UNKNOWN ITEM ' + name); return false; }
  let table = null;
  if (needTable) {
    const t = scanFor(bot.entity.position, 8, -2, 2, (b) => b.name === 'crafting_table');
    if (!t) { log('NO TABLE for ' + name); return false; }
    table = bot.blockAt(t);
  }
  let recipes = bot.recipesFor(def.id, null, null, !!needTable);
  if (!recipes || !recipes.length) recipes = bot.recipesFor(def.id);
  if (!recipes || !recipes.length) { log('NO RECIPE for ' + name); return false; }
  try { await bot.craft(recipes[0], count, table); log('crafted ' + name + ' x' + count); return true; }
  catch (e) { log('CRAFT ' + name + ' FAILED: ' + e.message); return false; }
}

async function placeTable() {
  const item = bot.inventory.items().find((i) => i.name === 'crafting_table');
  if (!item) { log('no table item'); return false; }
  const p = bot.entity.position;
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const ground = bot.blockAt(p.offset(dx, -1, dz));
    const cell = bot.blockAt(p.offset(dx, 0, dz));
    if (ground && cell && ground.name !== 'air' && cell.name === 'air') {
      try {
        await bot.equip(item, 'hand');
        await bot.lookAt(ground.position.offset(0.5, 1, 0.5), false);
        await bot.placeBlock(ground, new Vec3(0, 1, 0));
        log('placed crafting table');
        return true;
      } catch (e) { log('place table err ' + e.message); }
    }
  }
  return false;
}

bot.once('spawn', async () => {
  for (let i = 0; i < 20; i++) { await new Promise((r) => setTimeout(r, 500)); if (bot.blockAt(bot.entity.position)) break; }
  await sleep(2000);
  log('spawned at ' + bot.entity.position.x.toFixed(0) + ' ' + bot.entity.position.y.toFixed(0) + ' ' + bot.entity.position.z.toFixed(0));

  // walk toward the known forest area near the old castle
  log('heading toward forest area (-920, 71, 254)...');
  bot.pathfinder.setMovements(new Movements(bot));
  bot.pathfinder.setGoal(new goals.GoalNear(-920, 71, 254, 6));
  const g0 = Date.now();
  while (Date.now() - g0 < 25000) {
    if (bot.entity.position.distanceTo(new Vec3(-920, 71, 254)) < 12) break;
    await sleep(300);
  }
  bot.pathfinder.setGoal(null);
  await sleep(1000);
  log('now at ' + bot.entity.position.x.toFixed(0) + ' ' + bot.entity.position.y.toFixed(0) + ' ' + bot.entity.position.z.toFixed(0));

  // dig 4 oak logs: walk to a tree, then dig reachable local logs
  const failed = new Set();
  const key = (v) => v.x + ',' + v.y + ',' + v.z;
  for (let want = 4; count('oak_log') < want; ) {
    const p = bot.entity.position;
    let best = null, bestScore = Infinity;
    for (let dx = -28; dx <= 28; dx++)
      for (let dz = -28; dz <= 28; dz++)
        for (let dy = -10; dy <= 16; dy++) {
          const v = new Vec3(Math.floor(p.x) + dx, Math.floor(p.y) + dy, Math.floor(p.z) + dz);
          if (failed.has(key(v))) continue;
          let b; try { b = bot.blockAt(v); } catch { continue; }
          if (b && b.name === 'oak_log') {
            const reachPenalty = (dy > 6 || dy < -4) ? 60 : 0;
            const score = p.distanceTo(v) + Math.abs(dy) * 2 + reachPenalty;
            if (score < bestScore) { bestScore = score; best = v; }
          }
        }
    if (!best) { log('NO REACHABLE LOGS'); break; }
    // walk near the tree
    bot.pathfinder.setMovements(new Movements(bot));
    bot.pathfinder.setGoal(new goals.GoalNear(best.x, best.y, best.z, 2.5));
    const w0 = Date.now();
    while (Date.now() - w0 < 30000) {
      if (bot.entity.position.distanceTo(new Vec3(best.x + 0.5, best.y, best.z + 0.5)) <= 4.5) break;
      await sleep(200);
    }
    bot.pathfinder.setGoal(null);
    await sleep(250);
    log('near tree at ' + bot.entity.position.x.toFixed(0) + ',' + bot.entity.position.y.toFixed(0) + ',' + bot.entity.position.z.toFixed(0));
    // dig reachable local logs
    let dugAny = false;
    for (let pass = 0; pass < 4; pass++) {
      let local = null, localD = Infinity;
      for (let dx = -6; dx <= 6; dx++)
        for (let dz = -6; dz <= 6; dz++)
          for (let dy = -4; dy <= 6; dy++) {
            const v = bot.entity.position.offset(dx, dy, dz).floored();
            if (failed.has(key(v))) continue;
            let b; try { b = bot.blockAt(v); } catch { continue; }
            if (b && b.name === 'oak_log') {
              const d = bot.entity.position.distanceTo(v);
              if (d < localD) { localD = d; local = v; }
            }
          }
      if (!local) break;
      const got = await digToCollect(local);
      if (got > 0) { dugAny = true; log('got ' + got + ', oak_log now ' + count('oak_log')); }
      else { failed.add(key(local)); log('unreachable ' + local.x + ',' + local.y + ',' + local.z); }
      await sleep(150);
    }
    if (!dugAny) { log('no local logs to dig here'); await sleep(300); }
  }
  log('INVENTORY: ' + inv());
  if (count('oak_log') < 1) { log('ABORT: no logs'); process.exit(1); }

  // craft chain
  await craftItem('oak_planks', count('oak_log'));
  await craftItem('stick', 1);
  await craftItem('crafting_table', 1);
  log('after basic crafts: ' + inv());
  const tplaced = await placeTable();
  const pick = await craftItem('wooden_pickaxe', 1, true);
  log('TABLE PLACED=' + tplaced + ' PICKAXE=' + pick + ' | final inv: ' + inv());
  process.exit(0);
});
bot.on('error', (e) => { log('err ' + e.message); process.exit(1); });
