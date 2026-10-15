// verifydig2: dig a stone block, then scan for item entities near the break
const mineflayer = require('mineflayer');
const HOST = 'localhost';
const PORT = 25565;

const A = mineflayer.createBot({ host: HOST, port: PORT, username: 'digA' });
A.on('error', (e) => console.log('[A err]', e.message));

A.once('spawn', () => {
  // find a stone block directly beneath feet (dig down 1)
  const pos = A.entity.position;
  const target = A.blockAt(A.entity.position.offset(0, -1, 0));
  console.log('A spawned at', pos.x.toFixed(1), pos.y.toFixed(1), pos.z.toFixed(1));
  console.log('target block under feet:', target && target.name);
  if (!target || !['stone', 'cobblestone', 'dirt', 'grass_block'].includes(target.name)) {
    console.log('no diggable target; abort');
    process.exit(1);
  }
  A.dig(target, true).then(() => {
    console.log('A dig resolved');
    setTimeout(() => {
      const now = A.blockAt(target.position);
      console.log('block after dig:', now && now.name);
      // scan for item entities near break
      let found = [];
      for (const id in A.entities) {
        const e = A.entities[id];
        const d = e.position.distanceTo(target.position.offset(0.5, 0.5, 0.5));
        if (d < 10) {
          const type = e.objectType || e.type || '?';
          const name = e.name || '';
          const md7 = e.metadata && e.metadata[7] ? JSON.stringify(e.metadata[7]) : '';
          found.push({ id, type, name, d: d.toFixed(1), pos: e.position.toArray().map(v => v.toFixed(1)), md7: md7.slice(0, 80) });
        }
      }
      console.log('entities near break:', found.length);
      for (const f of found) console.log('  ', JSON.stringify(f));
      // also check bot inventory
      console.log('A inventory:', A.inventory.items().map(i => i.name + 'x' + i.count).join(', ') || 'empty');
      process.exit(0);
    }, 2000);
  }).catch((e) => { console.log('dig err', e.message); process.exit(1); });
});
setTimeout(() => { console.log('TIMEOUT'); process.exit(1); }, 30000);
