# Periodic structure preview (8897)

Open **View structure** for a CIF, XSF, or VASP/POSCAR/CONTCAR containing a valid unit cell. The periodic viewer provides **Ball-stick**, **Wireframe**, and **Polyhedra** modes. Choose the central element, coordinating element, and distance cutoff for coordination polyhedra. **Fit** resets the view; dragging rotates around the displayed cell and its neighboring images. XYZ files use the existing molecular viewer; extended-XYZ lattice metadata is not parsed.

The geometry module wraps positions into the unit cell, uses reciprocal cell spacing to search neighboring images (including skewed and short cells), and includes images needed to complete boundary bonds and polyhedra. In-cell bonds are drawn once. A polyhedron requires at least four non-coplanar neighbors within the selected cutoff; this is a geometric coordination preview, not a bond-order or oxidation-state calculation. Distance-inferred bonds are heuristic.

PDB/PBD proteins retain their molecular rotation center and cartoon/ball-stick/wireframe renderer. Their CRYST1 box does not cause periodic image expansion. CIF files with explicit standard linear symmetry operations are expanded and equivalent sites are deduplicated. Unsupported symmetry expressions report an error instead of silently dropping sites. Space-group names alone are not used to infer symmetry; export an expanded P1 CIF or POSCAR when necessary.

The two new modules, `crystal-geometry.js` and `crystal-structure-viewer.js`, are independent of `app.js`. Three.js is pinned to 0.158.0 and served locally through the vendor build. Switching display modes reuses geometry; cutoff changes are debounced. Closing or replacing the preview releases WebGL resources and invalidates pending loads.

## Preview limits

- Confirmation is required above 1,250 periodic atoms (5,000 non-periodic atoms).
- Periodic geometry is limited to 20,000 input atoms, 400,000 candidate images, 5 million neighbor checks, and 100,000 bond segments.
- At most 256 closed coordination polyhedra are shown, with an explicit notice when more qualify. A cutoff yielding more than 128 neighbors is rejected with a request to reduce it; neighbors are not silently truncated.
- CIF symmetry expansion is limited to 2 million site/operation combinations and 50,000 expanded atoms.
- These are synchronous, bounded previews. Large scientific datasets should be reduced before viewing.

## Verification

Run `npm run test:structure-preview` for geometry, parser, and wiring checks, and `npm run test:structure-preview:browser` against isolated 8897 for desktop/mobile rendering checks. Coverage includes short and skewed cells, cross-boundary bonds, six- and fourteen-neighbor coordination, planar shells, symmetry expansion, PBD rotation, protein modes, large-file confirmation, and viewer asset loading. Browser screenshots are under `tmp/structure-preview-browser/`.

Validate changes on isolated 8897 first. Promote reviewed preview assets only after user acceptance and authorization; never copy development runtime state into 8797. This frontend-only update does not require restarting the Relay or Host Agents.
