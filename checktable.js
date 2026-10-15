const mineflayer = require('mineflayer');
const { Vec3 } = require('vec3');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const bot = mineflayer.createBot({ host: 'localhost', port: 25565, username: 'OracleCheckTable', auth: 'offline' });
bot.once('spawn', async () => {
  await sleep(1200);
  console.log('pos', bot.entity.position.x.toFixed(0), bot.entity.position.y.toFixed(0), bot.entity.position.z.toFixed(0));
  // scan a wide area around the placement spot for any crafting tables
  const center = new Vec3(-924, 68, 337);
  let found = [];
  for (let dx = -6; dx <= 6; dx++) for (let dy = -3; dy <= 3; dy++) for (let dz = -6; dz <= 6; dz++) {
    const b = bot.blockAt(center.plus(new Vec3(dx, dy, dz)));
    if (b && b.name === 'crafting_table') found.push(`${b.position}`);
  }
  console.log('crafting tables near (-924,68,337):', found.length ? found.join(', ') : 'NONE');
  // also scan near the build site
  const c2 = new Vec3(-904, 69, 276);
  let found2 = [];
  for (let dx = -12; dx <= 12; dx++) for (let dy = -4; dy <= 4; dy++) for (let dz = -12; dz <= 12; dz++) {
    const b = bot.blockAt(c2.plus(new Vec3(dx, dy, dz)));
    if (b && b.name === 'crafting_table') found2.push(`${b.position}`);
  }
  console.log('crafting tables near build site (-904,69,276):', found2.length ? found2.join(', ') : 'NONE');
  process.exit(0);
});
bot.on('error', (e) => { console.log('err', e.message); process.exit(1); });
setTimeout(() => process.exit(1), 15000);
