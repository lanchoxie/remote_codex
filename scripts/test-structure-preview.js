const assert = require('assert');
const viewer = require('../apps/mobile-web/public/structure-preview.js');

assert(viewer.isSupportedFile('sample.xsf'));
assert(viewer.isSupportedFile({ name: 'sample.PBD' }));
assert(viewer.isSupportedFile('/tmp/water.xyz'));
assert(viewer.isSupportedFile('cell.cif'));
assert(viewer.isSupportedFile('POSCAR'));
assert(viewer.isSupportedFile('relaxed.vasp'));
assert(viewer.isSupportedFile({ remoteName: 'relaxed.vasp', remotePath: '/tmp/relaxed.vasp' }));
assert(!viewer.isSupportedFile('notes.txt'));
assert.strictEqual(viewer.colorForElement('Qq'), '#b0b5be');
assert.strictEqual(viewer.colorForElement('O'), '#ff0d0d');

const xyz = viewer.parse('3\nwater\nO 0 0 0\nH 0.96 0 0\nH -0.24 0.93 0', 'water.xyz');
assert.strictEqual(xyz.format, 'xyz');
assert.strictEqual(xyz.atoms.length, 3);
assert(xyz.bonds.length >= 2, 'XYZ should infer nearby bonds');

const pdb = viewer.parse([
  'CRYST1   10.000  10.000  10.000  90.00  90.00  90.00 P 1           1',
  'ATOM      1  O   HOH A   1       0.000   0.000   0.000  1.00 20.00           O',
  'ATOM      2  H1  HOH A   1       0.960   0.000   0.000  1.00 20.00           H',
  'CONECT    1    2',
].join('\n'), 'water.pbd');
assert.strictEqual(pdb.format, 'pdb');
assert.strictEqual(pdb.atoms.length, 2);
assert.deepStrictEqual(pdb.bonds, [[0, 1]]);
assert.deepStrictEqual(pdb.cell[0], [10, 0, 0]);

const xsf = viewer.parse('CRYSTAL\nPRIMVEC\n2 0 0\n0 2 0\n0 0 2\nPRIMCOORD\n2 1\n8 0 0 0\n1 0.96 0 0', 'cell.xsf');
assert.strictEqual(xsf.atoms[0].element, 'O');
assert.deepStrictEqual(xsf.cell[1], [0, 2, 0]);

const cif = viewer.parse([
  'data_water',
  '_cell_length_a 10',
  '_cell_length_b 10',
  '_cell_length_c 10',
  '_cell_angle_alpha 90',
  '_cell_angle_beta 90',
  '_cell_angle_gamma 90',
  'loop_',
  '_atom_site_label',
  '_atom_site_type_symbol',
  '_atom_site_fract_x',
  '_atom_site_fract_y',
  '_atom_site_fract_z',
  'O1 O 0 0 0',
  'H1 H 0.096 0 0',
].join('\n'), 'water.cif');
assert.strictEqual(cif.atoms.length, 2);
assert(Math.abs(cif.atoms[1].x - 0.96) < 1e-8, 'CIF fractional coordinates should use the unit cell');
assert.strictEqual(cif.metadata.fractionalCoordinates, true);
const uncertainCif = viewer.parse([
  'data_uncertain',
  '_cell_length_a 10.123(4)',
  '_cell_length_b 10.000(1)',
  '_cell_length_c 10.000',
  'loop_',
  '_atom_site_label',
  '_atom_site_type_symbol',
  '_atom_site_fract_x',
  '_atom_site_fract_y',
  '_atom_site_fract_z',
  'C1 C 0 0 0',
].join('\n'), 'uncertain.cif');
assert(Math.abs(uncertainCif.cell[0][0] - 10.123) < 1e-8, 'CIF uncertainty suffix must not alter the value');

const vasp = viewer.parse([
  'Water POSCAR',
  '1.0',
  '3.0 0.0 0.0',
  '0.0 3.0 0.0',
  '0.0 0.0 3.0',
  'O H',
  '1 2',
  'Direct',
  '0 0 0',
  '0.319067 0 0',
  '-0.079996 0.309099 0',
].join('\n'), 'POSCAR');
assert.strictEqual(vasp.format, 'vasp');
assert.strictEqual(vasp.atoms.length, 3);
assert(Math.abs(vasp.atoms[1].x - 0.957201) < 1e-5, 'VASP direct coordinates should use the lattice vectors');
assert.deepStrictEqual(vasp.cell[0], [3, 0, 0]);
const volumeScaledVasp = viewer.parse([
  'Volume-scaled POSCAR',
  '-216',
  '3 0 0',
  '0 3 0',
  '0 0 3',
  'C',
  '1',
  'Cartesian',
  '1 0 0',
].join('\n'), 'POSCAR');
assert.deepStrictEqual(volumeScaledVasp.cell[0], [6, 0, 0]);
assert.strictEqual(volumeScaledVasp.atoms[0].x, 2, 'Negative POSCAR scale must represent target volume');

assert.throws(() => viewer.parse('0\nempty\n', 'empty.xyz'), /No atoms/);
console.log('structure preview parser checks passed');
