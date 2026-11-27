const test = require('node:test');
const assert = require('node:assert/strict');
const api = import('../src/board.js');

function legacyBank(id, bindings) {
  return { id, name:`Bank ${id}`, pads:bindings.map((binding,i)=>({ binding, name:`Sound ${i}`, demo:null, audio:`${id}-audio-${i}`, icon:i%2?'Heart':'Music', iconChosen:true })) };
}

test('9→16 migration preserves every existing pad and avoids custom binding collisions', async () => {
  const { migrateBoard, PAD_COUNT } = await api;
  const before={ current:0, banks:[legacyBank('first',['q','w','e','r','f','v','1','2','3'])] };
  const source=structuredClone(before);
  const migration=migrateBoard(before,()=>.25);
  assert.equal(migration.changed,true);
  assert.deepEqual(before,source);
  assert.equal(migration.next.banks[0].pads.length,PAD_COUNT);
  assert.deepEqual(migration.next.banks[0].pads.slice(0,9),source.banks[0].pads);
  const pads=migration.next.banks[0].pads;
  assert.equal(new Set(pads.map(p=>p.binding.toLowerCase())).size,PAD_COUNT);
  for(const p of pads.slice(9)){
    assert.equal(p.audio,null);assert.equal(p.demo,null);assert.equal(p.name,'');
    assert.equal(p.iconChosen,false);assert.ok(p.icon);
  }
});

test('all banks expand once with stable icons and case-insensitive binding reservations', async () => {
  const { migrateBoard } = await api;
  const before={ current:1, banks:[legacyBank('a',['Q','W','E','R','A','S','D','F','Y']),legacyBank('b',['1','2','3','4','5','6','7','8','9'])] };
  const once=migrateBoard(before,()=>.4);
  assert.equal(once.next.current,1);
  for(let bankIndex=0;bankIndex<before.banks.length;bankIndex++){
    const bank=once.next.banks[bankIndex];
    assert.equal(bank.pads.length,16);
    assert.deepEqual(bank.pads.slice(0,9),before.banks[bankIndex].pads);
    assert.equal(new Set(bank.pads.map(p=>p.binding.toLowerCase())).size,16);
  }
  const twice=migrateBoard(once.next,()=>.99);
  assert.equal(twice.changed,false);
  assert.deepEqual(twice.next,once.next);
});

test('new bank uses the four-row key layout and empty extra pads', async () => {
  const { makeBank, DEFAULT_BINDINGS } = await api;
  const bank=makeBank('Neu',true);
  assert.deepEqual(bank.pads.map(p=>p.binding),['q','w','e','r','a','s','d','f','y','x','c','v','1','2','3','4']);
  assert.equal(DEFAULT_BINDINGS.length,16);
  assert.deepEqual(bank.pads.slice(0,3).map(p=>p.demo),[0,1,2]);
  assert.ok(bank.pads.slice(3).every(p=>p.audio===null&&p.demo===null&&p.name===''));
});
