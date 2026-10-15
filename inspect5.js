const mineflayer = require('mineflayer');
const fs = require('fs');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MODIN = '/home/user/mc-aibridge/aibridge/in';
const bot = mineflayer.createBot({ host: 'localhost', port: 25565, username: 'OracleInspect5', auth: 'offline' });
const modOp = (obj) => { const f = `${MODIN}/op_${Date.now()}_${Math.floor(Math.random()*1000)}.json`; fs.writeFileSync(f, JSON.stringify(obj)); };
bot.once('spawn', async () => {
  await sleep(1500);
  const p = bot.entity.position;
  console.log('inspect bot at', p.x.toFixed(1), p.y.toFixed(1), p.z.toFixed(1));
  const items = Object.values(bot.entities).filter(e => e && e.position && (e.name === 'item' || e.name === 'item_stack'));
  console.log('total item entities:', items.length);
  const near = items.filter(e => e.position.distanceTo(p) < 30).sort((a,b) => a.position.distanceTo(p) - b.position.distanceTo(p));
  console.log('items within 30:', near.length);
  for (const it of near.slice(0, 15)) {
    console.log('  drop at', it.position.x.toFixed(1), it.position.y.toFixed(1), it.position.z.toFixed(1), 'dist', it.position.distanceTo(p).toFixed(1));
  }
  // where is the Oracle player?
  const players = Object.values(bot.players);
  for (const pl of players) {
    if (pl.username === 'TheOracle') {
      if (pl.entity) console.log('Oracle at', pl.entity.position.x.toFixed(1), pl.entity.position.y.toFixed(1), pl.entity.position.z.toFixed(1));
      else console.log('Oracle in tab list only (too far)');
    }
  }
  process.exit(0);
});
bot.on('error', (e) => { console.log('err', e.message); process.exit(1); });
setTimeout(() => process.exit(1), 15000);
