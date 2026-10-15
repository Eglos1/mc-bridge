const mineflayer = require('mineflayer');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const bot = mineflayer.createBot({ host: 'localhost', port: 25565, username: 'OracleInspect3', auth: 'offline' });
bot.once('spawn', async () => {
  await sleep(1500);
  console.log('pos', bot.entity.position.x.toFixed(0), bot.entity.position.y.toFixed(0), bot.entity.position.z.toFixed(0));
  let seen = 0;
  for (const e of Object.values(bot.entities)) {
    if (e && e.name === 'item' && e.position) {
      const d = e.position.distanceTo(bot.entity.position);
      if (d < 30 && seen < 10) {
        seen++;
        const md = e.metadata && e.metadata[8];
        let label = '?';
        try { label = (md && (md.displayName || md.name)) || e.entityType?.displayName || e.name; } catch {}
        console.log('drop:', label, 'at', e.position.x.toFixed(1), e.position.y.toFixed(1), e.position.z.toFixed(1), 'dist', d.toFixed(1));
      }
    }
  }
  console.log('total items within 30:', Object.values(bot.entities).filter(e => e && e.name === 'item' && e.position && e.position.distanceTo(bot.entity.position) < 30).length);
  process.exit(0);
});
bot.on('error', (e) => { console.log('err', e.message); process.exit(1); });
setTimeout(() => process.exit(1), 15000);
