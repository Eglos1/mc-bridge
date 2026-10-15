const mineflayer = require('mineflayer');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const bot = mineflayer.createBot({ host: 'localhost', port: 25565, username: 'OracleStatus', auth: 'offline' });
bot.once('spawn', async () => {
  await sleep(1000);
  const items = bot.inventory.items().map(i => `${i.name}x${i.count}`);
  const held = bot.heldItem ? bot.heldItem.name : 'none';
  const target = bot.targetDigBlock;
  console.log('pos', bot.entity.position.x.toFixed(1), bot.entity.position.y.toFixed(1), bot.entity.position.z.toFixed(1));
  console.log('hp', bot.health.toFixed(1), 'food', bot.food);
  console.log('held:', held);
  console.log('inv:', items.join(', '));
  console.log('targetDig:', target ? `${target.name}@${target.position}` : 'none');
  process.exit(0);
});
bot.on('error', (e) => { console.log('err', e.message); process.exit(1); });
setTimeout(() => process.exit(1), 15000);
