// verifydig3: dig a stone, confirm server-side break, AND scan for ITEM ENTITIES (drops)
const mineflayer = require('mineflayer');
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');
const { Vec3 } = require('vec3');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const A = mineflayer.createBot({ host: 'localhost', port: 25565, username: 'OracleDigA', auth: 'offline' });
A.loadPlugin(pathfinder);
let B = null;

function botAt(bot, v) { return bot.blockAt(v); }
function scanFor(bot, center, radius, yLo, yHi, pred) {
  const cx = Math.floor(center.x), cy = Math.floor(center.y), cz = Math.floor(center.z);
  let best = null, bestD = Infinity;
  for (let dx = -radius; dx <= radius; dx++)
    for (let dz = -radius; dz <= radius; dz++)
      for (let dy = yLo; dy <= yHi; dy++) {
        const v = new Vec3(cx + dx, cy + dy, cz + dz);
        let b; try { b = botAt(bot, v); } catch { continue; }
        if (b && pred(b)) {
          const d = center.distanceTo(v);
          if (d < bestD) { bestD = d; best = v; }
        }
      }
  return best;
}
function itemEntities(bot, nearPos, radius) {
  const out = [];
  for (const id in bot.entities) {
    const e = bot.entities[id];
    const d = e.position.distanceTo(nearPos);
    if (d <= radius) {
      const isItem = e.objectType === 'Item' || (e.entityType && e.entityType.displayName === 'Item') || e.name === 'Item';
      out.push({ id, isItem, type: e.objectType || '?', name: e.name || '', d: +d.toFixed(1), pos: e.position.toArray().map(v => +v.toFixed(1)) });
    }
  }
  return out;
}

A.once('spawn', async () => {
  for (let i = 0; i < 20; i++) { await sleep(500); if (A.blockAt(A.entity.position)) break; }
  await sleep(1500);
  console.log('A spawned at', A.entity.position.x.toFixed(0), A.entity.position.y.toFixed(0), A.entity.position.z.toFixed(0));
  const sp = scanFor(A, A.entity.position, 10, -6, 0, (b) => b.name === 'stone' || b.name === 'cobblestone');
  if (!sp) { console.log('NO STONE FOR A'); process.exit(1); }
  console.log('A target:', sp.toString(), '(block:', A.blockAt(sp).name + ')');

  B = mineflayer.createBot({ host: 'localhost', port: 25565, username: 'OracleCheckB', auth: 'offline' });
  B.once('spawn', async () => {
    for (let i = 0; i < 20; i++) { await sleep(500); if (B.blockAt(B.entity.position)) break; }
    await sleep(2000);
    const before = B.blockAt(sp);
    console.log('B sees block BEFORE dig:', before ? before.name : 'null');

    A.pathfinder.setMovements(new Movements(A));
    A.pathfinder.setGoal(new goals.GoalNear(sp.x + 0.5, sp.y, sp.z + 0.5, 1));
    const w0 = Date.now();
    while (Date.now() - w0 < 15000) {
      if (A.entity.position.distanceTo(sp.offset(0.5, 0.5, 0.5)) <= 4.5) break;
      await sleep(200);
    }
    A.pathfinder.setGoal(null);
    await sleep(300);
    try { await A.dig(A.blockAt(sp)); console.log('A dig resolved'); }
    catch (e) { console.log('A dig threw:', e.message); }
    await sleep(3000); // let any drop fall and settle

    const afterB = B.blockAt(sp);
    console.log('B sees block AFTER dig:', afterB ? afterB.name : 'null');
    console.log('=== SERVER-SIDE BREAK:', afterB ? afterB.name === 'air' : 'null', '===');

    // item entity scan near break from both clients
    const center = sp.offset(0.5, 0.5, 0.5);
    const itemsA = itemEntities(A, center, 12);
    const itemsB = itemEntities(B, center, 12);
    console.log('ITEM ENTITIES within 12 of break: A sees', itemsA.length, '/ B sees', itemsB.length);
    for (const e of itemsA) console.log('  A:', JSON.stringify(e));
    for (const e of itemsB) console.log('  B:', JSON.stringify(e));

    console.log('A inventory:', A.inventory.items().map((i) => i.name + 'x' + i.count).join(',') || 'empty');
    console.log('B inventory:', B.inventory.items().map((i) => i.name + 'x' + i.count).join(',') || 'empty');
    process.exit(0);
  });
});
A.on('error', (e) => { console.log('A err', e.message); process.exit(1); });
setTimeout(() => { console.log('TIMEOUT'); process.exit(1); }, 40000);
