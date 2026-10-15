// DEFINITIVE: does a bot's dig actually break the block SERVER-SIDE?
// Bot A digs a stone. Bot B (fresh connection) checks the block at that position.
const mineflayer = require('mineflayer');
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');
const { Vec3 } = require('vec3');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const A = mineflayer.createBot({ host: 'localhost', port: 25565, username: 'OracleDigA', auth: 'offline' });
A.loadPlugin(pathfinder);
let B = null;

function scanFor(center, radius, yLo, yHi, pred) {
  const cx = Math.floor(center.x), cy = Math.floor(center.y), cz = Math.floor(center.z);
  let best = null, bestD = Infinity;
  for (let dx = -radius; dx <= radius; dx++)
    for (let dz = -radius; dz <= radius; dz++)
      for (let dy = yLo; dy <= yHi; dy++) {
        const v = new Vec3(cx + dx, cy + dy, cz + dz);
        let b; try { b = botAt(A, v); } catch { continue; }
        if (b && pred(b)) {
          const d = center.distanceTo(v);
          if (d < bestD) { bestD = d; best = v; }
        }
      }
  return best;
}
function botAt(bot, v) { return bot.blockAt(v); }

A.once('spawn', async () => {
  for (let i = 0; i < 20; i++) { await new Promise((r) => setTimeout(r, 500)); if (A.blockAt(A.entity.position)) break; }
  await sleep(1500);
  console.log('A spawned at', A.entity.position.x.toFixed(0), A.entity.position.y.toFixed(0), A.entity.position.z.toFixed(0));

  // find a stone near A
  const sp = scanFor(A.entity.position, 10, -6, 0, (b) => b.name === 'stone' || b.name === 'cobblestone');
  if (!sp) { console.log('NO STONE FOR A'); process.exit(1); }
  console.log('A target:', sp.toString());

  // B connects now and checks the block BEFORE the dig
  B = mineflayer.createBot({ host: 'localhost', port: 25565, username: 'OracleCheckB', auth: 'offline' });
  B.once('spawn', async () => {
    for (let i = 0; i < 20; i++) { await new Promise((r) => setTimeout(r, 500)); if (B.blockAt(B.entity.position)) break; }
    await sleep(2000);
    const before = B.blockAt(sp);
    console.log('B sees block BEFORE dig:', before ? before.name : 'null');

    // A digs it now
    A.pathfinder.setMovements(new Movements(A));
    A.pathfinder.setGoal(new goals.GoalNear(sp.x + 0.5, sp.y, sp.z + 0.5, 1));
    const w0 = Date.now();
    while (Date.now() - w0 < 15000) {
      if (A.entity.position.distanceTo(sp.offset(0.5, 0.5, 0.5)) <= 4.5) break;
      await sleep(200);
    }
    A.pathfinder.setGoal(null);
    await sleep(300);
    console.log('A digging', sp.toString(), '...');
    try { await A.dig(A.blockAt(sp)); console.log('A dig resolved'); }
    catch (e) { console.log('A dig threw:', e.message); }
    await sleep(1500);

    const afterA = A.blockAt(sp);
    console.log('A sees block AFTER dig:', afterA ? afterA.name : 'null');

    // B checks again - the truth
    const afterB = B.blockAt(sp);
    console.log('B sees block AFTER dig:', afterB ? afterB.name : 'null');
    console.log('=== SERVER-SIDE BREAK:', afterB ? afterB.name === 'air' : 'null', '===');
    console.log('A inventory:', A.inventory.items().map((i) => i.name + 'x' + i.count).join(',') || 'empty');
    process.exit(0);
  });
});
A.on('error', (e) => { console.log('A err', e.message); process.exit(1); });
B && B.on('error', (e) => { console.log('B err', e.message); process.exit(1); });
