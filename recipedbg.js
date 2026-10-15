// Debug v2: poll for recipes over time
const mineflayer = require('mineflayer');
const { pathfinder } = require('mineflayer-pathfinder');
const bot = mineflayer.createBot({ host: 'localhost', port: 25565, username: 'OracleDbg', auth: 'offline' });
bot.loadPlugin(pathfinder);

const mc = require('minecraft-data')('1.21.11');

bot.once('spawn', async () => {
  for (let t = 0; t < 45; t++) {
    await new Promise((r) => setTimeout(r, 2000));
    const pick = mc.itemsByName['wooden_pickaxe'];
    const nPick = (bot.recipesFor(pick.id) || []).length;
    if (t % 5 === 0 || nPick > 0) {
      console.log(`t=${(t + 1) * 2}s recipesFor(wooden_pickaxe)=${nPick} bot.recipes=${bot.recipes ? bot.recipes.length : 'undefined'} inv=${bot.inventory.items().map((i) => i.name).join(',') || 'empty'}`);
    }
  }
  process.exit(0);
});
bot.on('error', (e) => { console.log('err', e.message); process.exit(1); });
