const mineflayer = require('mineflayer');
const bot = mineflayer.createBot({ host: 'localhost', port: 25565, username: 'OracleTrigger', auth: 'offline' });
bot.on('chat', (u, m) => { if (u === 'TheOracle') console.log('ORACLE:', m); });
bot.once('spawn', () => {
  setTimeout(() => { bot.chat('build a castle'); console.log('>>> sent build a castle'); }, 2000);
  setTimeout(() => { console.log('=== TRIGGERED ==='); bot.end(); process.exit(0); }, 8000);
});
bot.on('error', (e) => { console.log('err', e.message); process.exit(1); });
