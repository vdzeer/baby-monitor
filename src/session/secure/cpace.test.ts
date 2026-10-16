/// <reference types="node" />
// Test vectors from draft-irtf-cfrg-cpace-21, appendix A and B.3 (CPace with ristretto255 and SHA-512).
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { fromHex, lvCat, prependLen, toHex, utf8 } from './bytes.ts';
import {
  calculateGenerator,
  generatorString,
  intermediateKey,
  scalarFromBytes,
  scalarMult,
  scalarMultVfy,
} from './cpace.ts';

const PRS = utf8('Password');
const CI = fromHex('0b415f696e69746961746f720b425f726573706f6e646572');
const SID = fromHex('7e4b4791d6a8ef019b936c79fb7f2c57');
const YA_SCALAR = scalarFromBytes(fromHex('da3d23700a9e5699258aef94dc060dfda5ebb61f02a5ea77fad53f4ff0976d08'));
const YB_SCALAR = scalarFromBytes(fromHex('d2316b454718c35362d83d69df6320f38578ed5984651435e2949762d900b80d'));
const YA = 'd6bac480f2c386c394efc7c47adb9925dcd2630b64f240c50f8d0eec482b9157';
const YB = '3ea7e0b19560d7c0b0f5734f63b955286dfa8232b5ebe63324e2d9e7433f7258';
const K = '80b69a8a76457ab6a4d7f887a4bf6b55a2f80ac19c333f917a05fc9887c8b40f';

test('prepend_len and lv_cat match the draft', () => {
  assert.equal(toHex(prependLen(new Uint8Array(0))), '00');
  assert.equal(toHex(prependLen(utf8('1234'))), '0431323334');
  assert.equal(toHex(prependLen(Uint8Array.from({ length: 127 }, (_, i) => i))).slice(0, 4), '7f00');
  assert.equal(toHex(prependLen(Uint8Array.from({ length: 128 }, (_, i) => i))).slice(0, 6), '800100');
  assert.equal(toHex(lvCat(utf8('1234'), utf8('5'), utf8(''), utf8('678'))), '043132333401350003363738');
});

test('generator string and generator match the draft', () => {
  const generator = generatorString(PRS, CI, SID);
  assert.equal(generator.length, 170);
  assert.equal(
    toHex(generator),
    '11435061636552697374726574746f3235350850617373776f726464' +
      '00'.repeat(100) +
      '180b415f696e69746961746f720b425f726573706f6e646572107e4b4791d6a8ef019b936c79fb7f2c57',
  );
  assert.equal(
    toHex(calculateGenerator(PRS, CI, SID).toBytes()),
    '222b6b195fe84b1652badb6f6a3ae3d24341e7306967f0b8115b40d5698c7e56',
  );
});

test('shares, K and ISK match the draft', () => {
  const g = calculateGenerator(PRS, CI, SID);
  const ya = scalarMult(YA_SCALAR, g);
  const yb = scalarMult(YB_SCALAR, g);
  assert.equal(toHex(ya), YA);
  assert.equal(toHex(yb), YB);
  const ka = scalarMultVfy(YA_SCALAR, yb);
  const kb = scalarMultVfy(YB_SCALAR, ya);
  assert.ok(ka && kb);
  assert.equal(toHex(ka), K);
  assert.equal(toHex(kb), K);
  assert.equal(
    toHex(intermediateKey(SID, ka, ya, utf8('ADa'), yb, utf8('ADb'))),
    'b69effbf61b51d56401c0f65601abe428de8206feaaf0e32198896dcae7b35cd' +
      '2b38950a39dfd5d4a79164614c2984f7daa460b588c1e80c3fa2068af7900447',
  );
});

test('scalar_mult_vfy: valid point, invalid encoding and the neutral element', () => {
  const s = scalarFromBytes(fromHex('7cd0e075fa7955ba52c02759a6c90dbbfc10e6d40aea8d283e407d88cf538a05'));
  const valid = fromHex('2c3c6b8c4f3800e7aef6864025b4ed79bd599117e427c41bd47d93d654b4a51c');
  const result = scalarMultVfy(s, valid);
  assert.ok(result);
  assert.equal(toHex(result), '7c13645fe790a468f62c39beb7388e541d8405d1ade69d1778c5fe3e7f6b600e');
  assert.equal(scalarMultVfy(s, fromHex('2b3c6b8c4f3800e7aef6864025b4ed79bd599117e427c41bd47d93d654b4a51c')), null);
  assert.equal(scalarMultVfy(s, new Uint8Array(32)), null);
  assert.equal(scalarMultVfy(s, new Uint8Array(31)), null);
  assert.equal(scalarMultVfy(s, new Uint8Array(32).fill(0xff)), null);
});
