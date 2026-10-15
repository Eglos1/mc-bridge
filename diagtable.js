const mineflayer = require('mineflayer');
const { Vec3 } = require('vec3');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const bot = mineflayer.createBot({ host: 'localhost', port: 25565, username: 'OracleDiagT', auth: 'offline' });
bot.once('spawn', async () => {
  for (let i = 0; i < 20; i++) { await sleep(500); if (bot.blockAt(bot.entity.position)) break; }
  await sleep(1500);
  const targets = [[-917,70,315], [-904,69,276], [-903,70,292], [-912,72,308]];
  for (const [x,y,z] of targets) {
    let b; try { b = bot.blockAt(new Vec3(x,y,z)); } catch { b = null; }
    console.log(`(${x},${y},${z}) ->`, b ? b.name : 'null');
  }
  // check for crafting tables within 20 of (-917,70,315)
  const cx=-917, cy=70, cz=315;
  let tables = [];
  for (let dx=-10; dx<=10; dx++) for (let dz=-10; dz<=10; dz++) for (let dy=-2; dy<=2; dy++) {
    let b; try { b = bot.blockAt(new Vec3(cx+dx, cy+dy, cz+dz)); } catch { continue; }
    if (b && b.name === 'crafting_table') tables.push(`${cx+dx},${cy+dy},${cz+dz}`);
  }
  console.log('crafting tables near (-917,70,315):', tables.length, tables.slice(0,8));
  process.exit(0);
});
bot.on('error', (e) => { console.log('err', e.message); process.exit(1); });
setTimeout(() => { console.log('TIMEOUT'); process.exit(1); }, 25000);
