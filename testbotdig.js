// Definitive bot-dig test: does mineflayer bot.dig() produce a drop?
const mineflayer = require('mineflayer');
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');
const { Vec3 } = require('vec3');

const bot = mineflayer.createBot({ host: 'localhost', port: 25565, username: 'OracleDiag', auth: 'offline' });
bot.loadPlugin(pathfinder);

let dropsSeen = [];
bot.on('itemDrop', (e) => {
  dropsSeen.push({ pos: [e.position.x, e.position.y, e.position.z], name: e.name });
  console.log('  [itemDrop]', e.name, 'at', e.position.x.toFixed(1), e.position.y.toFixed(1), e.position.z.toFixed(1));
});

async function readBlock(v, tries = 20) {
  for (let i = 0; i < tries; i++) {
    const b = bot.blockAt(v);
    if (b) return b;
    await new Promise((r) => setTimeout(r, 500));
  }
  return null;
}

bot.once('spawn', async () => {
  await new Promise((r) => setTimeout(r, 3000));
  console.log('spawned at', bot.entity.position.x.toFixed(0), bot.entity.position.y.toFixed(0), bot.entity.position.z.toFixed(0));

  // candidates: castle wall layer-2 stones, fresh (avoid prior break sites at y=70)
  const cands = [new Vec3(-912, 71, 264), new Vec3(-910, 71, 264), new Vec3(-922, 71, 266), new Vec3(-920, 71, 266), new Vec3(-914, 70, 270), new Vec3(-916, 70, 270)];
  let target = null;
  for (const v of cands) {
    const b = await readBlock(v);
    console.log('cand', v.x, v.y, v.z, '->', b ? b.name : 'null');
    if (b && b.name === 'stone') { target = v; break; }
  }
  if (!target) { console.log('NO STONE TARGET'); process.exit(1); }
  console.log('DIG TARGET:', target.x, target.y, target.z);

  // walk adjacent
  bot.pathfinder.setMovements(new Movements(bot));
  bot.pathfinder.setGoal(new goals.GoalNear(target.x, target.y, target.z, 1));
  for (let i = 0; i < 30; i++) { await new Promise((r) => setTimeout(r, 1000)); if (bot.entity.position.distanceTo(new Vec3(target.x, target.y, target.z)) < 2) break; }
  bot.pathfinder.setGoal(null);
  await new Promise((r) => setTimeout(r, 1000));

  // re-read block now that chunk is loaded; retry until stone or give up
  const blk = await readBlock(target, 10);
  console.log('block adjacent after arrive:', blk ? blk.name : 'null');
  if (!blk || blk.name !== 'stone') { console.log('ABORT: target not stone at dig time'); process.exit(1); }

  console.log('DIGGING', target.x, target.y, target.z, '(' + blk.name + ')');
  dropsSeen = [];
  try {
    await bot.dig(blk);
    console.log('  dig() resolved OK');
  } catch (e) {
    console.log('  dig() threw:', e.message);
  }
  await new Promise((r) => setTimeout(r, 2000));

  const after = bot.blockAt(target);
  console.log('after dig: block =', after ? after.name : 'null');
  console.log('inventory =', JSON.stringify(bot.inventory.items().map((i) => i.name + 'x' + i.count)));

  await new Promise((r) => setTimeout(r, 4000));
  const near = Object.values(bot.entities).filter((e) => e && e.position && e.position.distanceTo(target) < 8);
  const items = near.filter((e) => e.name && e.name.toLowerCase().includes('item'));
  console.log('entities near target:', near.map((e) => e.name).join(','));
  console.log('item entities near target:', items.map((e) => e.position.x.toFixed(1) + ',' + e.position.y.toFixed(1) + ',' + e.position.z.toFixed(1)).join(' | '));
  console.log('itemDrop events:', dropsSeen.length);
  process.exit(0);
});
bot.on('error', (e) => { console.log('err', e.message); process.exit(1); });
