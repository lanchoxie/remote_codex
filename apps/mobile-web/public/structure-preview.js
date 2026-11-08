(function attachStructurePreview(global) {
  'use strict';

  // Dependency-free parser and canvas viewer. Parsing is exported for focused
  // Node tests; the UI controller is only activated when a browser DOM exists.
  var SUPPORTED_EXTENSIONS = new Set(['xsf', 'pdb', 'pbd', 'xyz', 'cif', 'vasp', 'poscar', 'contcar']);
  var MAX_SOURCE_BYTES = 24 * 1024 * 1024;
  var ELEMENT_COLORS = Object.freeze({
    H: '#ffffff', He: '#d9ffff', Li: '#cc80ff', Be: '#c2ff00', B: '#ffb5b5',
    C: '#909090', N: '#3050f8', O: '#ff0d0d', F: '#90e050', Ne: '#b3e3f5',
    Na: '#ab5cf2', Mg: '#8aff00', Al: '#bfa6a6', Si: '#f0c8a0', P: '#ff8000',
    S: '#ffff30', Cl: '#1ff01f', Ar: '#80d1e3', K: '#8f40d4', Ca: '#3dff00',
    Ti: '#bfc2c7', V: '#a6a6ab', Cr: '#8a99c7', Mn: '#9c7ac7', Fe: '#e06633',
    Co: '#f090a0', Ni: '#50d050', Cu: '#c88033', Zn: '#7d80b0', Ga: '#c28f8f',
    Ge: '#668f8f', As: '#bd80e3', Se: '#ffa100', Br: '#a62929', Kr: '#5cb8d1',
    Rb: '#702eb0', Sr: '#00ff00', Y: '#94ffff', Zr: '#94e0e0', Nb: '#73c2c9',
    Mo: '#54b5b5', Ru: '#248f8f', Rh: '#0a7d8c', Pd: '#006985', Ag: '#c0c0c0',
    Cd: '#ffd98f', In: '#a67573', Sn: '#668080', Sb: '#9e63b5', Te: '#d47a00',
    I: '#940094', Xe: '#429eb0', Cs: '#57178f', Ba: '#00c900', La: '#70d4ff',
    Ce: '#ffffc7', Pr: '#d9ffc7', Nd: '#c7ffc7', Sm: '#8fffc7', Eu: '#61ffc7',
    Gd: '#45ffc7', Tb: '#30ffc7', Dy: '#1fffc7', Ho: '#00ff9c', Er: '#00e675',
    Tm: '#00d452', Yb: '#00bf38', Lu: '#00ab24', Hf: '#4dc2ff', Ta: '#4da6ff',
    W: '#2194d6', Re: '#267dab', Os: '#266696', Ir: '#175487', Pt: '#d0d0e0',
    Au: '#ffd123', Hg: '#b8b8d0', Tl: '#a6544d', Pb: '#575961', Bi: '#9e4fb5',
    U: '#008fff', Pu: '#006bff', Am: '#545cf2', Cm: '#785ce3', Bk: '#8a4fe3',
    Cf: '#a136d4', Fm: '#b31fba', Md: '#b30da6', No: '#bd0d87', Lr: '#c70066',
  });
  var COVALENT_RADII = Object.freeze({ H: 0.31, C: 0.76, N: 0.71, O: 0.66, F: 0.57, P: 1.07, S: 1.05, Cl: 1.02, Br: 1.20, I: 1.39, Si: 1.11, B: 0.84, Na: 1.66, Mg: 1.41, Al: 1.21, K: 2.03, Ca: 1.76, Fe: 1.24, Cu: 1.17, Zn: 1.25 });
  var ATOMIC_SYMBOLS = ['', 'H', 'He', 'Li', 'Be', 'B', 'C', 'N', 'O', 'F', 'Ne', 'Na', 'Mg', 'Al', 'Si', 'P', 'S', 'Cl', 'Ar', 'K', 'Ca', 'Sc', 'Ti', 'V', 'Cr', 'Mn', 'Fe', 'Co', 'Ni', 'Cu', 'Zn', 'Ga', 'Ge', 'As', 'Se', 'Br', 'Kr', 'Rb', 'Sr', 'Y', 'Zr', 'Nb', 'Mo', 'Tc', 'Ru', 'Rh', 'Pd', 'Ag', 'Cd', 'In', 'Sn', 'Sb', 'Te', 'I', 'Xe', 'Cs', 'Ba', 'La', 'Ce', 'Pr', 'Nd', 'Pm', 'Sm', 'Eu', 'Gd', 'Tb', 'Dy', 'Ho', 'Er', 'Tm', 'Yb', 'Lu', 'Hf', 'Ta', 'W', 'Re', 'Os', 'Ir', 'Pt', 'Au', 'Hg', 'Tl', 'Pb', 'Bi', 'Po', 'At', 'Rn', 'Fr', 'Ra', 'Ac', 'Th', 'Pa', 'U', 'Np', 'Pu', 'Am', 'Cm', 'Bk', 'Cf', 'Es', 'Fm', 'Md', 'No', 'Lr', 'Rf', 'Db', 'Sg', 'Bh', 'Hs', 'Mt', 'Ds', 'Rg', 'Cn', 'Nh', 'Fl', 'Mc', 'Lv', 'Ts', 'Og'];

  function extensionOf(name) {
    var match = /\.([a-z0-9]+)$/i.exec(String(name || '').trim());
    return match ? match[1].toLowerCase() : '';
  }
  function isSupportedFile(value) {
    var name = typeof value === 'string' ? value : (value && (value.name || value.remoteName || value.path || value.remotePath));
    var leaf = String(name || '').trim().split(/[\\/]/).pop().toUpperCase();
    return SUPPORTED_EXTENSIONS.has(extensionOf(name)) || leaf === 'POSCAR' || leaf === 'CONTCAR';
  }
  function normalizeElement(value) {
    var raw = String(value == null ? '' : value).replace(/[0-9+().-]/g, '').trim();
    var letters = (raw.match(/[A-Za-z]+/) || ['X'])[0];
    var first = letters.charAt(0).toUpperCase();
    var two = first + letters.charAt(1).toLowerCase();
    return Object.prototype.hasOwnProperty.call(ELEMENT_COLORS, two) ? two : first;
  }
  function numberOrNull(value) {
    var text = String(value == null ? '' : value).trim().replace(/,/g, '');
    if (!text || text === '?' || text === '.') return null;
    // CIF values may carry an uncertainty suffix, e.g. 10.123(4). Strip
    // only that suffix; removing every parenthesis turns 10.123(4) into
    // 10.1234 and silently corrupts the unit cell.
    var match = /^\(?([+-]?(?:(?:\d+(?:\.\d*)?)|(?:\.\d+))(?:[eEdD][+-]?\d+)?)(?:\(\d+\))?\)?$/.exec(text);
    if (!match) return null;
    var number = Number(match[1].replace(/[dD]/g, 'E'));
    return Number.isFinite(number) ? number : null;
  }
  function splitWhitespace(line) { return String(line || '').trim().split(/\s+/).filter(Boolean); }
  function distanceSquared(a, b) { var x = a.x - b.x, y = a.y - b.y, z = a.z - b.z; return x * x + y * y + z * z; }

  function inferBonds(atoms) {
    if (!Array.isArray(atoms) || atoms.length < 2 || atoms.length > 5000) return [];
    var size = 2.8, cells = new Map(), bonds = [], seen = new Set();
    function key(x, y, z) { return Math.floor(x / size) + ',' + Math.floor(y / size) + ',' + Math.floor(z / size); }
    atoms.forEach(function (atom, index) { var k = key(atom.x, atom.y, atom.z); var list = cells.get(k) || []; list.push(index); cells.set(k, list); });
    atoms.forEach(function (atom, index) {
      var cx = Math.floor(atom.x / size), cy = Math.floor(atom.y / size), cz = Math.floor(atom.z / size);
      for (var dx = -1; dx <= 1; dx += 1) for (var dy = -1; dy <= 1; dy += 1) for (var dz = -1; dz <= 1; dz += 1) {
        var list = cells.get((cx + dx) + ',' + (cy + dy) + ',' + (cz + dz)) || [];
        list.forEach(function (otherIndex) {
          if (otherIndex <= index) return;
          var other = atoms[otherIndex];
          var limit = ((COVALENT_RADII[atom.element] || 0.77) + (COVALENT_RADII[other.element] || 0.77)) * 1.28;
          if (distanceSquared(atom, other) < 0.09 || distanceSquared(atom, other) > limit * limit) return;
          var bondKey = index + ':' + otherIndex;
          if (!seen.has(bondKey)) { seen.add(bondKey); bonds.push([index, otherIndex]); }
        });
      }
    });
    return bonds;
  }
  function normalizeCell(cell) {
    if (!cell) return null;
    if (Array.isArray(cell) && cell.length === 3 && cell.every(function (row) { return Array.isArray(row) && row.length >= 3; })) return cell.slice(0, 3).map(function (row) { return row.slice(0, 3).map(Number); });
    if (cell.vectors) return normalizeCell(cell.vectors);
    var a = numberOrNull(cell.a), b = numberOrNull(cell.b), c = numberOrNull(cell.c);
    if (!(a > 0 && b > 0 && c > 0)) return null;
    var alpha = (numberOrNull(cell.alpha) == null ? 90 : numberOrNull(cell.alpha)) * Math.PI / 180;
    var beta = (numberOrNull(cell.beta) == null ? 90 : numberOrNull(cell.beta)) * Math.PI / 180;
    var gamma = (numberOrNull(cell.gamma) == null ? 90 : numberOrNull(cell.gamma)) * Math.PI / 180;
    var sg = Math.sin(gamma) || 1, v1 = [a, 0, 0], v2 = [b * Math.cos(gamma), b * sg, 0];
    var cx = c * Math.cos(beta), cy = c * (Math.cos(alpha) - Math.cos(beta) * Math.cos(gamma)) / sg;
    var cz = Math.sqrt(Math.max(0, c * c - cx * cx - cy * cy));
    return [v1, v2, [cx, cy, cz]];
  }
  function finalizeStructure(format, atoms, bonds, cell, metadata) {
    var normalized = (Array.isArray(atoms) ? atoms : []).filter(function (atom) { return atom && [atom.x, atom.y, atom.z].every(function (v) { return Number.isFinite(Number(v)); }); }).map(function (atom, index) {
      return { index: index, element: normalizeElement(atom.element || atom.label), label: String(atom.label || atom.element || '').trim(), x: Number(atom.x), y: Number(atom.y), z: Number(atom.z), charge: numberOrNull(atom.charge) };
    });
    if (!normalized.length) { var error = new Error('No atoms found in ' + (format || 'structure') + ' data.'); error.code = 'structure_no_atoms'; throw error; }
    var outBonds = [], seen = new Set();
    (Array.isArray(bonds) ? bonds : []).forEach(function (pair) {
      var a = Number(pair && pair[0]), b = Number(pair && pair[1]);
      if (!Number.isInteger(a) || !Number.isInteger(b) || a < 0 || b < 0 || a >= normalized.length || b >= normalized.length || a === b) return;
      var left = Math.min(a, b), right = Math.max(a, b), key = left + ':' + right;
      if (!seen.has(key)) { seen.add(key); outBonds.push([left, right]); }
    });
    if (!outBonds.length) outBonds = inferBonds(normalized);
    return { format: String(format || 'unknown').toLowerCase(), atoms: normalized, bonds: outBonds, cell: normalizeCell(cell), metadata: metadata || {} };
  }

  function parseXYZ(text) {
    var lines = String(text || '').split(/\r?\n/), declared = Number.parseInt((lines[0] || '').trim(), 10), start = Number.isInteger(declared) && declared > 0 ? 2 : 0, limit = Number.isInteger(declared) && declared > 0 ? declared : lines.length, atoms = [];
    for (var i = start; i < lines.length && atoms.length < limit; i += 1) {
      var parts = splitWhitespace(lines[i]); if (parts.length < 4) continue;
      var x = numberOrNull(parts[1]), y = numberOrNull(parts[2]), z = numberOrNull(parts[3]);
      if ([x, y, z].some(function (v) { return v === null; })) continue;
      atoms.push({ element: parts[0], label: parts[0], x: x, y: y, z: z, charge: parts[4] });
    }
    return finalizeStructure('xyz', atoms, [], null, { comment: start ? (lines[1] || '') : '' });
  }

  function parsePdb(text) {
    var lines = String(text || '').split(/\r?\n/), atoms = [], serials = new Map(), conect = [], cell = null, modelSeen = false, modelFinished = false;
    lines.forEach(function (line) {
      var record = line.slice(0, 6).trim().toUpperCase();
      if (record === 'MODEL') { if (modelSeen) modelFinished = true; else modelSeen = true; return; }
      if (record === 'ENDMDL') { if (modelSeen) modelFinished = true; return; }
      if (modelFinished) return;
      if (record === 'CRYST1') { cell = { a: numberOrNull(line.slice(6, 15)), b: numberOrNull(line.slice(15, 24)), c: numberOrNull(line.slice(24, 33)), alpha: numberOrNull(line.slice(33, 40)), beta: numberOrNull(line.slice(40, 47)), gamma: numberOrNull(line.slice(47, 54)) }; return; }
      if (record === 'CONECT') { var ids = line.slice(6).trim().split(/\s+/).map(function (v) { return Number.parseInt(v, 10); }).filter(Number.isInteger); ids.slice(1).forEach(function (id) { conect.push([ids[0], id]); }); return; }
      if (record !== 'ATOM' && record !== 'HETATM') return;
      var alt = line.slice(16, 17); if (alt && !['A', '1', ' '].includes(alt)) return;
      var x = numberOrNull(line.slice(30, 38)), y = numberOrNull(line.slice(38, 46)), z = numberOrNull(line.slice(46, 54));
      if ([x, y, z].some(function (v) { return v === null; })) { var fallback = splitWhitespace(line); x = numberOrNull(fallback[6]); y = numberOrNull(fallback[7]); z = numberOrNull(fallback[8]); }
      if ([x, y, z].some(function (v) { return v === null; })) return;
      var serial = Number.parseInt(line.slice(6, 11).trim(), 10), atomName = line.slice(12, 16).trim(), element = line.slice(76, 78).trim() || atomName.replace(/[0-9]/g, '');
      var index = atoms.length; atoms.push({ element: element, label: atomName, x: x, y: y, z: z, charge: line.slice(78, 80).trim() }); if (Number.isInteger(serial)) serials.set(serial, index);
    });
    return finalizeStructure('pdb', atoms, conect.map(function (pair) { return [serials.get(pair[0]), serials.get(pair[1])]; }), cell);
  }

  function parseXsf(text) {
    var lines = String(text || '').split(/\r?\n/), atoms = [], cell = null, bohr = false;
    for (var i = 0; i < lines.length; i += 1) {
      var marker = lines[i].trim().toUpperCase(); if (marker === 'BOHR') { bohr = true; continue; }
      if (marker === 'PRIMVEC' || marker === 'CONVVEC') { var vectors = []; for (var j = 1; j <= 3; j += 1) { var vector = splitWhitespace(lines[i + j]).map(numberOrNull); if (vector.length >= 3 && vector.slice(0, 3).every(function (v) { return v !== null; })) vectors.push(vector.slice(0, 3)); } if (vectors.length === 3) cell = vectors; i += 3; continue; }
      if (marker === 'PRIMCOORD') { var count = Number.parseInt(splitWhitespace(lines[i + 1])[0] || '', 10), rows = Number.isInteger(count) ? count : lines.length, parsed = []; for (var k = 0; k < rows && i + 2 + k < lines.length; k += 1) { var parts = splitWhitespace(lines[i + 2 + k]); if (parts.length < 4) break; var symbol = parts[0], atomic = Number.parseInt(symbol, 10); if (Number.isInteger(atomic) && ATOMIC_SYMBOLS[atomic]) symbol = ATOMIC_SYMBOLS[atomic]; var x = numberOrNull(parts[1]), y = numberOrNull(parts[2]), z = numberOrNull(parts[3]); if ([x, y, z].every(function (v) { return v !== null; })) parsed.push({ element: symbol, label: symbol, x: x, y: y, z: z }); } if (parsed.length) atoms = parsed; continue; }
      if (marker === 'ATOMS') { var loose = []; for (var q = i + 1; q < lines.length; q += 1) { var row = splitWhitespace(lines[q]); if (row.length < 4) break; var ax = numberOrNull(row[1]), ay = numberOrNull(row[2]), az = numberOrNull(row[3]); if ([ax, ay, az].every(function (v) { return v !== null; })) loose.push({ element: row[0], label: row[0], x: ax, y: ay, z: az }); } if (loose.length) atoms = loose; }
    }
    if (bohr) { var factor = 0.529177210903; atoms = atoms.map(function (a) { return Object.assign({}, a, { x: a.x * factor, y: a.y * factor, z: a.z * factor }); }); if (cell) cell = cell.map(function (row) { return row.map(function (v) { return v * factor; }); }); }
    return finalizeStructure('xsf', atoms, [], cell);
  }

  function parseVasp(text) {
    var lines = String(text || '').split(/\r?\n/);
    if (lines.length < 6) return finalizeStructure('vasp', [], [], null);
    var requestedScale = numberOrNull(lines[1]);
    if (!(requestedScale && Number.isFinite(requestedScale))) requestedScale = 1;
    var vectors = [];
    for (var i = 0; i < 3; i += 1) {
      var vector = splitWhitespace(lines[2 + i]).slice(0, 3).map(numberOrNull);
      if (vector.length !== 3 || vector.some(function (v) { return v === null; })) return finalizeStructure('vasp', [], [], null);
      vectors.push(vector);
    }
    // POSCAR permits a negative second line to specify the target cell
    // volume. Convert it to a uniform length scale before using the lattice
    // for direct or Cartesian coordinates.
    var determinant = vectors[0][0] * (vectors[1][1] * vectors[2][2] - vectors[1][2] * vectors[2][1])
      - vectors[0][1] * (vectors[1][0] * vectors[2][2] - vectors[1][2] * vectors[2][0])
      + vectors[0][2] * (vectors[1][0] * vectors[2][1] - vectors[1][1] * vectors[2][0]);
    var scale = requestedScale < 0
      ? (Math.abs(determinant) > 0 ? Math.cbrt(Math.abs(requestedScale) / Math.abs(determinant)) : 1)
      : requestedScale;
    vectors = vectors.map(function (vector) { return vector.map(function (v) { return v * scale; }); });
    var cursor = 5;
    var symbolTokens = splitWhitespace(lines[cursor]);
    var hasSymbols = symbolTokens.length > 0 && symbolTokens.every(function (token) { return !/^[-+]?\d+(?:\.\d+)?$/.test(token); });
    var symbols = hasSymbols ? symbolTokens : [];
    if (hasSymbols) cursor += 1;
    var counts = splitWhitespace(lines[cursor]).map(function (value) { return Number.parseInt(value, 10); });
    if (!counts.length || counts.some(function (value) { return !Number.isInteger(value) || value < 0; })) return finalizeStructure('vasp', [], [], vectors);
    cursor += 1;
    if (/^s(?:elective)?\s+dynamics?$/i.test(String(lines[cursor] || '').trim())) cursor += 1;
    var modeLine = String(lines[cursor] || '').trim().toLowerCase();
    var mode = 'direct';
    if (/^d(?:irect)?\b/.test(modeLine)) {
      mode = 'direct';
      cursor += 1;
    } else if (/^c(?:artesian)?\b/.test(modeLine)) {
      mode = 'cartesian';
      cursor += 1;
    } else if (/^k(?:points?)?\b/.test(modeLine)) {
      cursor += 1;
    }
    var atoms = [], atomNumber = 0;
    for (var elementIndex = 0; elementIndex < counts.length; elementIndex += 1) {
      var element = symbols[elementIndex] || 'X';
      for (var atomIndex = 0; atomIndex < counts[elementIndex] && cursor < lines.length; atomIndex += 1) {
        var parts = splitWhitespace(lines[cursor++]);
        if (parts.length < 3) { atomIndex -= 1; continue; }
        var coords = parts.slice(0, 3).map(numberOrNull);
        if (coords.some(function (v) { return v === null; })) { atomIndex -= 1; continue; }
        if (mode === 'direct') {
          var fx = coords[0], fy = coords[1], fz = coords[2];
          coords = [fx * vectors[0][0] + fy * vectors[1][0] + fz * vectors[2][0], fx * vectors[0][1] + fy * vectors[1][1] + fz * vectors[2][1], fx * vectors[0][2] + fy * vectors[1][2] + fz * vectors[2][2]];
        } else {
          coords = coords.map(function (v) { return v * scale; });
        }
        atoms.push({ element: element, label: element + (++atomNumber), x: coords[0], y: coords[1], z: coords[2] });
      }
    }
    return finalizeStructure('vasp', atoms, [], vectors, { coordinateMode: mode, scale: scale, requestedScale: requestedScale });
  }

  function cifTokens(line) {
    var source = String(line || ''), tokens = [], i = 0;
    while (i < source.length) {
      while (/\s/.test(source[i] || '')) i += 1; if (i >= source.length || source[i] === '#') break;
      var quote = source[i]; if (quote === "'" || quote === '"') { i += 1; var start = i; while (i < source.length && source[i] !== quote) i += 1; tokens.push(source.slice(start, i)); i += 1; }
      else { var begin = i; while (i < source.length && !/\s/.test(source[i]) && source[i] !== '#') i += 1; tokens.push(source.slice(begin, i)); }
    }
    return tokens;
  }
  function parseCif(text) {
    var lines = String(text || '').split(/\r?\n/), scalar = {}, loops = [];
    for (var i = 0; i < lines.length; i += 1) {
      var trimmed = lines[i].trim(); if (!trimmed || trimmed.charAt(0) === '#') continue;
      var scalarMatch = /^(\S+)\s+(.+)$/.exec(trimmed); if (scalarMatch && scalarMatch[1].charAt(0) === '_') { var scalarValue = cifTokens(scalarMatch[2])[0]; if (scalarValue !== undefined) scalar[scalarMatch[1].toLowerCase()] = scalarValue; }
      if (trimmed.toLowerCase() !== 'loop_') continue;
      var tags = [], cursor = i + 1;
      while (cursor < lines.length) { var tagLine = lines[cursor].trim(); if (!tagLine || tagLine.charAt(0) === '#') { cursor += 1; continue; } if (tagLine.charAt(0) !== '_') break; tags.push(tagLine.split(/\s+/)[0].toLowerCase()); cursor += 1; }
      if (!tags.length) continue;
      var values = []; while (cursor < lines.length) { var rowText = lines[cursor], rowTrim = rowText.trim(); if (rowTrim && (rowTrim.toLowerCase() === 'loop_' || rowTrim.charAt(0) === '_')) break; if (rowTrim && rowTrim.charAt(0) !== '#') values.push.apply(values, cifTokens(rowText)); cursor += 1; }
      loops.push({ tags: tags, values: values }); i = cursor - 1;
    }
    function scalarNumber(name, fallback) { var n = numberOrNull(scalar[name]); return n == null ? fallback : n; }
    var cell = { a: scalarNumber('_cell_length_a', null), b: scalarNumber('_cell_length_b', null), c: scalarNumber('_cell_length_c', null), alpha: scalarNumber('_cell_angle_alpha', 90), beta: scalarNumber('_cell_angle_beta', 90), gamma: scalarNumber('_cell_angle_gamma', 90) };
    var loop = loops.find(function (candidate) { return candidate.tags.some(function (tag) { return tag.indexOf('_atom_site_') === 0; }); }); if (!loop) return finalizeStructure('cif', [], [], cell);
    function indexOf() { var names = Array.prototype.slice.call(arguments); for (var n = 0; n < names.length; n += 1) { var idx = loop.tags.indexOf(names[n]); if (idx >= 0) return idx; } return -1; }
    var elementIndex = indexOf('_atom_site_type_symbol', '_atom_site_label'), labelIndex = indexOf('_atom_site_label'), cart = [indexOf('_atom_site_cartn_x'), indexOf('_atom_site_cartn_y'), indexOf('_atom_site_cartn_z')], fract = [indexOf('_atom_site_fract_x'), indexOf('_atom_site_fract_y'), indexOf('_atom_site_fract_z')], chargeIndex = indexOf('_atom_site_charge'), vectors = normalizeCell(cell), atoms = [];
    for (var offset = 0; offset + loop.tags.length <= loop.values.length; offset += loop.tags.length) { var row = loop.values.slice(offset, offset + loop.tags.length), coords = cart.every(function (idx) { return idx >= 0; }) ? cart.map(function (idx) { return numberOrNull(row[idx]); }) : fract.map(function (idx) { return numberOrNull(row[idx]); }); if (coords.some(function (v) { return v === null; })) continue; if (!cart.every(function (idx) { return idx >= 0; }) && vectors) { var va = vectors[0], vb = vectors[1], vc = vectors[2], fx = coords[0], fy = coords[1], fz = coords[2]; coords = [fx * va[0] + fy * vb[0] + fz * vc[0], fx * va[1] + fy * vb[1] + fz * vc[1], fx * va[2] + fy * vb[2] + fz * vc[2]]; } atoms.push({ element: row[elementIndex] || 'X', label: labelIndex >= 0 ? row[labelIndex] : row[elementIndex], x: coords[0], y: coords[1], z: coords[2], charge: chargeIndex >= 0 ? row[chargeIndex] : null }); }
    return finalizeStructure('cif', atoms, [], cell, { fractionalCoordinates: !cart.every(function (idx) { return idx >= 0; }) });
  }

  function parse(text, filename) {
    var source = String(text == null ? '' : text); if (source.length > MAX_SOURCE_BYTES) { var tooLarge = new Error('Structure file is too large to preview (limit 24 MB).'); tooLarge.code = 'structure_too_large'; throw tooLarge; }
    var extension = extensionOf(filename), fileLeaf = String(filename || '').trim().split(/[\\/]/).pop().toUpperCase(); if (extension === 'xyz') return parseXYZ(source); if (extension === 'pdb' || extension === 'pbd') return parsePdb(source); if (extension === 'xsf') return parseXsf(source); if (extension === 'cif') return parseCif(source); if (extension === 'vasp' || extension === 'poscar' || extension === 'contcar' || fileLeaf === 'POSCAR' || fileLeaf === 'CONTCAR' || /(^|\n)\s*POSCAR/i.test(source)) return parseVasp(source);
    var first = source.trimStart().split(/\r?\n/)[0].trim(); if (/^data_/i.test(first) || /_atom_site_/i.test(source)) return parseCif(source); if (/^(?:ATOM  |HETATM|HEADER |CRYST1)/m.test(source)) return parsePdb(source); if (/^(?:PRIMVEC|PRIMCOORD|ATOMS)\b/im.test(source)) return parseXsf(source); return parseXYZ(source);
  }
  function colorForElement(element) { return ELEMENT_COLORS[normalizeElement(element)] || '#b0b5be'; }

  var activeViewer = null;
  function ensureViewer(documentRef) {
    if (!documentRef) return null;
    var overlay = documentRef.getElementById('structure-preview-overlay');
    if (!overlay) {
      overlay = documentRef.createElement('section');
      overlay.id = 'structure-preview-overlay';
      overlay.className = 'structure-preview-overlay hidden';
      overlay.setAttribute('role', 'dialog');
      overlay.setAttribute('aria-modal', 'true');
      overlay.setAttribute('aria-hidden', 'true');
      overlay.setAttribute('aria-labelledby', 'structure-preview-title');
      overlay.innerHTML = '<div class="structure-preview-modal">'
        + '<div class="structure-preview-header"><div><div class="eyebrow">Structure Preview</div><div id="structure-preview-title" class="structure-preview-title">Structure</div><div id="structure-preview-subtitle" class="structure-preview-subtitle"></div></div>'
        + '<button id="structure-preview-close-button" type="button" class="secondary-button" aria-label="Close structure preview">Close</button></div>'
        + '<div class="structure-preview-toolbar" role="toolbar" aria-label="Structure viewer controls">'
        + '<button id="structure-preview-fit-button" type="button" class="secondary-button" title="Fit structure">Fit</button>'
        + '<button id="structure-preview-labels-button" type="button" class="secondary-button" aria-pressed="false" title="Toggle atom labels">Labels</button>'
        + '<span id="structure-preview-status" class="structure-preview-status" aria-live="polite"></span></div>'
        + '<div class="structure-preview-canvas-wrap"><canvas id="structure-preview-canvas" aria-label="Interactive molecular structure"></canvas></div>'
        + '<div id="structure-preview-error" class="structure-preview-error hidden" role="alert"></div>'
        + '<div class="structure-preview-legend"><span>Drag to rotate / Wheel to zoom</span><span id="structure-preview-cell-label"></span></div></div>';
      documentRef.body.appendChild(overlay);
    }
    var canvas = overlay.querySelector('#structure-preview-canvas');
    if (!canvas) return null;
    if (canvas.__remoteCodexStructureViewer) return canvas.__remoteCodexStructureViewer;
    var ctx = canvas.getContext && canvas.getContext('2d');
    if (!ctx) return null;
    var viewer = { overlay: overlay, canvas: canvas, ctx: ctx, structure: null, name: '', yaw: -0.55, pitch: 0.35, zoom: 1, labels: false, dragging: false, lastX: 0, lastY: 0 };
    canvas.__remoteCodexStructureViewer = viewer;
    overlay.querySelector('#structure-preview-close-button').addEventListener('click', close);
    overlay.querySelector('#structure-preview-fit-button').addEventListener('click', function () { viewer.yaw = -0.55; viewer.pitch = 0.35; viewer.zoom = 1; draw(viewer); });
    overlay.querySelector('#structure-preview-labels-button').addEventListener('click', function (event) { viewer.labels = !viewer.labels; event.currentTarget.setAttribute('aria-pressed', String(viewer.labels)); draw(viewer); });
    overlay.addEventListener('click', function (event) { if (event.target === overlay) close(); });
    if (global.addEventListener) global.addEventListener('keydown', function (event) { if (event.key === 'Escape' && activeViewer === viewer) close(); });
    canvas.addEventListener('pointerdown', function (event) { viewer.dragging = true; viewer.lastX = event.clientX; viewer.lastY = event.clientY; if (canvas.setPointerCapture) canvas.setPointerCapture(event.pointerId); });
    canvas.addEventListener('pointermove', function (event) {
      if (!viewer.dragging) return;
      viewer.yaw += (event.clientX - viewer.lastX) * 0.012;
      viewer.pitch = Math.max(-1.45, Math.min(1.45, viewer.pitch + (event.clientY - viewer.lastY) * 0.012));
      viewer.lastX = event.clientX; viewer.lastY = event.clientY; draw(viewer);
    });
    ['pointerup', 'pointercancel', 'pointerleave'].forEach(function (eventName) { canvas.addEventListener(eventName, function () { viewer.dragging = false; }); });
    canvas.addEventListener('wheel', function (event) { event.preventDefault(); viewer.zoom = Math.max(0.25, Math.min(8, viewer.zoom * Math.exp(-event.deltaY * 0.001))); draw(viewer); }, { passive: false });
    if (global.addEventListener) global.addEventListener('resize', function () { if (!viewer.overlay.classList.contains('hidden')) draw(viewer); });
    return viewer;
  }

  function rotatePoint(viewer, point) {
    var cy = Math.cos(viewer.yaw), sy = Math.sin(viewer.yaw), cp = Math.cos(viewer.pitch), sp = Math.sin(viewer.pitch);
    var x = point.x * cy - point.z * sy, z = point.x * sy + point.z * cy;
    return { x: x, y: point.y * cp - z * sp, z: point.y * sp + z * cp };
  }

  function draw(viewer) {
    if (!viewer || !viewer.structure) return;
    var canvas = viewer.canvas, ctx = viewer.ctx;
    var rect = canvas.getBoundingClientRect ? canvas.getBoundingClientRect() : { width: 760, height: 460 };
    var width = Math.max(260, Math.floor(rect.width || canvas.clientWidth || 760));
    var height = Math.max(240, Math.floor(rect.height || canvas.clientHeight || 460));
    var dpr = global.devicePixelRatio || 1;
    if (canvas.width !== Math.floor(width * dpr) || canvas.height !== Math.floor(height * dpr)) {
      canvas.width = Math.floor(width * dpr); canvas.height = Math.floor(height * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = '#08101f'; ctx.fillRect(0, 0, width, height);
    var atoms = viewer.structure.atoms, fitPoints = atoms.map(function (atom) { return { x: atom.x, y: atom.y, z: atom.z }; });
    if (viewer.structure.cell) {
      var fitCell = viewer.structure.cell;
      for (var fitMask = 0; fitMask < 8; fitMask += 1) fitPoints.push({
        x: (fitMask & 1 ? fitCell[0][0] : 0) + (fitMask & 2 ? fitCell[1][0] : 0) + (fitMask & 4 ? fitCell[2][0] : 0),
        y: (fitMask & 1 ? fitCell[0][1] : 0) + (fitMask & 2 ? fitCell[1][1] : 0) + (fitMask & 4 ? fitCell[2][1] : 0),
        z: (fitMask & 1 ? fitCell[0][2] : 0) + (fitMask & 2 ? fitCell[1][2] : 0) + (fitMask & 4 ? fitCell[2][2] : 0),
      });
    }
    var bounds = fitPoints.reduce(function (acc, point) { acc.minX = Math.min(acc.minX, point.x); acc.maxX = Math.max(acc.maxX, point.x); acc.minY = Math.min(acc.minY, point.y); acc.maxY = Math.max(acc.maxY, point.y); acc.minZ = Math.min(acc.minZ, point.z); acc.maxZ = Math.max(acc.maxZ, point.z); return acc; }, { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity, minZ: Infinity, maxZ: -Infinity });
    var center = { x: (bounds.minX + bounds.maxX) / 2, y: (bounds.minY + bounds.maxY) / 2, z: (bounds.minZ + bounds.maxZ) / 2 };
    var rotatedCenter = rotatePoint(viewer, center), radius = 1;
    fitPoints.forEach(function (point) { radius = Math.max(radius, Math.hypot(point.x - center.x, point.y - center.y, point.z - center.z)); });
    var scale = Math.min(width, height) * 0.38 / radius * viewer.zoom;
    function project(point) { var rotated = rotatePoint(viewer, point); return { x: width / 2 + (rotated.x - rotatedCenter.x) * scale, y: height / 2 - (rotated.y - rotatedCenter.y) * scale, z: rotated.z }; }
    var projected = atoms.map(project);

    if (viewer.structure.cell) {
      var cell = viewer.structure.cell, corners = [];
      for (var mask = 0; mask < 8; mask += 1) {
        corners.push(project({
          x: (mask & 1 ? cell[0][0] : 0) + (mask & 2 ? cell[1][0] : 0) + (mask & 4 ? cell[2][0] : 0),
          y: (mask & 1 ? cell[0][1] : 0) + (mask & 2 ? cell[1][1] : 0) + (mask & 4 ? cell[2][1] : 0),
          z: (mask & 1 ? cell[0][2] : 0) + (mask & 2 ? cell[1][2] : 0) + (mask & 4 ? cell[2][2] : 0),
        }));
      }
      ctx.save(); ctx.strokeStyle = 'rgba(154,185,255,.38)'; ctx.lineWidth = 1;
      for (var edge = 0; edge < 8; edge += 1) for (var bit = 0; bit < 3; bit += 1) if (!(edge & (1 << bit))) { var target = edge | (1 << bit); ctx.beginPath(); ctx.moveTo(corners[edge].x, corners[edge].y); ctx.lineTo(corners[target].x, corners[target].y); ctx.stroke(); }
      ctx.restore();
    }

    viewer.structure.bonds.map(function (pair) { return [projected[pair[0]], projected[pair[1]]]; }).filter(function (pair) { return pair[0] && pair[1]; }).sort(function (a, b) { return a[0].z + a[1].z - b[0].z - b[1].z; }).forEach(function (pair) {
      ctx.save(); ctx.lineCap = 'round'; ctx.lineWidth = Math.max(2, Math.min(10, scale * 0.08)); ctx.strokeStyle = 'rgba(211,221,238,.68)'; ctx.beginPath(); ctx.moveTo(pair[0].x, pair[0].y); ctx.lineTo(pair[1].x, pair[1].y); ctx.stroke(); ctx.restore();
    });
    projected.map(function (point, index) { return { point: point, atom: atoms[index] }; }).sort(function (a, b) { return a.point.z - b.point.z; }).forEach(function (entry) {
      var point = entry.point, atom = entry.atom, atomRadius = Math.max(4, Math.min(24, scale * (COVALENT_RADII[atom.element] || 0.77) * 0.30));
      var gradient = ctx.createRadialGradient(point.x - atomRadius * 0.35, point.y - atomRadius * 0.4, atomRadius * 0.1, point.x, point.y, atomRadius);
      gradient.addColorStop(0, '#ffffff'); gradient.addColorStop(0.18, colorForElement(atom.element)); gradient.addColorStop(1, 'rgba(0,0,0,.58)');
      ctx.fillStyle = gradient; ctx.beginPath(); ctx.arc(point.x, point.y, atomRadius, 0, Math.PI * 2); ctx.fill(); ctx.strokeStyle = 'rgba(255,255,255,.46)'; ctx.lineWidth = 1; ctx.stroke();
      if (viewer.labels) { ctx.fillStyle = '#f4f7ff'; ctx.font = '11px system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.fillText(atom.label || atom.element, point.x, point.y - atomRadius - 4); }
    });
  }

  function open(options) {
    options = options || {};
    var viewer = ensureViewer(global.document);
    if (!viewer) return false;
    var structure = options.structure;
    try {
      if (typeof structure === 'string') structure = parse(structure, options.name || options.filename || '');
    } catch (error) {
      var failed = viewer.overlay.querySelector('#structure-preview-error');
      failed.textContent = error.message || String(error); failed.classList.remove('hidden');
      viewer.overlay.classList.remove('hidden'); viewer.overlay.setAttribute('aria-hidden', 'false');
      return false;
    }
    if (!structure || !structure.atoms || !structure.atoms.length) return false;
    viewer.structure = structure; viewer.name = String(options.name || 'Structure'); viewer.yaw = -0.55; viewer.pitch = 0.35; viewer.zoom = 1;
    viewer.overlay.querySelector('#structure-preview-title').textContent = viewer.name;
    viewer.overlay.querySelector('#structure-preview-subtitle').textContent = String(options.source || (structure.format.toUpperCase() + ' structure'));
    viewer.overlay.querySelector('#structure-preview-status').textContent = structure.atoms.length + ' atoms / ' + structure.bonds.length + ' bonds';
    viewer.overlay.querySelector('#structure-preview-cell-label').textContent = structure.cell ? 'Unit cell shown' : '';
    viewer.overlay.querySelector('#structure-preview-error').classList.add('hidden');
    viewer.overlay.classList.remove('hidden'); viewer.overlay.setAttribute('aria-hidden', 'false'); activeViewer = viewer; draw(viewer);
    viewer.overlay.querySelector('#structure-preview-close-button').focus(); return true;
  }
  function close() {
    if (!activeViewer) return;
    activeViewer.overlay.classList.add('hidden'); activeViewer.overlay.setAttribute('aria-hidden', 'true'); activeViewer = null;
  }
  async function openFromUrl(options) {
    options = options || {};
    var response = await fetch(options.url, { credentials: 'same-origin' });
    if (!response.ok) throw new Error('Unable to load ' + (options.name || 'structure file') + ' (' + response.status + ').');
    var length = Number(response.headers.get('content-length') || 0);
    if (length > MAX_SOURCE_BYTES) throw new Error('Structure file is too large to preview.');
    var text = await response.text(); return open(Object.assign({}, options, { structure: text }));
  }

  var api = { SUPPORTED_EXTENSIONS: SUPPORTED_EXTENSIONS, ELEMENT_COLORS: ELEMENT_COLORS, MAX_SOURCE_BYTES: MAX_SOURCE_BYTES, isSupportedFile: isSupportedFile, normalizeElement: normalizeElement, colorForElement: colorForElement, inferBonds: inferBonds, parse: parse, parseXYZ: parseXYZ, parsePdb: parsePdb, parseXsf: parseXsf, parseCif: parseCif, parseVasp: parseVasp, open: open, openFromUrl: openFromUrl, close: close };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.RemoteCodexStructurePreview = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
