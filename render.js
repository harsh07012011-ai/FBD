/* ==========================================================================
   APEX FBD — render.js
   Owns: the Three.js scene, camera, lights, the requestAnimationFrame loop
   (which also drives physics stepping), mesh <-> Cannon body syncing, force
   vector arrows, object picking/selection, sensor drop targets, the sketch
   extrusion tool, camera presets, and canvas video export.
   ========================================================================== */

(function () {
  'use strict';

  window.ApexFBD = window.ApexFBD || {};
  const FBD = window.ApexFBD;
  const emit = (name, detail) => document.dispatchEvent(new CustomEvent(name, { detail: detail || {} }));
  const on = (el, ev, fn, opts) => el && el.addEventListener(ev, fn, opts);

  document.addEventListener('DOMContentLoaded', init);

  function init() {
    /* ============================================================
       SCENE / CAMERA / RENDERER
    ============================================================ */
    const canvas = document.getElementById('scene-canvas');
    const wrap = document.getElementById('three-canvas-wrap');
    const scene = new THREE.Scene();

    const camera = new THREE.PerspectiveCamera(50, 1, 0.05, 500);
    camera.position.set(9, 7, 9);
    camera.lookAt(0, 1, 0);

    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    const controls = new THREE.OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.target.set(0, 1.5, 0);
    controls.minDistance = 2;
    controls.maxDistance = 60;

    // CSS2D label layer
    const labelRenderer = new THREE.CSS2DRenderer();
    labelRenderer.domElement.style.position = 'absolute';
    labelRenderer.domElement.style.top = '0';
    labelRenderer.domElement.style.left = '0';
    labelRenderer.domElement.style.pointerEvents = 'none';
    document.getElementById('css2d-overlay').appendChild(labelRenderer.domElement);

    function resize() {
      const w = wrap.clientWidth;
      const h = wrap.clientHeight;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
      labelRenderer.setSize(w, h);
    }
    window.addEventListener('resize', resize);
    resize();

    /* ============================================================
       LIGHTS
    ============================================================ */
    const hemi = new THREE.HemisphereLight(0xffffff, 0xcdd7e8, 0.65);
    scene.add(hemi);

    const key = new THREE.DirectionalLight(0xffffff, 0.9);
    key.position.set(8, 12, 6);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    key.shadow.camera.left = -15;
    key.shadow.camera.right = 15;
    key.shadow.camera.top = 15;
    key.shadow.camera.bottom = -15;
    scene.add(key);

    const fill = new THREE.DirectionalLight(0xaecbff, 0.25);
    fill.position.set(-6, 4, -8);
    scene.add(fill);

    /* ============================================================
       ENGINEERING GRID + GROUND + AXES
    ============================================================ */
    const gridGroup = new THREE.Group();

    const grid = new THREE.GridHelper(40, 80, 0x9aafcf, 0xd6dee9);
    grid.position.y = 0.001;
    gridGroup.add(grid);

    const groundGeo = new THREE.PlaneGeometry(40, 40);
    const groundMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.95, metalness: 0 });
    const groundMesh = new THREE.Mesh(groundGeo, groundMat);
    groundMesh.rotation.x = -Math.PI / 2;
    groundMesh.receiveShadow = true;
    gridGroup.add(groundMesh);

    const axes = new THREE.AxesHelper(2.2);
    gridGroup.add(axes);

    scene.add(gridGroup);

    /* ============================================================
       MESH REGISTRY + GEOMETRY FACTORIES
    ============================================================ */
    const meshes = new Map(); // bodyId -> { mesh, arrow, label, outline }
    let selectedId = null;

    const materialFor = (type) => {
      const palette = {
        block: 0x2f6fed,
        cube: 0x2f6fed,
        sphere: 0xf79009,
        cylinder: 0x0086c9,
        cone: 0xdc6803,
        pyramid: 0xb54708,
        prism: 0x6941c6,
        circle: 0xf79009,
        rectangle: 0x2f6fed,
        'triangle-2d': 0xb54708,
        polygon: 0x0086c9,
        'point-mass': 0x7f56d9,
        rod: 0x475467,
        pulley: 0x475467,
        spring: 0x12b76a,
        particle: 0x7f56d9,
        sketch: 0x2f6fed,
      };
      return new THREE.MeshStandardMaterial({
        color: palette[type] || 0x2f6fed,
        roughness: 0.35,
        metalness: 0.08,
      });
    };

    function flatShapeGeometry(pathFn, depth) {
      // Shared helper for the thin extruded 2D shapes (rectangle uses BoxGeometry
      // directly; triangle/polygon go through THREE.Shape like the sketch tool).
      const shape = pathFn();
      const geo = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false });
      geo.center();
      return geo;
    }

    function geometryFor(type, size) {
      switch (type) {
        // ---------------- 3D solids ----------------
        case 'sphere':
          return new THREE.SphereGeometry(Math.max(size.x, 0.1) / 2, 32, 24);
        case 'cylinder':
          return new THREE.CylinderGeometry(Math.max(size.x, 0.1) / 2, Math.max(size.x, 0.1) / 2, size.y, 24);
        case 'cone':
          return new THREE.ConeGeometry(Math.max(size.x, 0.1) / 2, size.y, 24);
        case 'pyramid':
          // Square-based pyramid: 4-sided cone rotated so a flat face points forward.
          return new THREE.ConeGeometry(Math.max(size.x, 0.1) / Math.SQRT2, size.y, 4).rotateY(Math.PI / 4);
        case 'prism': {
          // Triangular prism: right-triangle cross-section extruded along Z by size.z.
          const base = Math.max(size.x, 0.1);
          const height = Math.max(size.y, 0.1);
          const tri = new THREE.Shape();
          tri.moveTo(-base / 2, -height / 2);
          tri.lineTo(base / 2, -height / 2);
          tri.lineTo(0, height / 2);
          tri.closePath();
          return flatShapeGeometry(() => tri, Math.max(size.z, 0.1));
        }

        // ---------------- 2D flat shapes (thin extrusion) ----------------
        case 'circle':
          return new THREE.CylinderGeometry(Math.max(size.x, 0.1) / 2, Math.max(size.x, 0.1) / 2, 0.05, 32).rotateX(Math.PI / 2);
        case 'rectangle':
          return new THREE.BoxGeometry(Math.max(size.x, 0.1), Math.max(size.y, 0.1), 0.05);
        case 'triangle-2d': {
          const base = Math.max(size.x, 0.1);
          const height = Math.max(size.y, 0.1);
          const tri = new THREE.Shape();
          tri.moveTo(-base / 2, -height / 2);
          tri.lineTo(base / 2, -height / 2);
          tri.lineTo(0, height / 2);
          tri.closePath();
          return flatShapeGeometry(() => tri, 0.05);
        }
        case 'polygon': {
          const sides = Math.min(12, Math.max(3, Math.round(size.y) || 6));
          return new THREE.CylinderGeometry(Math.max(size.x, 0.1) / 2, Math.max(size.x, 0.1) / 2, 0.05, sides).rotateX(Math.PI / 2);
        }

        // ---------------- 1D shapes ----------------
        case 'point-mass':
          return new THREE.SphereGeometry(0.08, 16, 12);
        case 'rod': {
          const thickness = Math.max(size.y, 0.05);
          return new THREE.BoxGeometry(Math.max(size.x, 0.1), thickness, thickness);
        }

        // ---------------- existing utility types ----------------
        case 'particle':
          return new THREE.SphereGeometry(0.08, 16, 12);
        case 'pulley':
          return new THREE.CylinderGeometry(size.x / 2, size.x / 2, 0.2, 24);
        case 'spring':
          return new THREE.BoxGeometry(0.1, size.y, 0.1);
        case 'sketch':
        case 'cube':
        case 'block':
        default:
          return new THREE.BoxGeometry(size.x, size.y, size.z);
      }
    }

    function makeLabel(text) {
      const div = document.createElement('div');
      div.textContent = text;
      div.style.cssText = `
        font: 600 11px 'Inter', sans-serif; color: #101828; background: rgba(255,255,255,0.85);
        padding: 2px 6px; border-radius: 6px; border: 1px solid #E4E7EC; white-space: nowrap;
        transform: translateY(-140%);
      `;
      return new THREE.CSS2DObject(div);
    }

    document.addEventListener('apexfbd:bodyadded', (e) => {
      const { id, type, label, size, position, quaternion, isStatic } = e.detail;
      const geometry = geometryFor(type, size);
      const material = materialFor(type);
      const mesh = new THREE.Mesh(geometry, material);
      mesh.castShadow = !isStatic;
      mesh.receiveShadow = true;
      mesh.position.set(position.x, position.y, position.z);
      mesh.quaternion.set(quaternion.x, quaternion.y, quaternion.z, quaternion.w);
      mesh.userData.bodyId = id;
      scene.add(mesh);

      const label3d = makeLabel(label);
      mesh.add(label3d);
      label3d.visible = labelsVisible;

      meshes.set(id, { mesh, arrow: null, label: label3d, type, size });
    });

    document.addEventListener('apexfbd:bodyremoved', (e) => {
      const entry = meshes.get(e.detail.id);
      if (!entry) return;
      scene.remove(entry.mesh);
      if (entry.arrow) scene.remove(entry.arrow);
      entry.mesh.geometry.dispose();
      entry.mesh.material.dispose();
      meshes.delete(e.detail.id);
      if (selectedId === e.detail.id) deselect();
    });

    document.addEventListener('apexfbd:clearscene', () => {
      meshes.forEach((entry) => {
        scene.remove(entry.mesh);
        if (entry.arrow) scene.remove(entry.arrow);
      });
      meshes.clear();
      deselect();
    });

    /* ============================================================
       FORCE VECTOR ARROWS
    ============================================================ */
    let vectorsVisible = true;
    const forceArrows = new Map(); // forceId -> { arrow, bodyId }

    document.addEventListener('apexfbd:forceapply', (e) => {
      const { forceId, targetId, vector, continuous } = e.detail;
      const entry = meshes.get(targetId);
      if (!entry) return;
      const mag = Math.hypot(vector.x, vector.y, vector.z) || 0.001;
      const dir = new THREE.Vector3(vector.x, vector.y, vector.z).normalize();
      const length = Math.min(Math.max(mag / 8, 0.6), 4);
      const arrow = new THREE.ArrowHelper(dir, entry.mesh.position, length, 0xf79009, length * 0.25, length * 0.15);
      arrow.visible = vectorsVisible;
      scene.add(arrow);

      if (continuous) {
        if (forceArrows.has(forceId)) scene.remove(forceArrows.get(forceId).arrow);
        forceArrows.set(forceId, { arrow, bodyId: targetId });
      } else {
        // One-shot force: show the kick briefly, then fade it out.
        setTimeout(() => scene.remove(arrow), 500);
      }
    });

    document.addEventListener('apexfbd:forceclear', (e) => {
      const entry = forceArrows.get(e.detail.forceId);
      if (entry) { scene.remove(entry.arrow); forceArrows.delete(e.detail.forceId); }
    });

    /* ============================================================
       TOGGLES: grid / vectors / labels, dimension, camera presets
    ============================================================ */
    let labelsVisible = true;

    document.addEventListener('apexfbd:togglegrid', (e) => { gridGroup.visible = e.detail.visible; });
    document.addEventListener('apexfbd:togglevectors', (e) => {
      vectorsVisible = e.detail.visible;
      forceArrows.forEach((f) => { f.arrow.visible = vectorsVisible; });
    });
    document.addEventListener('apexfbd:togglelabels', (e) => {
      labelsVisible = e.detail.visible;
      meshes.forEach((entry) => { entry.label.visible = labelsVisible; });
    });

    document.addEventListener('apexfbd:dimensionchange', (e) => {
      const dim = e.detail.dimension;
      controls.enableRotate = dim === '3d';
      if (dim === '1d') {
        camera.position.set(0, 2.2, 14);
        controls.target.set(0, 1, 0);
      } else if (dim === '2d') {
        camera.position.set(0, 4, 16);
        controls.target.set(0, 2, 0);
      } else {
        camera.position.set(9, 7, 9);
        controls.target.set(0, 1.5, 0);
      }
      controls.update();
    });

    document.addEventListener('apexfbd:camerapreset', (e) => {
      const d = controls.target.distanceTo(camera.position) || 12;
      if (e.detail.preset === 'front') camera.position.set(controls.target.x, controls.target.y, controls.target.z + d);
      if (e.detail.preset === 'top') camera.position.set(controls.target.x, controls.target.y + d, controls.target.z + 0.001);
      if (e.detail.preset === 'iso') camera.position.set(controls.target.x + d * 0.6, controls.target.y + d * 0.5, controls.target.z + d * 0.6);
      controls.update();
    });

    /* ============================================================
       PICKING (select objects, drop sensors)
    ============================================================ */
    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();

    function pointerFromEvent(evt) {
      const rect = renderer.domElement.getBoundingClientRect();
      pointer.x = ((evt.clientX - rect.left) / rect.width) * 2 - 1;
      pointer.y = -((evt.clientY - rect.top) / rect.height) * 2 + 1;
    }

    function pickMesh(evt) {
      pointerFromEvent(evt);
      raycaster.setFromCamera(pointer, camera);
      const meshList = [...meshes.values()].map((m) => m.mesh);
      const hits = raycaster.intersectObjects(meshList, false);
      return hits.length ? hits[0].object : null;
    }

    on(renderer.domElement, 'click', (evt) => {
      const hit = pickMesh(evt);
      if (hit) select(hit.userData.bodyId); else deselect();
    });

    function select(bodyId) {
      deselect();
      const entry = meshes.get(bodyId);
      if (!entry) return;
      selectedId = bodyId;
      entry.outline = new THREE.BoxHelper(entry.mesh, 0x2f6fed);
      scene.add(entry.outline);
      const meta = FBD.physics.getBodyMeta(bodyId);
      if (meta) FBD.showInspector({ ...meta, id: bodyId });
      const readout = document.getElementById('selected-readout');
      if (readout) readout.textContent = meta ? meta.label : 'Selected';
    }
    function deselect() {
      if (selectedId) {
        const entry = meshes.get(selectedId);
        if (entry && entry.outline) { scene.remove(entry.outline); entry.outline = null; }
      }
      selectedId = null;
      FBD.hideInspector && FBD.hideInspector();
      const readout = document.getElementById('selected-readout');
      if (readout) readout.textContent = 'No selection';
    }
    document.getElementById('inspector-close')?.addEventListener('click', deselect);
    document.getElementById('insp-delete')?.addEventListener('click', () => { selectedId = null; });

    // Sensor drag-and-drop from the sidebar onto a mesh
    on(renderer.domElement, 'dragover', (evt) => evt.preventDefault());
    on(renderer.domElement, 'drop', (evt) => {
      evt.preventDefault();
      const sensorType = evt.dataTransfer.getData('text/apexfbd-sensor');
      if (!sensorType) return;
      const hit = pickMesh(evt);
      if (!hit) { FBD.toast && FBD.toast('Drop the sensor directly on an object', 'error'); return; }
      emit('apexfbd:sensordrop', { sensorType, targetId: hit.userData.bodyId });
      FBD.toast && FBD.toast('Sensor attached', 'success');
    });

    /* ============================================================
       SKETCH TOOL (2D freehand -> extruded 3D mesh)
    ============================================================ */
    function buildSketchModal() {
      const overlay = document.createElement('div');
      overlay.className = 'modal-overlay';
      overlay.hidden = true;
      overlay.innerHTML = `
        <div class="modal" style="width:420px;">
          <div class="modal-header">
            <h2>Sketch a Shape</h2>
            <button class="icon-btn icon-btn--sm" id="sketch-modal-close">&times;</button>
          </div>
          <div class="modal-body">
            <p class="hint-text">Click to place points around the shape's outline, then press Extrude. Double-click to close early.</p>
            <canvas id="sketch-canvas" width="380" height="280" style="width:100%;border:1px solid var(--border);border-radius:var(--r-md);background:var(--surface-alt);cursor:crosshair;"></canvas>
            <div style="display:flex;gap:8px;">
              <button class="btn btn--ghost btn--sm" id="sketch-clear">Clear</button>
              <button class="btn btn--primary btn--sm btn--block" id="sketch-extrude">Extrude &amp; Add to Scene</button>
            </div>
          </div>
        </div>
      `;
      document.body.appendChild(overlay);

      const canvas2d = overlay.querySelector('#sketch-canvas');
      const ctx = canvas2d.getContext('2d');
      let points = [];

      function redraw() {
        ctx.clearRect(0, 0, canvas2d.width, canvas2d.height);
        ctx.strokeStyle = '#2F6FED';
        ctx.fillStyle = 'rgba(47,111,237,0.12)';
        ctx.lineWidth = 2;
        if (points.length > 0) {
          ctx.beginPath();
          ctx.moveTo(points[0].x, points[0].y);
          points.slice(1).forEach((p) => ctx.lineTo(p.x, p.y));
          if (points.length > 2) ctx.closePath();
          ctx.stroke();
          if (points.length > 2) ctx.fill();
        }
        points.forEach((p) => {
          ctx.beginPath();
          ctx.arc(p.x, p.y, 3, 0, Math.PI * 2);
          ctx.fillStyle = '#2F6FED';
          ctx.fill();
        });
      }

      on(canvas2d, 'click', (evt) => {
        const rect = canvas2d.getBoundingClientRect();
        const x = ((evt.clientX - rect.left) / rect.width) * canvas2d.width;
        const y = ((evt.clientY - rect.top) / rect.height) * canvas2d.height;
        points.push({ x, y });
        redraw();
      });
      on(canvas2d, 'dblclick', (evt) => evt.preventDefault());
      on(overlay.querySelector('#sketch-clear'), 'click', () => { points = []; redraw(); });
      on(overlay.querySelector('#sketch-modal-close'), 'click', () => { overlay.hidden = true; });
      on(overlay, 'click', (e) => { if (e.target === overlay) overlay.hidden = true; });

      on(overlay.querySelector('#sketch-extrude'), 'click', () => {
        if (points.length < 3) { FBD.toast && FBD.toast('Add at least 3 points to form a shape', 'error'); return; }

        const scaleFactor = 0.01; // canvas px -> meters
        const cx = points.reduce((s, p) => s + p.x, 0) / points.length;
        const cy = points.reduce((s, p) => s + p.y, 0) / points.length;
        const shape = new THREE.Shape();
        points.forEach((p, i) => {
          const sx = (p.x - cx) * scaleFactor;
          const sy = -(p.y - cy) * scaleFactor;
          if (i === 0) shape.moveTo(sx, sy); else shape.lineTo(sx, sy);
        });
        shape.closePath();

        const depth = Number(document.getElementById('sketch-extrude-depth')?.value) || 1;
        const extrudeGeo = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false });
        extrudeGeo.computeBoundingBox();
        const bb = extrudeGeo.boundingBox;
        const size = {
          x: Math.max(bb.max.x - bb.min.x, 0.1),
          y: Math.max(bb.max.y - bb.min.y, 0.1),
          z: depth,
        };

        const spawnX = Number(document.getElementById('spawn-x')?.value) || 0;
        const spawnY = Number(document.getElementById('spawn-y')?.value) || 3;
        const spawnZ = Number(document.getElementById('spawn-z')?.value) || 0;
        const mass = Number(document.getElementById('spawn-mass')?.value) || 1;

        const id = FBD.physics.spawnObject({ type: 'sketch', position: { x: spawnX, y: spawnY, z: spawnZ }, size, mass });

        // Swap the auto-generated box mesh for the real extruded geometry.
        const entry = meshes.get(id);
        if (entry) {
          entry.mesh.geometry.dispose();
          extrudeGeo.center();
          entry.mesh.geometry = extrudeGeo;
        }

        overlay.hidden = true;
        points = [];
        redraw();
        FBD.toast && FBD.toast('Sketch extruded and added to scene', 'success');
      });

      return overlay;
    }
    const sketchModal = buildSketchModal();
    document.getElementById('btn-open-sketch')?.addEventListener('click', () => { sketchModal.hidden = false; });

    /* ============================================================
       VIDEO EXPORT (MediaRecorder on the canvas stream)
    ============================================================ */
    let mediaRecorder = null;
    let recordedChunks = [];

    function pickSupportedMime() {
      const candidates = ['video/mp4', 'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
      return candidates.find((m) => window.MediaRecorder && MediaRecorder.isTypeSupported(m)) || '';
    }

    function toggleRecording() {
      const btn = document.getElementById('btn-export-video');
      if (mediaRecorder && mediaRecorder.state === 'recording') {
        mediaRecorder.stop();
        return;
      }
      const mime = pickSupportedMime();
      if (!mime || !renderer.domElement.captureStream) {
        FBD.toast && FBD.toast('Video capture is not supported in this browser', 'error');
        return;
      }
      const stream = renderer.domElement.captureStream(30);
      recordedChunks = [];
      mediaRecorder = new MediaRecorder(stream, { mimeType: mime });
      mediaRecorder.ondataavailable = (e) => { if (e.data.size > 0) recordedChunks.push(e.data); };
      mediaRecorder.onstop = () => {
        const ext = mime.includes('mp4') ? 'mp4' : 'webm';
        const blob = new Blob(recordedChunks, { type: mime });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `apexfbd-recording-${Date.now()}.${ext}`;
        a.click();
        URL.revokeObjectURL(url);
        if (btn) btn.textContent = 'Export Video (.mp4)';
        FBD.toast && FBD.toast(
          ext === 'mp4' ? 'Video exported (.mp4)' : 'Video exported (.webm — this browser can\u2019t encode MP4 directly)',
          'success'
        );
      };
      mediaRecorder.start();
      if (btn) btn.textContent = 'Stop Recording…';
      FBD.toast && FBD.toast('Recording canvas — click Export again to stop', 'success');
    }
    document.getElementById('btn-export-video')?.addEventListener('click', toggleRecording);

    /* ============================================================
       ANIMATION LOOP
    ============================================================ */
    const clock = new THREE.Clock();
    let fpsAccum = 0;
    let fpsFrames = 0;

    function animate() {
      requestAnimationFrame(animate);
      const dt = Math.min(clock.getDelta(), 0.1);

      FBD.physics.step(dt);

      const transforms = FBD.physics.getTransforms();
      transforms.forEach((t) => {
        const entry = meshes.get(t.id);
        if (!entry) return;
        entry.mesh.position.set(t.position.x, t.position.y, t.position.z);
        entry.mesh.quaternion.set(t.quaternion.x, t.quaternion.y, t.quaternion.z, t.quaternion.w);
        if (entry.outline) entry.outline.update();
        const arrowEntry = [...forceArrows.values()].find((f) => f.bodyId === t.id);
        if (arrowEntry) arrowEntry.arrow.position.copy(entry.mesh.position);
      });

      controls.update();
      renderer.render(scene, camera);
      labelRenderer.render(scene, camera);

      fpsAccum += dt; fpsFrames += 1;
      if (fpsAccum >= 0.5) {
        FBD.setFPS && FBD.setFPS(fpsFrames / fpsAccum);
        fpsAccum = 0; fpsFrames = 0;
      }
    }
    animate();

    console.info('[ApexFBD] Renderer ready.');
  }
})();
