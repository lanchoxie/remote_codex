(function attachCrystalStructureViewer(global) {
  'use strict';

  var libraryPromise = null;
  function loadLibrary() {
    if (!libraryPromise) {
      libraryPromise = Promise.all([
        import('/vendor/three/three.module.js'),
        import('/vendor/three/geometries/ConvexGeometry.js'),
        import('/vendor/three/OrbitControls.js'),
      ]).then(function (modules) {
        return { THREE: modules[0], ConvexGeometry: modules[1].ConvexGeometry, OrbitControls: modules[2].OrbitControls };
      }).catch(function (error) { libraryPromise = null; throw error; });
    }
    return libraryPromise;
  }

  async function create(container, structure) {
    var library = await loadLibrary();
    var THREE = library.THREE;
    var scene = new THREE.Scene();
    scene.background = new THREE.Color('#08101f');
    scene.add(new THREE.AmbientLight(0xffffff, 1.4));
    var light = new THREE.DirectionalLight(0xffffff, 2.2);
    light.position.set(5, 9, 12);
    scene.add(light);
    var camera = new THREE.PerspectiveCamera(50, 1, 0.01, 10000);
    var renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'default' });
    renderer.setPixelRatio(Math.min(global.devicePixelRatio || 1, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    container.appendChild(renderer.domElement);
    var controls = new library.OrbitControls(camera, renderer.domElement);
    controls.enableDamping = false;
    controls.addEventListener('change', render);
    var group = new THREE.Group();
    scene.add(group);
    var currentModel = null;
    var currentOptions = '';
    var currentMode = 'atoms';
    var disposed = false;

    function render() { if (!disposed) renderer.render(scene, camera); }
    function resize() {
      if (disposed) return;
      var width = Math.max(260, container.clientWidth || 760);
      var height = Math.max(240, container.clientHeight || 460);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      renderer.setSize(width, height);
      render();
    }
    function clearGroup() {
      group.traverse(function (object) {
        if (object === group) return;
        if (object.geometry) object.geometry.dispose();
        if (object.material) {
          (Array.isArray(object.material) ? object.material : [object.material]).forEach(function (material) { material.dispose(); });
        }
      });
      group.clear();
    }
    function colorOf(element) {
      return global.RemoteCodexStructurePreview.colorForElement(element);
    }
    function addCell(model) {
      var points = [];
      for (var mask = 0; mask < 8; mask += 1) for (var bit = 0; bit < 3; bit += 1) {
        if (mask & (1 << bit)) continue;
        points.push(new THREE.Vector3(...model.corners[mask]));
        points.push(new THREE.Vector3(...model.corners[mask | (1 << bit)]));
      }
      group.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(points),
        new THREE.LineBasicMaterial({ color: '#91a5ba', transparent: true, opacity: 0.65 })));
    }
    function addAtoms(model, mode) {
      var entries = new Map();
      var polyhedronAtoms = new Set();
      if (mode === 'polyhedra') model.polyhedra.forEach(function (polyhedron) {
        polyhedronAtoms.add(polyhedron.center);
        polyhedron.renderIndices.forEach(function (index) { polyhedronAtoms.add(index); });
      });
      model.renderAtoms.forEach(function (atom, index) {
        if (mode === 'polyhedra' && !polyhedronAtoms.has(index)) return;
        var key = atom.element + (atom.imageOf == null ? ':base' : ':image');
        var list = entries.get(key) || [];
        list.push({ atom: atom, index: index });
        entries.set(key, list);
      });
      entries.forEach(function (list) {
        var element = list[0].atom.element;
        var image = list[0].atom.imageOf != null;
        var material = new THREE.MeshPhongMaterial({
          color: colorOf(element), shininess: 70, transparent: image, opacity: image ? 0.58 : 1,
        });
        var mesh = new THREE.InstancedMesh(new THREE.SphereGeometry(1, 14, 10), material, list.length);
        var matrix = new THREE.Matrix4();
        list.forEach(function (entry, index) {
          var radius = mode === 'wire' ? 0.095 : mode === 'polyhedra' ? 0.15 : 0.29;
          if (entry.atom.element === 'H') radius *= 0.68;
          matrix.compose(new THREE.Vector3(entry.atom.x, entry.atom.y, entry.atom.z),
            new THREE.Quaternion(), new THREE.Vector3(radius, radius, radius));
          mesh.setMatrixAt(index, matrix);
        });
        mesh.instanceMatrix.needsUpdate = true;
        group.add(mesh);
      });
    }
    function addBonds(model, mode) {
      if (!model.bonds.length) return;
      if (mode === 'wire') {
        var positions = [], colors = [];
        model.bonds.forEach(function (bond) {
          var a = model.renderAtoms[bond.from], b = model.renderAtoms[bond.to];
          positions.push(a.x, a.y, a.z, b.x, b.y, b.z);
          var first = new THREE.Color(colorOf(a.element)), second = new THREE.Color(colorOf(b.element));
          colors.push(first.r, first.g, first.b, second.r, second.g, second.b);
        });
        var geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
        geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
        group.add(new THREE.LineSegments(geometry, new THREE.LineBasicMaterial({ vertexColors: true })));
        return;
      }
      var cylinder = new THREE.InstancedMesh(new THREE.CylinderGeometry(1, 1, 1, 8),
        new THREE.MeshPhongMaterial({ color: '#b9c4cd', shininess: 45 }), model.bonds.length);
      var up = new THREE.Vector3(0, 1, 0), matrix = new THREE.Matrix4();
      model.bonds.forEach(function (bond, index) {
        var a = model.renderAtoms[bond.from], b = model.renderAtoms[bond.to];
        var start = new THREE.Vector3(a.x, a.y, a.z), end = new THREE.Vector3(b.x, b.y, b.z);
        var delta = end.clone().sub(start);
        matrix.compose(start.add(end).multiplyScalar(0.5), new THREE.Quaternion().setFromUnitVectors(up, delta.clone().normalize()),
          new THREE.Vector3(0.075, delta.length(), 0.075));
        cylinder.setMatrixAt(index, matrix);
      });
      cylinder.instanceMatrix.needsUpdate = true;
      group.add(cylinder);
    }
    function addPolyhedra(model) {
      model.polyhedra.forEach(function (polyhedron) {
        var points = polyhedron.vertices.map(function (point) { return new THREE.Vector3(...point); });
        try {
          var geometry = new library.ConvexGeometry(points);
          var color = colorOf(model.centerElement);
          group.add(new THREE.Mesh(geometry, new THREE.MeshPhongMaterial({
            color: color, side: THREE.DoubleSide, transparent: true, opacity: 0.38,
            depthWrite: false, shininess: 40,
          })));
          group.add(new THREE.LineSegments(new THREE.EdgesGeometry(geometry),
            new THREE.LineBasicMaterial({ color: color, transparent: true, opacity: 0.9 })));
        } catch (_) {
          // A planar coordination shell has no closed polyhedral volume.
        }
      });
    }
    function fit(model, preserveOrientation) {
      var bounds = new THREE.Box3();
      model.corners.forEach(function (point) { bounds.expandByPoint(new THREE.Vector3(...point)); });
      if (currentMode === 'polyhedra') {
        model.polyhedra.forEach(function (polyhedron) {
          polyhedron.vertices.forEach(function (point) { bounds.expandByPoint(new THREE.Vector3(...point)); });
        });
      } else {
        model.renderAtoms.forEach(function (atom) { bounds.expandByPoint(new THREE.Vector3(atom.x, atom.y, atom.z)); });
      }
      var center = bounds.getCenter(new THREE.Vector3());
      var radius = Math.max(1, bounds.getSize(new THREE.Vector3()).length() * 0.5);
      group.position.copy(center).multiplyScalar(-1);
      var verticalHalfAngle = THREE.MathUtils.degToRad(camera.fov * 0.5);
      var horizontalHalfAngle = Math.atan(Math.tan(verticalHalfAngle) * camera.aspect);
      var distance = radius * 1.15 / Math.sin(Math.min(verticalHalfAngle, horizontalHalfAngle));
      var direction = preserveOrientation && camera.position.length() > 0
        ? camera.position.clone().normalize() : new THREE.Vector3(1.15, 0.75, 1.9).normalize();
      camera.position.copy(direction).multiplyScalar(distance);
      camera.near = Math.max(0.01, radius / 1000);
      camera.far = Math.max(100, radius * 20);
      camera.updateProjectionMatrix();
      controls.target.set(0, 0, 0);
      controls.update();
      render();
    }
    function show(mode, options) {
      if (disposed) return null;
      var optionsKey = JSON.stringify(options || {});
      var model = currentModel && currentOptions === optionsKey
        ? currentModel : global.RemoteCodexCrystalGeometry.build(structure, options);
      var alreadyFitted = Boolean(currentModel);
      clearGroup();
      addCell(model);
      if (mode === 'polyhedra') addPolyhedra(model);
      else addBonds(model, mode);
      addAtoms(model, mode);
      currentModel = model;
      currentOptions = optionsKey;
      currentMode = mode;
      resize();
      if (alreadyFitted) fit(model, true);
      return model;
    }
    function dispose() {
      if (disposed) return;
      controls.removeEventListener('change', render);
      controls.dispose();
      clearGroup();
      renderer.dispose();
      renderer.forceContextLoss();
      renderer.domElement.remove();
      disposed = true;
    }
    resize();
    return { show: show, fit: function () { if (currentModel) fit(currentModel, false); }, resize: resize,
      render: render, dispose: dispose, get model() { return currentModel; } };
  }

  var api = { create: create, loadLibrary: loadLibrary };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.RemoteCodexCrystalStructureViewer = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
