// scan loaded chunks for nearest land block
const mineflayer = require('mineflayer');
const { Vec3 } = require('vec3');
const bot = mineflayer.createBot({ host: 'localhost', port: 25565, username: 'OracleTest', auth: 'offline' });
bot.once('spawn', () => {
  setTimeout(() => {
    const me = bot.entity.position;
    let best = null;
    let scanned = 0;
    const R = 64;
    for (let x = Math.floor(me.x) - R; x <= Math.floor(me.x) + R; x++)
      for (let z = Math.floor(me.z) - R; z <= Math.floor(me.z) + R; z++) {
        const col = bot.world.getColumn(x, z);
        if (!col || !col.blocks) continue;
        scanned++;
        for (let y = Math.floor(me.y) - 12; y <= Math.floor(me.y) + 12; y++) {
          const b = bot.blockAt(new Vec3(x, y, z));
          if (b && b.name !== 'air' && b.name !== 'water' && b.name !== 'lava' && !b.liquid) {
            const d = Math.sqrt((x-me.x)**2 + (y-me.y)**2 + (z-me.z)**2);
            if (!best || d < best.d) best = { x, y: y+1, z, d: Math.round(d) };
            break;
          }
        }
      }
    console.log('me', Math.round(me.x), Math.round(me.y), Math.round(me.z), 'columns_scanned', scanned);
    console.log('nearest_land', JSON.stringify(best));
    bot.end(); process.exit(0);
  }, 4000);
});
bot.on('error', (e) => { console.log('err', e.message); process.exit(1); });
setTimeout(() => { console.log('TIMEOUT'); process.exit(2); }, 30000);
