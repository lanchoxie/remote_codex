const assert = require('assert');
const geometry = require('../apps/mobile-web/public/crystal-geometry');

const cell = [[4, 0, 0], [1, 4, 0], [0, 0, 4]];
const point = geometry.cartesian([0.9, 0.2, 0.3], cell);
geometry.fractional(point, cell).forEach((value, index) => assert(Math.abs(value - [0.9, 0.2, 0.3][index]) < 1e-9));
const periodic = {
  format: 'cif', cell: [[2, 0, 0], [0, 2, 0], [0, 0, 2]],
  atoms: [
    { element: 'C', x: 0.4, y: 1, z: 1 },
    { element: 'C', x: 1.6, y: 1, z: 1 },
  ],
};
const model = geometry.build(periodic, { center: 'C', ligand: 'C', cutoff: 1 });
assert(model.bonds.some((bond) => bond.shift[0] !== 0 && bond.length < 0.81), 'cross-cell nearest neighbor must bond');
assert(model.renderAtoms.some((atom) => atom.imageOf === 1), 'cross-cell bond needs an adjacent image atom');
assert.strictEqual(model.bonds.filter((bond) => bond.shift.every((value) => value === 0)).length, 1,
  'the in-cell bond must not be duplicated alongside periodic bonds');
assert.deepStrictEqual(model.corners[7], [2, 2, 2]);
const inCell = geometry.build({ ...periodic, cell: [[4, 0, 0], [0, 4, 0], [0, 0, 4]] });
assert.strictEqual(inCell.bonds.filter((bond) => bond.shift.every((value) => value === 0)).length, 1,
  'an in-cell bond must be drawn once');
const shortCell = geometry.build({ format: 'cif', cell: [[1.2, 0, 0], [0, 10, 0], [0, 0, 10]], atoms: [
  { element: 'Ti', x: 0.12, y: 5, z: 5 }, { element: 'O', x: 0.12, y: 5, z: 5 },
] }, { center: 'Ti', ligand: 'O', cutoff: 2.5 });
assert(shortCell.renderAtoms.some((atom) => atom.imageOf === 1 && Math.abs(atom.x - 2.52) < 1e-9),
  'short cells need neighbors beyond one translation');
assert.throws(() => geometry.build({ format: 'cif', cell: [[0.05, 0, 0], [0, 0.05, 0], [0, 0, 0.05]],
  atoms: [{ element: 'C', x: 0, y: 0, z: 0 }] }), /too many periodic images/);
const skewAtoms = [[0.15, 0.5, 0.5], [0.85, 0.5, 0.5]].map((fraction, index) => {
  const [x, y, z] = geometry.cartesian(fraction, cell);
  return { element: 'C', index, x, y, z };
});
const skewModel = geometry.build({ format: 'cif', cell, atoms: skewAtoms });
assert(skewModel.bonds.some((bond) => bond.shift[0] !== 0 && bond.length < 1.21),
  'skew-cell fractional neighbors must connect across the a boundary');
const wrapped = geometry.build({ ...periodic, atoms: [{ element: 'O', x: -0.1, y: 0, z: 0 }] });
assert(Math.abs(wrapped.atoms[0].x - 1.9) < 1e-9, 'out-of-cell coordinates must wrap');

const octahedron = { format: 'vasp', cell: [[4, 0, 0], [0, 4, 0], [0, 0, 4]], atoms: [
  { element: 'Ti', x: 0.1, y: 2, z: 2 },
  { element: 'O', x: 1.9, y: 2, z: 2 }, { element: 'O', x: 2.3, y: 2, z: 2 },
  { element: 'O', x: 0.1, y: 3.8, z: 2 }, { element: 'O', x: 0.1, y: 0.2, z: 2 },
  { element: 'O', x: 0.1, y: 2, z: 3.8 }, { element: 'O', x: 0.1, y: 2, z: 0.2 },
] };
const poly = geometry.build(octahedron, { center: 'Ti', ligand: 'O', cutoff: 2.1 });
assert(poly.polyhedra.length >= 1, 'periodic octahedron should have a coordination shell');
assert(poly.polyhedra[0].vertices.length >= 6, 'periodic images should complete the octahedron');
assert.strictEqual(geometry.build(octahedron, { center: 'Ti', ligand: 'O', cutoff: 1.2 }).polyhedra.length, 0);
const planar = { ...octahedron, cell: [[10, 0, 0], [0, 10, 0], [0, 0, 10]], atoms: [
  { element: 'Ti', x: 5, y: 5, z: 5 },
  { element: 'O', x: 7, y: 5, z: 5 }, { element: 'O', x: 3, y: 5, z: 5 },
  { element: 'O', x: 5, y: 7, z: 5 }, { element: 'O', x: 5, y: 3, z: 5 },
] };
assert.strictEqual(geometry.build(planar, { center: 'Ti', ligand: 'O', cutoff: 2.5 }).polyhedra.length, 0,
  'coplanar ligands cannot form a closed polyhedron');
const highCoordination = { ...planar, atoms: [{ element: 'Ti', x: 5, y: 5, z: 5 }] };
for (const x of [-1, 1]) for (const y of [-1, 1]) for (const z of [-1, 1]) {
  highCoordination.atoms.push({ element: 'O', x: 5 + x, y: 5 + y, z: 5 + z });
}
for (let axis = 0; axis < 3; axis++) for (const sign of [-1, 1]) {
  const position = [5, 5, 5]; position[axis] += sign * 2;
  highCoordination.atoms.push({ element: 'O', x: position[0], y: position[1], z: position[2] });
}
assert.strictEqual(geometry.build(highCoordination, { center: 'Ti', ligand: 'O', cutoff: 2.5 }).polyhedra[0].vertices.length, 14,
  'all coordinating neighbors within the cutoff must be retained');
assert.strictEqual(geometry.isPeriodicStructure({ ...octahedron, format: 'pdb' }), false);
console.log('crystal geometry periodic bonds and coordination passed');
