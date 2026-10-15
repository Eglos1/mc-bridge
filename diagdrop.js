// Key diagnostic: does a SERVER-SIDE block break (via the mod's "break" op) produce drops?
const mineflayer = require('mineflayer');
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');
const { Vec3 } = require('vec3');
const fs = require('fs');

const IN = '/home/user/mc-aibridge/aibridge/in';
const DONE = '/home/user/mc-aibridge/aibridge/done';

const bot = mineflayer.createBot({ host: 'localhost', port: 25565, username: 'OracleDiag', auth: 'offline' });
bot.loadPlugin(pathfinder);

bot.on('itemDrop', (e) => {
  console.log('ITEM DROP EVENT at', e.position.x.toFixed(1), e.position.y.toFixed(1), e.position.z.toFixed(1), 'name=' + e.name);
});

bot.once('spawn', async () => {
  for (let i = 0; i < 20; i++) { await new Promise((r) => setTimeout(r, 500)); if (bot.blockAt(bot.entity.position)) break; }
  await new Promise((r) => setTimeout(r, 2000));
  console.log('spawned at', bot.entity.position.x.toFixed(0), bot.entity.position.y.toFixed(0), bot.entity.position.z.toFixed(0));

  // pick a castle wall stone to break (scan grid to confirm)
  let pos = null;
  for (const cand of [new Vec3(-920, 70, 264), new Vec3(-918, 70, 264), new Vec3(-916, 70, 264), new Vec3(-922, 70, 266), new Vec3(-910, 70, 266)]) {
    const b = bot.blockAt(cand);
    console.log('cand', cand.x, cand.y, cand.z, '->', b ? b.name : 'null');
    if (b && b.name === 'stone') { pos = cand; break; }
  }
  if (!pos) { console.log('NO WALL STONE FOUND'); process.exit(1); }

  // walk 7 blocks away so bot is NOT in pickup range
  bot.pathfinder.setMovements(new Movements(bot));
  bot.pathfinder.setGoal(new goals.GoalNear(pos.x + 7, pos.y, pos.z, 2));
  for (let i = 0; i < 20; i++) { await new Promise((r) => setTimeout(r, 1000)); if (bot.entity.position.distanceTo(new Vec3(pos.x + 7, pos.y, pos.z)) < 3) break; }
  bot.pathfinder.setGoal(null);
  console.log('bot moved away to', bot.entity.position.x.toFixed(0), bot.entity.position.y.toFixed(0), bot.entity.position.z.toFixed(0));

  // have the MOD break it server-side
  const cmd = { op: 'break', block: 'minecraft:stone', x: pos.x, y: pos.y, z: pos.z, dimension: 'minecraft:overworld' };
  const f = IN + '/diag-break-' + Date.now() + '.json';
  fs.writeFileSync(f, JSON.stringify(cmd));
  console.log('wrote mod break command:', f);

  // watch for drops for 12s
  let sawDrop = false;
  for (let i = 0; i < 12; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    const near = Object.values(bot.entities).filter((e) => e && e.position && e.position.distanceTo(pos) < 10);
    const items = near.filter((e) => e.name && e.name.toLowerCase().includes('item'));
    if (items.length) sawDrop = true;
    const block = bot.blockAt(pos);
    console.log(`t+${i + 1}s block=${block ? block.name : 'null'} itemsNear=${items.length} entities=[${near.map((e) => e.name).join(',')}]`);
  }
  await new Promise((r) => setTimeout(r, 2000));
  console.log('--- mod result ---');
  try {
    const files = fs.readdirSync(DONE).filter((x) => x.includes('diag-break'));
    for (const fn of files) console.log(fn, ':', fs.readFileSync(DONE + '/' + fn, 'utf8').trim());
  } catch (e) { console.log('done read err', e.message); }
  console.log('DROPS OBSERVED:', sawDrop);
  process.exit(0);
});
bot.on('error', (e) => { console.log('err', e.message); process.exit(1); });
