(function attachProteinStructureViewer(global) {
  'use strict';

  var libraryPromise = null;

  function loadLibrary() {
    if (global.NGL && global.NGL.Stage) return Promise.resolve(global.NGL);
    if (libraryPromise) return libraryPromise;
    libraryPromise = new Promise(function (resolve, reject) {
      var script = global.document.createElement('script');
      script.src = '/vendor/ngl-2.5.0.js';
      script.async = true;
      script.onload = function () {
        if (global.NGL && global.NGL.Stage) resolve(global.NGL);
        else reject(new Error('Protein renderer did not initialize.'));
      };
      script.onerror = function () { reject(new Error('Protein renderer could not be loaded.')); };
      global.document.head.appendChild(script);
    }).catch(function (error) { libraryPromise = null; throw error; });
    return libraryPromise;
  }

  async function create(container, pdbText) {
    var NGL = await loadLibrary();
    var stage = new NGL.Stage(container, { backgroundColor: '#08101f', quality: 'medium' });
    var component;
    try {
      component = await stage.loadFile(new Blob([pdbText], { type: 'text/plain' }), { ext: 'pdb', defaultRepresentation: false });
      if (!component) throw new Error('The protein structure could not be loaded.');
    } catch (error) {
      stage.dispose();
      throw error;
    }
    return {
      show: function (mode, labels) {
        component.removeAllRepresentations();
        if (mode === 'cartoon') {
          component.addRepresentation('cartoon', { sele: 'protein', colorScheme: 'sstruc', quality: 'medium' });
          component.addRepresentation('ball+stick', { sele: 'not protein', colorScheme: 'element', scale: 0.45 });
        } else if (mode === 'wire') {
          component.addRepresentation('line', { colorScheme: 'element', linewidth: 1.5 });
        } else {
          component.addRepresentation('ball+stick', { colorScheme: 'element', scale: 0.45 });
        }
        if (labels) component.addRepresentation('label', {
          sele: mode === 'cartoon' || component.structure.atomCount > 1500 ? 'protein and .CA' : 'all',
          labelType: mode === 'cartoon' ? 'resname' : 'atomname',
          color: '#f4f7ff', scale: 0.65,
        });
        stage.handleResize();
      },
      fit: function () { component.autoView(); },
      resize: function () { stage.handleResize(); },
      dispose: function () { stage.dispose(); },
    };
  }

  var api = { loadLibrary: loadLibrary, create: create };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.RemoteCodexProteinStructureViewer = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
