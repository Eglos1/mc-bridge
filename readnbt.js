const nbt = require('prismarine-nbt');
const fs = require('fs');
const data = fs.readFileSync('/home/user/mc-aibridge/world/level.dat');
nbt.parse(data).then((res) => {
  const Data = res.parsed.value.Data.value;
  console.log('GameRules present:', Object.keys(Data).includes('GameRules'));
  if (Data.GameRules) {
    const gr = Data.GameRules.value;
    console.log('GameRules contents:');
    for (const k of Object.keys(gr)) console.log('  ', k, '=', gr[k].value);
  }
  console.log('GameType:', Data.GameType.value, '(0=survival,1=creative)');
  process.exit(0);
}).catch((e) => { console.log('nbt err', e.message); process.exit(1); });
