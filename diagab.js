// CLEAN A/B test: bot.dig (mineflayer) vs mod break — which produces drops?
const mineflayer = require('mineflayer');
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');
const { Vec3 } = require('vec3');
const fs = require('fs');

const IN = '/home/user/mc-aibridge/aibridge/in';
const DONE = '/home/user/mc-aibridge/aibridge/done';

const bot = mineflayer.createBot({ host: 'localhost', port: 25565, username: 'OracleDiag', auth: 'offline' });
bot.loadPlugin(pathfinder);

bot.on('itemDrop', (e) => {
  console.log('  [itemDrop]', e.name, 'at', e.position.x.toFixed(1), e.position.y.toFixed(1), e.position.z.toFixed(1));
});

bot.once('spawn', async () => {
  for (let i = 0; i < 20; i++) { await new Promise((r) => setTimeout(r, 500)); if (bot.blockAt(bot.entity.position)) break; }
  await new Promise((r) => setTimeout(r, 2000));
  console.log('spawned at', bot.entity.position.x.toFixed(0), bot.entity.position.y.toFixed(0), bot.entity.position.z.toFixed(0));

  // two stone wall blocks: B = bot-dig target, A = mod-break target
  const B = new Vec3(-916, 70, 264); // bot digs this one
  const A = new Vec3(-912, 70, 264); // mod breaks this one
  for (const [lbl, v] of [['A(mod)', A], ['B(bot)', B]]) {
    const b = bot.blockAt(v);
    console.log('target', lbl, v.x, v.y, v.z, '->', b ? b.name : 'null');
  }

  // step 1: walk adjacent to B, dig it with mineflayer
  bot.pathfinder.setMovements(new Movements(bot));
  bot.pathfinder.setGoal(new goals.GoalNear(B.x, B.y, B.z, 1));
  for (let i = 0; i < 25; i++) { await new Promise((r) => setTimeout(r, 1000)); if (bot.entity.position.distanceTo(new Vec3(B.x, B.y, B.z)) < 2) break; }
  bot.pathfinder.setGoal(null);
  await new Promise((r) => setTimeout(r, 500));
  console.log('at B, block now:', bot.blockAt(B).name);

  const bBlock = bot.blockAt(B);
  console.log('BOT DIGGING block at', B.x, B.y, B.z, '(' + bBlock.name + ')');
  try {
    await bot.dig(bBlock);
    console.log('  dig returned OK');
  } catch (e) {
    console.log('  dig FAILED:', e.message);
  }
  await new Promise((r) => setTimeout(r, 1500));
  console.log('after dig: B block =', bot.blockAt(B).name, '| inventory =', JSON.stringify(bot.inventory.items().map((i) => i.name)));

  // step 2: move far away from both sites
  bot.pathfinder.setGoal(new goals.GoalNear(B.x + 9, B.y, B.z, 1));
  for (let i = 0; i < 25; i++) { await new Promise((r) => setTimeout(r, 1000)); if (bot.entity.position.distanceTo(new Vec3(B.x + 9, B.y, B.z)) < 3) break; }
  bot.pathfinder.setGoal(null);
  console.log('moved away to', bot.entity.position.x.toFixed(0), bot.entity.position.y.toFixed(0), bot.entity.position.z.toFixed(0));

  // step 3: mod breaks A
  const cmd = { op: 'break', block: 'minecraft:stone', x: A.x, y: A.y, z: A.z, dimension: 'minecraft:overworld' };
  const f = IN + '/diag-ab-' + Date.now() + '.json';
  fs.writeFileSync(f, JSON.stringify(cmd));
  console.log('wrote mod break command for A:', f);

  // step 4: watch both sites for 12s
  for (let i = 0; i < 12; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    const nearA = Object.values(bot.entities).filter((e) => e && e.position && e.position.distanceTo(A) < 6);
    const nearB = Object.values(bot.entities).filter((e) => e && e.position && e.position.distanceTo(B) < 6);
    const itemsA = nearA.filter((e) => e.name && e.name.toLowerCase().includes('item'));
    const itemsB = nearB.filter((e) => e.name && e.name.toLowerCase().includes('item'));
    console.log(`t+${i + 1}s A(mod,${bot.blockAt(A) ? bot.blockAt(A).name : 'null'}): items=${itemsA.length} | B(bot,${bot.blockAt(B) ? bot.blockAt(B).name : 'null'}): items=${itemsB.length}`);
  }
  await new Promise((r) => setTimeout(r, 1500));
  console.log('--- mod result ---');
  try {
    const files = fs.readdirSync(DONE).filter((x) => x.includes('diag-ab'));
    for (const fn of files) console.log(fn, ':', fs.readFileSync(DONE + '/' + fn, 'utf8').trim());
  } catch (e) { console.log('done read err', e.message); }
  process.exit(0);
});
bot.on('error', (e) => { console.log('err', e.message); process.exit(1); });
