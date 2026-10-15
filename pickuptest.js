const mineflayer = require('mineflayer');
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');
const fs = require('fs');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MODIN = '/home/user/mc-aibridge/aibridge/in';
const bot = mineflayer.createBot({ host: 'localhost', port: 25565, username: 'OraclePickup', auth: 'offline' });
bot.loadPlugin(pathfinder);
const modOp = (obj) => { const f = `${MODIN}/op_${Date.now()}_${Math.floor(Math.random()*1000)}.json`; fs.writeFileSync(f, JSON.stringify(obj)); };
const invTotal = () => bot.inventory.items().reduce((n, i) => n + i.count, 0);
bot.once('spawn', async () => {
  await sleep(1200);
  console.log('pos', bot.entity.position.x.toFixed(1), bot.entity.position.y.toFixed(1), bot.entity.position.z.toFixed(1));
  // teleport to the area where items were seen
  modOp({ op: 'teleport', player: 'OraclePickup', x: -916, y: 74, z: 310 });
  await sleep(2500);
  const before = invTotal();
  console.log('after teleport pos', bot.entity.position.x.toFixed(1), bot.entity.position.y.toFixed(1), bot.entity.position.z.toFixed(1), 'inv:', before);
  bot.pathfinder.setMovements(new Movements(bot));
  // walk a square around the drops
  for (const target of [[-919,74,-309],[0,0,0],[0,0,0]]) {}
  const pts = [[-917,74,309],[-921,75,310],[-923,75,312],[-919,74,312],[-917,74,311],[-916,74,310],[-915,74,309],[-914,74,308]];
  for (const [x,y,z] of pts) {
    bot.pathfinder.setGoal(new goals.GoalBlock(x, y, z, 1));
    await sleep(1800);
  }
  bot.pathfinder.setGoal(null);
  const after = invTotal();
  console.log('after stomping: inv delta =', after - before, '(was', before, 'now', after + ')');
  const items = Object.values(bot.entities).filter(e => e && e.position && (e.name === 'item' || e.name === 'item_stack'));
  console.log('item entities still visible:', items.length);
  process.exit(0);
});
bot.on('error', (e) => { console.log('err', e.message); process.exit(1); });
setTimeout(() => process.exit(1), 25000);
