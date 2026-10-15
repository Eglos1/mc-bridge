// oracle-e2e-test.js — connects a throwaway player, pokes TheOracle, watches server log for a reply
const mineflayer = require('mineflayer');
const { execSync } = require('child_process');

const HOST = 'localhost', PORT = 25565;
const SERVER_LOG = '/home/user/mc-aibridge/logs/latest.log';

function serverLogTail(n = 4) {
  try { return execSync(`tail -n ${n} ${SERVER_LOG}`).toString(); } catch { return ''; }
}

const bot = mineflayer.createBot({ host: HOST, port: PORT, username: 'OracleTest', auth: 'offline' });
console.log('connecting OracleTest...');
bot.once('spawn', () => {
  console.log('OracleTest spawned');
  setTimeout(() => {
    console.log('sending poke: "oracle hey, whats up?"');
    bot.chat('oracle hey, whats up?');
    setTimeout(() => {
      console.log('--- server log tail ---');
      console.log(serverLogTail(10));
      bot.end();
      process.exit(0);
    }, 45000);
  }, 3000);
});
bot.on('error', (e) => { console.log('test bot error', e.message); process.exit(1); });
bot.on('end', (r) => { console.log('test bot ended', r); });
setTimeout(() => { console.log('TEST TIMEOUT'); process.exit(2); }, 70000);
