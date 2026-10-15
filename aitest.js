// In-game test harness: sends a scripted sequence of addressed messages to
// TheOracle and captures its chat replies.
const mineflayer = require('mineflayer');
const bot = mineflayer.createBot({ host: 'localhost', port: 25565, username: 'OracleTest', auth: 'offline' });

const SEND = [
  ['hello, what can you do?', 16000],
  ['what do you see around you?', 18000],
  ['attack any hostile mobs near you', 20000],
  ['go to -928 73 256', 8000],
  ['show me your inventory', 18000],
];

let step = 0;
const replies = [];

bot.on('chat', (username, message) => {
  if (username === 'TheOracle') {
    const line = `ORACLE: ${message}`;
    console.log(line);
    replies.push(message);
  }
});

bot.once('spawn', async () => {
  console.log('OracleTest spawned, starting sequence...');
  for (const [msg, wait] of SEND) {
    step++;
    console.log(`\n>>> [${step}/${SEND.length}] sending: "${msg}"`);
    bot.chat(`oracle ${msg}`);
    await new Promise((r) => setTimeout(r, wait));
  }
  console.log('\n=== DONE ===');
  console.log('Captured oracle replies:');
  replies.forEach((r, i) => console.log(`  ${i + 1}: ${r}`));
  bot.end();
  process.exit(0);
});

bot.on('error', (e) => { console.log('conn err', e.message); process.exit(1); });
setTimeout(() => { console.log('TIMEOUT'); process.exit(2); }, 150000);
