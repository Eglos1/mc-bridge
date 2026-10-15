const mineflayer = require('mineflayer');
const { execSync } = require('child_process');
const bot = mineflayer.createBot({ host: 'localhost', port: 25565, username: 'OracleTest', auth: 'offline' });
bot.once('spawn', () => {
  setTimeout(() => {
    bot.chat('oracle go kill a cow');
    console.log('sent kill-cow order');
    setTimeout(() => {
      console.log('--- bridge.log tail ---');
      console.log(execSync('tail -n 10 /home/user/mc-bridge/bridge.log').toString());
      bot.end(); process.exit(0);
    }, 110000);
  }, 3000);
});
bot.on('error', (e) => { console.log('err', e.message); process.exit(1); });
setTimeout(() => { console.log('TIMEOUT'); process.exit(2); }, 140000);
