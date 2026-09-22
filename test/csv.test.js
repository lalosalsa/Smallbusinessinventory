'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { parseCsv, parseCsvObjects, toCsv, num } = require('../src/csv');

test('parses quoted fields, embedded commas and doubled quotes', () => {
  const rows = parseCsv('a,b\r\n"Milk, whole","He said ""hi"""\r\n');
  assert.deepEqual(rows, [['a', 'b'], ['Milk, whole', 'He said "hi"']]);
});

test('parses a field containing a newline', () => {
  const rows = parseCsv('name,note\n"Flour","50 lb\nbag"\n');
  assert.equal(rows[1][1], '50 lb\nbag');
});

test('strips a UTF-8 BOM from the first header', () => {
  const { rows } = parseCsvObjects('﻿product_name,qty\nMilk,4\n', { product_name: [] });
  assert.equal(rows[0].product_name, 'Milk');
});

test('maps header aliases and reports unknown columns', () => {
  const { rows, unknown } = parseCsvObjects(
    'Item Name,Vendor SKU,Case Size,Mystery\nMilk,SY-1,4,zzz\n',
    { product_name: ['item_name'], sku: ['vendor_sku'], pack_size: ['case_size'] },
  );
  assert.equal(rows[0].product_name, 'Milk');
  assert.equal(rows[0].sku, 'SY-1');
  assert.equal(rows[0].pack_size, '4');
  assert.deepEqual(unknown, ['mystery']);
});

test('writes CSV that quotes anything containing a comma or quote', () => {
  const out = toCsv([{ key: 'a', label: 'A' }, { key: 'b', label: 'B' }], [{ a: 'x,y', b: 'he "said"' }]);
  assert.equal(out, 'A,B\r\n"x,y","he ""said"""\r\n');
});

test('number parsing tolerates currency and thousands separators', () => {
  assert.equal(num('$1,234.50'), 1234.5);
  assert.equal(num(''), 0);
  assert.equal(num('not a number', 7), 7);
});
