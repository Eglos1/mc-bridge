// verifydig4: clean dig test - dump item entity metadata to identify the drop
const mineflayer = require('mineflayer');
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');
const { Vec3 } = require('vec3');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const A = mineflayer.createBot({ host: 'localhost', port: 25565, username: 'DigCleanA', auth: 'offline' });
A.loadPlugin(pathfinder);

function scanFor(bot, center, radius, yLo, yHi, pred) {
  const cx = Math.floor(center.x), cy = Math.floor(center.y), cz = Math.floor(center.z);
  let best = null, bestD = Infinity;
  for (let dx = -radius; dx <= radius; dx++)
    for (let dz = -radius; dz <= radius; dz++)
      for (let dy = yLo; dy <= yHi; dy++) {
        const v = new Vec3(cx + dx, cy + dy, cz + dz);
        let b; try { b = bot.blockAt(v); } catch { continue; }
        if (b && pred(b)) { const d = center.distanceTo(v); if (d < bestD) { bestD = d; best = v; } }
      }
  return best;
}

A.once('spawn', async () => {
  for (let i = 0; i < 20; i++) { await sleep(500); if (A.blockAt(A.entity.position)) break; }
  await sleep(1500);
  console.log('A at', A.entity.position.x.toFixed(0), A.entity.position.y.toFixed(0), A.entity.position.z.toFixed(0));
  // find a stone whose block BELOW is solid (so drop lands predictably)
  const sp = scanFor(A, A.entity.position, 10, -6, 0, (b) => {
    if (!(b.name === 'stone' || b.name === 'cobblestone')) return false;
    const below = A.blockAt(b.position.offset(0, -1, 0));
    return below && below.name !== 'air' && below.name !== 'water';
  });
  if (!sp) { console.log('NO STONE'); process.exit(1); }
  console.log('target:', sp.toString(), A.blockAt(sp).name, '| below:', A.blockAt(sp.offset(0,-1,0)).name);

  // walk close
  A.pathfinder.setMovements(new Movements(A));
  A.pathfinder.setGoal(new goals.GoalNear(sp.x + 0.5, sp.y, sp.z + 0.5, 1));
  const w0 = Date.now();
  while (Date.now() - w0 < 15000) { if (A.entity.position.distanceTo(sp.offset(0.5,0.5,0.5)) <= 4.5) break; await sleep(200); }
  A.pathfinder.setGoal(null);
  await sleep(300);
  console.log('digging...');
  try { await A.dig(A.blockAt(sp)); console.log('dig resolved'); } catch (e) { console.log('dig threw', e.message); }

  // scan immediately + dump metadata
  const center = sp.offset(0.5, 0.5, 0.5);
  for (let pass = 1; pass <= 3; pass++) {
    await sleep(800);
    console.log('--- pass', pass, '---');
    for (const id in A.entities) {
      const e = A.entities[id];
      const d = e.position.distanceTo(center);
      const isItem = e.objectType === 'Item' || (e.entityType && e.entityType.displayName === 'Item') || e.name === 'Item';
      if (d <= 6) {
        let md = {};
        try { md = Object.fromEntries(Object.entries(e.metadata || {}).map(([k, v]) => [k, (v && v.displayName) ? v.displayName : (typeof v === 'object' ? JSON.stringify(v).slice(0, 120) : v)])); } catch {}
        console.log('  entity', e.name || e.displayName, '| isItem:', isItem, '| d:', d.toFixed(1), '| pos:', e.position.toArray().map(v => +v.toFixed(1)), '| md:', JSON.stringify(md).slice(0, 300));
      }
    }
  }
  console.log('A inventory:', A.inventory.items().map(i => i.name + 'x' + i.count).join(',') || 'empty');
  process.exit(0);
});
A.on('error', (e) => { console.log('A err', e.message); process.exit(1); });
setTimeout(() => { console.log('TIMEOUT'); process.exit(1); }, 40000);
