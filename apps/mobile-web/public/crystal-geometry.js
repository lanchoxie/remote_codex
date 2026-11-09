(function attachCrystalGeometry(global) {
  'use strict';

  var RADII = { H: 0.31, B: 0.84, C: 0.76, N: 0.71, O: 0.66, F: 0.57, Na: 1.66, Mg: 1.41, Al: 1.21, Si: 1.11, P: 1.07, S: 1.05, Cl: 1.02, K: 2.03, Ca: 1.76, Ti: 1.36, V: 1.34, Cr: 1.22, Mn: 1.19, Fe: 1.24, Co: 1.18, Ni: 1.17, Cu: 1.17, Zn: 1.25, Br: 1.20, I: 1.39 };
  var GRID_SIZE = 3.4;
  var MAX_POLYHEDRA = 256;
  var MAX_IMAGE_CANDIDATES = 400000;
  var MAX_NEIGHBOR_CHECKS = 5000000;

  function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
  function cross(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
  function length(a) { return Math.hypot(a[0], a[1], a[2]); }
  function cartesian(fractional, cell) {
    return [0, 1, 2].map(function (axis) {
      return fractional[0] * cell[0][axis] + fractional[1] * cell[1][axis] + fractional[2] * cell[2][axis];
    });
  }
  function fractional(point, cell) {
    var volume = dot(cell[0], cross(cell[1], cell[2]));
    if (!Number.isFinite(volume) || Math.abs(volume) < 1e-8) return null;
    return [
      dot(point, cross(cell[1], cell[2])) / volume,
      dot(point, cross(cell[2], cell[0])) / volume,
      dot(point, cross(cell[0], cell[1])) / volume,
    ];
  }
  function isPeriodicStructure(structure) {
    return Boolean(structure && structure.format !== 'pdb' && Array.isArray(structure.cell)
      && structure.cell.length === 3 && structure.cell.every(function (v) {
        return Array.isArray(v) && v.length === 3 && v.every(Number.isFinite);
      }) && fractional([0, 0, 0], structure.cell));
  }
  function wrap(value) {
    var result = value - Math.floor(value);
    return result < 1e-7 || result > 1 - 1e-7 ? 0 : result;
  }
  function atomPosition(atom) { return [atom.x, atom.y, atom.z]; }
  function hasVolume(points) {
    var first = null, normal = null;
    for (var i = 1; i < points.length; i += 1) {
      var delta = points[i].map(function (value, axis) { return value - points[0][axis]; });
      if (!first) { if (length(delta) > 1e-6) first = delta; continue; }
      if (!normal) { var candidate = cross(first, delta); if (length(candidate) > 1e-6) normal = candidate; continue; }
      if (Math.abs(dot(normal, delta)) > 1e-4) return true;
    }
    return false;
  }
  function defaultCoordination(structure) {
    var elements = Array.from(new Set(structure.atoms.map(function (atom) { return atom.element; })));
    var ligand = elements.includes('O') ? 'O' : (elements.includes('F') ? 'F' : elements[elements.length - 1]);
    var center = elements.find(function (element) { return element !== ligand && element !== 'H' && element !== 'C'; })
      || elements.find(function (element) { return element !== ligand; }) || elements[0];
    return { center: center, ligand: ligand, cutoff: ligand === 'O' ? 2.8 : 2.6 };
  }
  function build(structure, options) {
    if (!isPeriodicStructure(structure)) throw new Error('A non-degenerate unit cell is required.');
    if (structure.atoms.length > 20000) throw new Error('Periodic previews support up to 20,000 atoms. Open a smaller structure.');
    options = options || {};
    var cell = structure.cell;
    var atoms = structure.atoms.map(function (atom) {
      var position = cartesian(fractional(atomPosition(atom), cell).map(wrap), cell);
      return Object.assign({}, atom, { x: position[0], y: position[1], z: position[2] });
    });
    var defaults = defaultCoordination(structure);
    var centerElement = options.center || defaults.center;
    var ligandElement = options.ligand || defaults.ligand;
    var cutoff = Number(options.cutoff);
    if (!(cutoff >= 1 && cutoff <= 5)) cutoff = defaults.cutoff;
    var largestRadius = atoms.reduce(function (radius, atom) { return Math.max(radius, RADII[atom.element] || 0.77); }, 0);
    var searchDistance = Math.max(cutoff, Math.min(5, largestRadius * 2 * 1.28));
    var searchRange = Math.ceil(searchDistance / GRID_SIZE);
    var imageAtoms = atoms.slice(), bonds = [], polyhedra = [], seenImages = new Map(), seenBonds = new Set();
    var grid = new Map(), neighborChecks = 0, polyhedraLimited = false;
    var volume = Math.abs(dot(cell[0], cross(cell[1], cell[2])));
    var shiftRanges = [0, 1, 2].map(function (axis) {
      var opposite = cross(cell[(axis + 1) % 3], cell[(axis + 2) % 3]);
      return Math.max(1, Math.ceil(searchDistance * length(opposite) / volume));
    });
    var imageCount = atoms.length * shiftRanges.reduce(function (count, range) { return count * (2 * range + 1); }, 1);
    if (imageCount > MAX_IMAGE_CANDIDATES) {
      throw new Error('This unit cell requires too many periodic images to preview (' + imageCount.toLocaleString() + ').');
    }
    function bucket(position) { return position.map(function (v) { return Math.floor(v / GRID_SIZE); }).join(','); }
    function imageKey(index, shift) { return index + ':' + shift.join(','); }
    for (var ax = -shiftRanges[0]; ax <= shiftRanges[0]; ax += 1)
      for (var by = -shiftRanges[1]; by <= shiftRanges[1]; by += 1)
        for (var cz = -shiftRanges[2]; cz <= shiftRanges[2]; cz += 1) {
      var shift = [ax, by, cz], offset = cartesian(shift, cell);
      atoms.forEach(function (atom, index) {
        var position = [atom.x + offset[0], atom.y + offset[1], atom.z + offset[2]];
        var image = { index: index, shift: shift, position: position };
        var key = bucket(position), list = grid.get(key) || [];
        list.push(image); grid.set(key, list);
      });
    }
    function renderImage(image) {
      if (image.shift.every(function (v) { return v === 0; })) return image.index;
      var key = imageKey(image.index, image.shift);
      if (!seenImages.has(key)) {
        var original = atoms[image.index], position = image.position;
        seenImages.set(key, imageAtoms.length);
        imageAtoms.push(Object.assign({}, original, { x: position[0], y: position[1], z: position[2], imageOf: image.index }));
      }
      return seenImages.get(key);
    }
    atoms.forEach(function (atom, index) {
      var point = atomPosition(atom), base = point.map(function (v) { return Math.floor(v / GRID_SIZE); });
      var ligands = [];
      for (var dx = -searchRange; dx <= searchRange; dx += 1) for (var dy = -searchRange; dy <= searchRange; dy += 1) for (var dz = -searchRange; dz <= searchRange; dz += 1) {
        var candidates = grid.get([base[0] + dx, base[1] + dy, base[2] + dz].join(',')) || [];
        candidates.forEach(function (image) {
          neighborChecks += 1;
          if (neighborChecks > MAX_NEIGHBOR_CHECKS) throw new Error('Too many nearby atoms for an interactive periodic preview. Open a smaller structure.');
          if (image.index === index && image.shift.every(function (v) { return v === 0; })) return;
          var other = atoms[image.index], delta = image.position.map(function (v, axis) { return v - point[axis]; });
          var distance = length(delta);
          if (distance < 0.3 || distance > 5) return;
          if (atom.element === centerElement && other.element === ligandElement && distance <= cutoff) {
            ligands.push({ image: image, distance: distance });
          }
          var bondLimit = ((RADII[atom.element] || 0.77) + (RADII[other.element] || 0.77)) * 1.28;
          if (distance > bondLimit || distance < 0.4) return;
          if (image.shift.every(function (v) { return v === 0; }) && image.index < index) return;
          var key = index + ':' + imageKey(image.index, image.shift);
          if (seenBonds.has(key)) return;
          seenBonds.add(key);
          if (bonds.length >= 100000) throw new Error('Too many bonds for an interactive periodic preview. Open a smaller structure.');
          bonds.push({ from: index, to: renderImage(image), length: distance, shift: image.shift.slice() });
        });
      }
      if (atom.element === centerElement) {
        ligands.sort(function (a, b) { return a.distance - b.distance; });
        if (ligands.length >= 4) {
          if (ligands.length > 128) throw new Error('More than 128 coordinating neighbors. Reduce the coordination cutoff.');
          var shell = ligands;
          if (!hasVolume(shell.map(function (entry) { return entry.image.position; }))) return;
          if (polyhedra.length >= MAX_POLYHEDRA) { polyhedraLimited = true; return; }
          polyhedra.push({ center: index, vertices: shell.map(function (entry) { return entry.image.position; }),
            renderIndices: shell.map(function (entry) { return renderImage(entry.image); }) });
        }
      }
    });
    var corners = [];
    for (var mask = 0; mask < 8; mask += 1) corners.push(cartesian([mask & 1 ? 1 : 0, mask & 2 ? 1 : 0, mask & 4 ? 1 : 0], cell));
    return { atoms: atoms, renderAtoms: imageAtoms, bonds: bonds, polyhedra: polyhedra,
      corners: corners, centerElement: centerElement, ligandElement: ligandElement, cutoff: cutoff,
      polyhedraLimited: polyhedraLimited };
  }

  var api = { build: build, cartesian: cartesian, defaultCoordination: defaultCoordination,
    fractional: fractional, isPeriodicStructure: isPeriodicStructure };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.RemoteCodexCrystalGeometry = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
