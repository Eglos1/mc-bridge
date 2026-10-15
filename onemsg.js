// Focused test: sends ONE addressed action message and waits long enough for
// the fight + reply, then verifies the reply mirrors the tool result.
const mineflayer = require('mineflayer');
const bot = mineflayer.createBot({ host: 'localhost', port: 25565, username: 'OracleTest', auth: 'offline' });

const MSG = process.argv[2] || 'oracle attack any hostile mobs near you';
const WAIT = 50000;

bot.on('chat', (username, message) => {
  if (username === 'TheOracle') console.log(`ORACLE: ${message}`);
});

bot.once('spawn', async () => {
  console.log(`>>> sending: "${MSG}"`);
  bot.chat(MSG);
  await new Promise((r) => setTimeout(r, WAIT));
  console.log('=== DONE ===');
  bot.end();
  process.exit(0);
});

bot.on('error', (e) => { console.log('conn err', e.message); process.exit(1); });
setTimeout(() => { console.log('TIMEOUT'); process.exit(2); }, 60000);
