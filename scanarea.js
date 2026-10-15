const mineflayer = require('mineflayer');
const { Vec3 } = require('vec3');
const bot = mineflayer.createBot({ host: 'localhost', port: 25565, username: 'OracleDiag', auth: 'offline' });

bot.once('spawn', async () => {
  for (let i = 0; i < 40; i++) { await new Promise((r) => setTimeout(r, 500)); if (bot.blockAt(bot.entity.position)) break; }
  await new Promise((r) => setTimeout(r, 3000));
  const p = bot.entity.position;
  console.log('spawned at', p.x.toFixed(0), p.y.toFixed(0), p.z.toFixed(0));

  for (let y = 68; y <= 74; y++) {
    let stone = 0, other = {};
    for (let dx = -40; dx <= 40; dx += 4) {
      for (let dz = -40; dz <= 40; dz += 4) {
        const b = bot.blockAt(new Vec3(p.x + dx, y, p.z + dz));
        if (!b) continue;
        if (b.name === 'stone') stone++;
        else other[b.name] = (other[b.name] || 0) + 1;
      }
    }
    console.log(`y=${y}: stone=${stone} others=${JSON.stringify(other)}`);
  }
  const castle = bot.blockAt(new Vec3(-922, 70, 264));
  console.log('castle origin block:', castle ? castle.name : 'null');
  const castle2 = bot.blockAt(new Vec3(-922, 71, 264));
  console.log('castle y71 block:', castle2 ? castle2.name : 'null');
  process.exit(0);
});
bot.on('error', (e) => { console.log('err', e.message); process.exit(1); });
