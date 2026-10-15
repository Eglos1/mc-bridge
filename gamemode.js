const mineflayer = require('mineflayer');
const bot = mineflayer.createBot({ host: 'localhost', port: 25565, username: 'OracleMode', auth: 'offline' });
bot.once('spawn', () => {
  setTimeout(() => {
    console.log('game.gameMode =', bot.game.gameMode);
    console.log('isCreative =', bot.game.gameMode === 'creative');
    process.exit(0);
  }, 2500);
});
bot.on('error', (e) => { console.log('err', e.message); process.exit(1); });
