/* ==========================================================================
   APEX FBD — physics.js
   Owns: the Cannon.js World, the fixed-timestep sim loop's *state* (render.js
   drives requestAnimationFrame and calls ApexFBD.physics.step(dt) each
   frame), axis locking for 1D/2D/3D, object spawning, forces, environment,
   exam presets, sensors, and CSV export of sensor logs.

   Consumes events from main.js (see main.js header for the full list).
   Produces, for render.js:
     document events:
       apexfbd:bodyadded    { id, type, label, size, position, quaternion, isStatic }
       apexfbd:bodyremoved  { id }
     direct calls (perf-sensitive, called every rAF frame — no event overhead):
       ApexFBD.physics.getTransforms() -> [{ id, position:{x,y,z}, quaternion:{x,y,z,w} }]
       ApexFBD.physics.step(realDeltaSeconds)  // advances (or replays) the sim
     picking / sensor hookup (render.js calls these on raycast hit / drop):
       ApexFBD.physics.getBodyMeta(id) -> { id, label, mass, position, restitution }
       ApexFBD.physics.attachSensor(sensorType, bodyId)
       ApexFBD.physics.detachSensor(sensorId)
   ========================================================================== */

(function () {
  'use strict';

  window.ApexFBD = window.ApexFBD || {};
  const FBD = window.ApexFBD;
  const emit = (name, detail) => document.dispatchEvent(new CustomEvent(name, { detail: detail || {} }));

  /* ============================================================
     WORLD SETUP
  ============================================================ */
  const world = new CANNON.World();
  world.gravity.set(0, -9.81, 0);
  world.broadphase = new CANNON.NaiveBroadphase();
  world.solver.iterations = 12;
  world.defaultContactMaterial.friction = 0.4;
  world.defaultContactMaterial.restitution = 0.3;

  const materials = {
    ground: new CANNON.Material('ground'),
    object: new CANNON.Material('object'),
  };
  const groundObjectContact = new CANNON.ContactMaterial(materials.ground, materials.object, {
    friction: 0.4,
    restitution: 0.3,
  });
  world.addContactMaterial(groundObjectContact);

  // Static ground plane (y = 0). Rendered by render.js as the engineering floor.
  const groundBody = new CANNON.Body({ mass: 0, material: materials.ground });
  groundBody.addShape(new CANNON.Plane());
  groundBody.quaternion.setFromEuler(-Math.PI / 2, 0, 0);
  world.addBody(groundBody);

  const FIXED_DT = 1 / 60;
  const MAX_SUBSTEPS = 5;

  /* ============================================================
     REGISTRY: bodies, forces, springs, pulley links, sensors
  ============================================================ */
  let idCounter = 0;
  const nextId = (prefix) => `${prefix}_${++idCounter}`;

  const bodies = new Map();      // id -> { body, type, label, size, restitution }
  const continuousForces = new Map(); // forceId -> { bodyId, vector:{x,y,z}, point:{x,y,z} }
  const springs = [];            // CANNON.Spring instances (must call .applyForce() each step)
  const pulleySystems = [];      // { bodyIdA, bodyIdB, railAxis } idealized Atwood-style coupling
  const sensors = new Map();     // sensorId -> { type, bodyId, label }
  let sensorIdCounter = 0;

  /* ============================================================
     DIMENSION / AXIS LOCKING
  ============================================================ */
  let currentDimension = document.documentElement.getAttribute('data-dimension') || '3d';

  document.addEventListener('apexfbd:dimensionchange', (e) => {
    currentDimension = e.detail.dimension;
    // Re-anchor every existing body's locked axes to its current position
    // so switching modes mid-sim doesn't teleport anything.
    bodies.forEach((meta) => {
      meta.lockY = meta.body.position.y;
      meta.lockZ = meta.body.position.z;
    });
  });

  function applyAxisLocks() {
    bodies.forEach((meta) => {
      const b = meta.body;
      if (meta.isStatic) return;
      if (currentDimension === '1d') {
        b.position.y = meta.lockY;
        b.position.z = meta.lockZ;
        b.velocity.y = 0;
        b.velocity.z = 0;
        b.angularVelocity.set(0, 0, 0);
        b.quaternion.set(0, 0, 0, 1);
      } else if (currentDimension === '2d') {
        b.position.z = meta.lockZ;
        b.velocity.z = 0;
        b.angularVelocity.x = 0;
        b.angularVelocity.y = 0;
      }
      // 3d: no constraint
    });
  }

  /* ============================================================
     ENVIRONMENT (gravity, friction, restitution, drag, wind)
  ============================================================ */
  let dragCoefficient = 0.05;
  let wind = null; // {x,y,z} or null

  document.addEventListener('apexfbd:environmentchange', (e) => {
    const { gravity, gravityDir, gravityCustom, friction, restitution, drag, wind: w } = e.detail;

    if (gravityDir === 'custom' && gravityCustom) {
      world.gravity.set(gravityCustom.x, gravityCustom.y, gravityCustom.z);
    } else {
      const dirMap = {
        '-y': [0, -1, 0], '+y': [0, 1, 0],
        '-x': [-1, 0, 0], '+x': [1, 0, 0],
        '-z': [0, 0, -1], '+z': [0, 0, 1],
      };
      const [dx, dy, dz] = dirMap[gravityDir] || [0, -1, 0];
      world.gravity.set(dx * gravity, dy * gravity, dz * gravity);
    }

    world.defaultContactMaterial.friction = friction;
    world.defaultContactMaterial.restitution = restitution;
    groundObjectContact.friction = friction;
    groundObjectContact.restitution = restitution;

    dragCoefficient = drag;
    wind = w;
  });

  function applyDragAndWind() {
    if (dragCoefficient <= 0 && !wind) return;
    bodies.forEach((meta) => {
      const b = meta.body;
      if (meta.isStatic) return;
      if (dragCoefficient > 0) {
        // Quadratic drag opposing relative velocity (through still air, or air moving as `wind`).
        const relVx = b.velocity.x - (wind ? wind.x : 0);
        const relVy = b.velocity.y - (wind ? wind.y : 0);
        const relVz = b.velocity.z - (wind ? wind.z : 0);
        const speed = Math.hypot(relVx, relVy, relVz);
        if (speed > 1e-4) {
          const dragMag = dragCoefficient * speed * speed;
          b.force.x -= (relVx / speed) * dragMag;
          b.force.y -= (relVy / speed) * dragMag;
          b.force.z -= (relVz / speed) * dragMag;
        }
      }
    });
  }

  /* ============================================================
     OBJECT SPAWNING
  ============================================================ */
  document.addEventListener('apexfbd:spawn', (e) => spawnObject(e.detail));

  function spawnObject(detail) {
    const { type, position, size, mass } = detail;
    let pos = { x: position.x, y: position.y, z: position.z };

    // Enforce rail/plane confinement at spawn time for 1D / 2D.
    if (currentDimension === '1d') { pos.y = 0.5; pos.z = 0; }
    else if (currentDimension === '2d') { pos.z = 0; }

    let shape;
    let effectiveMass = mass;
    let label;
    const count = bodies.size + 1;

    switch (type) {
      // ---------------- 3D solids ----------------
      case 'sphere':
        shape = new CANNON.Sphere(Math.max(size.x, 0.1) / 2);
        label = `Sphere ${count}`;
        break;
      case 'cube':
        shape = new CANNON.Box(new CANNON.Vec3(size.x / 2, size.x / 2, size.x / 2));
        label = `Cube ${count}`;
        break;
      case 'cylinder':
        shape = new CANNON.Cylinder(size.x / 2, size.x / 2, size.y, 16);
        label = `Cylinder ${count}`;
        break;
      case 'cone':
        // Cannon has no cone primitive; a cylinder tapering to a near-zero top radius approximates it.
        shape = new CANNON.Cylinder(0.001, size.x / 2, size.y, 16);
        label = `Cone ${count}`;
        break;
      case 'pyramid':
        // Bounding-box approximation, same approach used for sketch extrusions below.
        shape = new CANNON.Box(new CANNON.Vec3(size.x / 2, size.y / 2, (size.z || size.x) / 2));
        label = `Pyramid ${count}`;
        break;
      case 'prism':
        shape = new CANNON.Box(new CANNON.Vec3(size.x / 2, size.y / 2, Math.max(size.z, 0.1) / 2));
        label = `Triangular Prism ${count}`;
        break;

      // ---------------- 2D flat shapes ----------------
      case 'circle':
        shape = new CANNON.Sphere(Math.max(size.x, 0.1) / 2);
        label = `Circle ${count}`;
        break;
      case 'rectangle':
        shape = new CANNON.Box(new CANNON.Vec3(size.x / 2, size.y / 2, 0.025));
        label = `Rectangle ${count}`;
        break;
      case 'triangle-2d':
        shape = new CANNON.Box(new CANNON.Vec3(size.x / 2, size.y / 2, 0.025));
        label = `Triangle ${count}`;
        break;
      case 'polygon':
        shape = new CANNON.Cylinder(Math.max(size.x, 0.1) / 2, Math.max(size.x, 0.1) / 2, 0.05, 16);
        label = `Polygon ${count}`;
        break;

      // ---------------- 1D shapes ----------------
      case 'point-mass':
        shape = new CANNON.Sphere(0.08);
        effectiveMass = mass || 0.1;
        label = `Point Mass ${count}`;
        break;
      case 'rod': {
        const thickness = Math.max(size.y, 0.05);
        shape = new CANNON.Box(new CANNON.Vec3(size.x / 2, thickness / 2, thickness / 2));
        label = `Rod ${count}`;
        break;
      }

      // ---------------- existing utility types ----------------
      case 'particle':
        shape = new CANNON.Sphere(0.08);
        effectiveMass = mass || 0.001; // treat as near-massless charged particle by default
        label = `Electron ${count}`;
        break;
      case 'pulley':
        shape = new CANNON.Cylinder(size.x / 2, size.x / 2, 0.2, 16);
        label = `Pulley ${count}`;
        break;
      case 'spring':
        shape = new CANNON.Box(new CANNON.Vec3(0.05, size.y / 2, 0.05));
        label = `Spring Anchor ${count}`;
        break;
      case 'sketch':
        // Approximate custom sketch extrusions as a box using the bounding size
        // until render.js supplies real extruded geometry back for a convex shape.
        shape = new CANNON.Box(new CANNON.Vec3(size.x / 2, size.y / 2, size.z / 2));
        label = `Sketch Shape ${count}`;
        break;
      case 'block':
      default:
        shape = new CANNON.Box(new CANNON.Vec3(size.x / 2, size.y / 2, size.z / 2));
        label = `Block ${count}`;
        break;
    }

    const isStatic = type === 'pulley' && effectiveMass === 0;
    const body = new CANNON.Body({
      mass: isStatic ? 0 : effectiveMass,
      material: materials.object,
      linearDamping: 0.01,
      angularDamping: 0.01,
    });
    body.addShape(shape);
    body.position.set(pos.x, pos.y, pos.z);
    world.addBody(body);

    const id = nextId('body');
    bodies.set(id, {
      body, type, label, size: { ...size }, restitution: 0.3,
      isStatic, lockY: pos.y, lockZ: pos.z,
      initialPosition: body.position.clone(),
      initialQuaternion: body.quaternion.clone(),
    });

    emit('apexfbd:bodyadded', {
      id, type, label, size,
      position: { x: pos.x, y: pos.y, z: pos.z },
      quaternion: { x: 0, y: 0, z: 0, w: 1 },
      isStatic,
    });

    syncObjectListToUI();
    return id;
  }

  /* ============================================================
     FORCES
  ============================================================ */
  document.addEventListener('apexfbd:forceapply', (e) => {
    const { forceId, targetId, vector, point, continuous } = e.detail;
    const meta = bodies.get(targetId);
    if (!meta) return;

    if (continuous) {
      continuousForces.set(forceId, { bodyId: targetId, vector, point });
    } else {
      const worldForce = new CANNON.Vec3(vector.x, vector.y, vector.z);
      const localPoint = new CANNON.Vec3(point.x, point.y, point.z);
      // Impulse ~ force applied over one nominal timestep, so "Apply Force"
      // for a one-shot force reads as a kick rather than a permanent push.
      meta.body.applyImpulse(worldForce.scale(FIXED_DT), meta.body.position.vadd(localPoint));
    }
  });

  document.addEventListener('apexfbd:forceclear', (e) => {
    continuousForces.delete(e.detail.forceId);
  });

  function applyContinuousForces() {
    continuousForces.forEach((f) => {
      const meta = bodies.get(f.bodyId);
      if (!meta) return;
      const worldPoint = meta.body.position.vadd(new CANNON.Vec3(f.point.x, f.point.y, f.point.z));
      meta.body.applyForce(new CANNON.Vec3(f.vector.x, f.vector.y, f.vector.z), worldPoint);
    });
  }

  /* ============================================================
     IDEALIZED PULLEY / ATWOOD COUPLING
     Standard first-year-physics assumption: massless inextensible string,
     frictionless massless pulley. Rather than approximate this with a
     generic constraint solver (which fights gravity integration and drifts),
     we solve the coupled system analytically each step:
       a = (m_B*g - m_A*g) / (m_A + m_B)      [g along the rail axis]
     and drive both bodies with equal-and-opposite acceleration along the
     rail. This matches the JEE-style textbook result exactly.
  ============================================================ */
  function applyPulleySystems() {
    pulleySystems.forEach((link) => {
      const metaA = bodies.get(link.bodyIdA);
      const metaB = bodies.get(link.bodyIdB);
      if (!metaA || !metaB) return;
      const g = Math.abs(world.gravity.y) || 9.81;
      const mA = metaA.body.mass || 0.0001;
      const mB = metaB.body.mass || 0.0001;
      const a = ((mB - mA) * g) / (mA + mB);
      // A accelerates downward at `a` (if positive), B accelerates upward by the same amount.
      metaA.body.velocity.y -= a * FIXED_DT;
      metaB.body.velocity.y += a * FIXED_DT;
      // Zero out horizontal drift so both masses hang straight on their side of the pulley.
      metaA.body.velocity.x = 0; metaA.body.velocity.z = 0;
      metaB.body.velocity.x = 0; metaB.body.velocity.z = 0;
    });
  }

  /* ============================================================
     SPRINGS
  ============================================================ */
  function applySprings() {
    springs.forEach((s) => s.applyForce());
  }

  /* ============================================================
     TIME ENGINE: play / pause / rewind / scrub / speed
     History is a bounded ring buffer of lightweight transform snapshots so
     the timeline scrubber can rewind through recent collisions without
     unbounded memory growth.
  ============================================================ */
  let isPlaying = false;
  let timeScale = 1;
  let simTime = 0;
  const MAX_HISTORY = 900; // ~15s at 60Hz
  const history = [];
  let scrubIndex = -1; // -1 = live (not scrubbing)

  document.addEventListener('apexfbd:play', () => {
    // If we resumed after scrubbing into the past, trim the "future" history
    // so it re-records forward from here (like recording over old footage).
    if (scrubIndex > -1 && scrubIndex < history.length - 1) {
      history.length = scrubIndex + 1;
    }
    scrubIndex = -1;
    isPlaying = true;
  });
  document.addEventListener('apexfbd:pause', () => { isPlaying = false; });
  document.addEventListener('apexfbd:timescale', (e) => { timeScale = e.detail.scale; });
  document.addEventListener('apexfbd:rewind', () => {
    isPlaying = false;
    simTime = 0;
    scrubIndex = -1;
    history.length = 0;
    bodies.forEach((meta) => {
      if (meta.initialPosition) {
        meta.body.position.copy(meta.initialPosition);
        meta.body.quaternion.copy(meta.initialQuaternion);
      }
      meta.body.velocity.set(0, 0, 0);
      meta.body.angularVelocity.set(0, 0, 0);
    });
  });
  document.addEventListener('apexfbd:scrub', (e) => {
    if (history.length === 0) return;
    const idx = Math.round((e.detail.value / 1000) * (history.length - 1));
    scrubIndex = Math.max(0, Math.min(history.length - 1, idx));
    applySnapshot(history[scrubIndex]);
    FBD.setTimeReadout && FBD.setTimeReadout(history[scrubIndex].t);
  });

  function takeSnapshot() {
    const transforms = [];
    bodies.forEach((meta, id) => {
      if (meta.isStatic) return;
      const b = meta.body;
      transforms.push({
        id,
        p: [b.position.x, b.position.y, b.position.z],
        q: [b.quaternion.x, b.quaternion.y, b.quaternion.z, b.quaternion.w],
        v: [b.velocity.x, b.velocity.y, b.velocity.z],
      });
    });
    history.push({ t: simTime, transforms });
    if (history.length > MAX_HISTORY) history.shift();
  }

  function applySnapshot(snapshot) {
    snapshot.transforms.forEach((t) => {
      const meta = bodies.get(t.id);
      if (!meta) return;
      meta.body.position.set(t.p[0], t.p[1], t.p[2]);
      meta.body.quaternion.set(t.q[0], t.q[1], t.q[2], t.q[3]);
      meta.body.velocity.set(0, 0, 0);
      meta.body.angularVelocity.set(0, 0, 0);
    });
  }

  /* ============================================================
     MAIN STEP — called every rAF frame by render.js
  ============================================================ */
  let accumulator = 0;
  function step(realDeltaSeconds) {
    if (!isPlaying || scrubIndex > -1) {
      // Paused or actively scrubbing: freeze the world, but still let the UI
      // (inspector edits, environment tweaks) apply directly to bodies.
      updateSensors();
      return;
    }
    accumulator += Math.min(realDeltaSeconds, 0.25) * timeScale;
    let steps = 0;
    while (accumulator >= FIXED_DT && steps < MAX_SUBSTEPS) {
      applyContinuousForces();
      applyDragAndWind();
      applyPulleySystems();
      applySprings();
      world.step(FIXED_DT);
      applyAxisLocks();
      simTime += FIXED_DT;
      takeSnapshot();
      accumulator -= FIXED_DT;
      steps += 1;
    }
    FBD.setTimeReadout && FBD.setTimeReadout(simTime);
    updateSensors();
  }

  function getTransforms() {
    const out = [];
    bodies.forEach((meta, id) => {
      const b = meta.body;
      out.push({
        id,
        position: { x: b.position.x, y: b.position.y, z: b.position.z },
        quaternion: { x: b.quaternion.x, y: b.quaternion.y, z: b.quaternion.z, w: b.quaternion.w },
      });
    });
    return out;
  }

  /* ============================================================
     INSPECTOR SUPPORT
  ============================================================ */
  function getBodyMeta(id) {
    const meta = bodies.get(id);
    if (!meta) return null;
    return {
      id,
      label: meta.label,
      mass: meta.body.mass,
      position: { x: meta.body.position.x, y: meta.body.position.y, z: meta.body.position.z },
      restitution: meta.restitution,
    };
  }

  document.addEventListener('apexfbd:inspectorupdate', (e) => {
    const { objectId, mass, position, restitution } = e.detail;
    const meta = bodies.get(objectId);
    if (!meta) return;
    if (!meta.isStatic && typeof mass === 'number') meta.body.mass = Math.max(mass, 0.001);
    meta.body.position.set(position.x, position.y, position.z);
    meta.body.updateMassProperties();
    meta.restitution = restitution;
  });

  document.addEventListener('apexfbd:inspectordelete', (e) => {
    removeBody(e.detail.objectId);
  });

  function removeBody(id) {
    const meta = bodies.get(id);
    if (!meta) return;
    world.removeBody(meta.body);
    bodies.delete(id);
    // Drop any forces / pulley links / sensors referencing this body.
    [...continuousForces.entries()].forEach(([fid, f]) => { if (f.bodyId === id) continuousForces.delete(fid); });
    for (let i = pulleySystems.length - 1; i >= 0; i -= 1) {
      if (pulleySystems[i].bodyIdA === id || pulleySystems[i].bodyIdB === id) pulleySystems.splice(i, 1);
    }
    [...sensors.entries()].forEach(([sid, s]) => { if (s.bodyId === id) sensors.delete(sid); });
    emit('apexfbd:bodyremoved', { id });
    syncObjectListToUI();
  }

  document.addEventListener('apexfbd:clearscene', () => {
    [...bodies.keys()].forEach(removeBody);
    history.length = 0;
    simTime = 0;
    scrubIndex = -1;
  });

  function syncObjectListToUI() {
    const list = [...bodies.entries()].map(([id, meta]) => ({ id, label: meta.label }));
    FBD.updateObjectList && FBD.updateObjectList(list);
  }

  /* ============================================================
     SENSORS
  ============================================================ */
  function attachSensor(type, bodyId) {
    const meta = bodies.get(bodyId);
    if (!meta) return null;
    const sensorId = `sensor_${++sensorIdCounter}`;
    sensors.set(sensorId, { type, bodyId, label: `${sensorLabel(type)} · ${meta.label}` });
    updateSensors();
    return sensorId;
  }
  function detachSensor(sensorId) { sensors.delete(sensorId); updateSensors(); }
  function sensorLabel(type) {
    return { 'force-gauge': 'Force', 'speed-gun': 'Speed', accelerometer: 'Accel', protractor: 'Angle' }[type] || type;
  }

  const sensorLog = [];
  function updateSensors() {
    if (sensors.size === 0) return;
    const readouts = [];
    sensors.forEach((s, sensorId) => {
      const meta = bodies.get(s.bodyId);
      if (!meta) return;
      const b = meta.body;
      let value = 0, unit = '';
      switch (s.type) {
        case 'force-gauge':
          value = (b.mass * Math.hypot(world.gravity.x, world.gravity.y, world.gravity.z)).toFixed(2);
          unit = ' N';
          break;
        case 'speed-gun':
          value = Math.hypot(b.velocity.x, b.velocity.y, b.velocity.z).toFixed(2);
          unit = ' m/s';
          break;
        case 'accelerometer':
          value = Math.hypot(b.force.x, b.force.y, b.force.z) / Math.max(b.mass, 0.0001);
          value = value.toFixed(2);
          unit = ' m/s²';
          break;
        case 'protractor': {
          const euler = new CANNON.Vec3();
          b.quaternion.toEuler(euler);
          value = ((euler.z * 180) / Math.PI).toFixed(1);
          unit = '°';
          break;
        }
        default:
          break;
      }
      readouts.push({ id: sensorId, label: s.label, value, unit });

      const logEnabled = document.getElementById('sensor-log-enabled');
      if (isPlaying && logEnabled && logEnabled.checked) {
        sensorLog.push({ t: simTime.toFixed(3), sensor: s.label, type: s.type, value, unit: unit.trim() });
      }
    });
    FBD.updateSensorReadouts && FBD.updateSensorReadouts(readouts);
  }

  function exportSensorLogCSV() {
    if (sensorLog.length === 0) {
      FBD.toast && FBD.toast('No sensor data logged yet — attach a sensor and press play.', 'error');
      return;
    }
    const header = 'time_s,sensor,type,value,unit\n';
    const rows = sensorLog.map((r) => `${r.t},"${r.sensor}",${r.type},${r.value},${r.unit}`).join('\n');
    const blob = new Blob([header + rows], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `apexfbd-sensor-log-${Date.now()}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    FBD.toast && FBD.toast('Sensor data exported to CSV', 'success');
  }
  document.getElementById('btn-export-csv')?.addEventListener('click', exportSensorLogCSV);

  /* ============================================================
     EXAM PREP PRESETS
  ============================================================ */
  document.addEventListener('apexfbd:presetload', (e) => loadPreset(e.detail.presetId, e.detail.difficulty));

  function loadPreset(presetId, difficulty) {
    [...bodies.keys()].forEach(removeBody);
    pulleySystems.length = 0;
    springs.length = 0;

    const scale = difficulty === 'jee-advanced' ? 1.4 : difficulty === 'board' ? 0.7 : 1;

    switch (presetId) {
      case 'atwood-machine': {
        const pulleyId = spawnObject({ type: 'pulley', position: { x: 0, y: 4, z: 0 }, size: { x: 0.4, y: 0.4, z: 0.4 }, mass: 0 });
        const aId = spawnObject({ type: 'block', position: { x: -0.6, y: 2.5, z: 0 }, size: { x: 0.5, y: 0.5, z: 0.5 }, mass: 2 * scale });
        const bId = spawnObject({ type: 'block', position: { x: 0.6, y: 2.5, z: 0 }, size: { x: 0.5, y: 0.5, z: 0.5 }, mass: 3 * scale });
        pulleySystems.push({ bodyIdA: aId, bodyIdB: bId, railAxis: 'y' });
        break;
      }
      case 'inclined-plane': {
        const angleDeg = 30 * scale > 89 ? 45 : 30;
        const ramp = new CANNON.Body({ mass: 0, material: materials.ground });
        ramp.addShape(new CANNON.Box(new CANNON.Vec3(3, 0.2, 1.5)));
        ramp.position.set(0, 1, 0);
        ramp.quaternion.setFromEuler(0, 0, (angleDeg * Math.PI) / 180);
        world.addBody(ramp);
        const blockId = spawnObject({ type: 'block', position: { x: -1.8, y: 2.6, z: 0 }, size: { x: 0.4, y: 0.4, z: 0.4 }, mass: 1 * scale });
        const meta = bodies.get(blockId);
        if (meta) meta.body.quaternion.setFromEuler(0, 0, (angleDeg * Math.PI) / 180);
        break;
      }
      case 'projectile-motion': {
        const speed = 18 * scale;
        const angleRad = (45 * Math.PI) / 180;
        const id = spawnObject({ type: 'sphere', position: { x: -6, y: 0.5, z: 0 }, size: { x: 0.4, y: 0.4, z: 0.4 }, mass: 1 });
        const meta = bodies.get(id);
        if (meta) meta.body.velocity.set(speed * Math.cos(angleRad), speed * Math.sin(angleRad), 0);
        break;
      }
      case 'spring-mass': {
        const anchorId = spawnObject({ type: 'spring', position: { x: 0, y: 5, z: 0 }, size: { x: 0.3, y: 0.3, z: 0.3 }, mass: 0 });
        const massId = spawnObject({ type: 'block', position: { x: 0, y: 3, z: 0 }, size: { x: 0.5, y: 0.5, z: 0.5 }, mass: 1 * scale });
        const anchorMeta = bodies.get(anchorId);
        const massMeta = bodies.get(massId);
        if (anchorMeta && massMeta) {
          anchorMeta.isStatic = true;
          anchorMeta.body.mass = 0;
          anchorMeta.body.updateMassProperties();
          const spring = new CANNON.Spring(massMeta.body, anchorMeta.body, {
            restLength: 1.5,
            stiffness: 40 * scale,
            damping: 1.2,
            localAnchorA: new CANNON.Vec3(0, 0, 0),
            localAnchorB: new CANNON.Vec3(0, 0, 0),
          });
          springs.push(spring);
        }
        break;
      }
      case 'pulley-system-compound': {
        // 2:1 mechanical advantage: mass B is twice the effective inertia of A's pull.
        const pulleyId = spawnObject({ type: 'pulley', position: { x: 0, y: 4.5, z: 0 }, size: { x: 0.4, y: 0.4, z: 0.4 }, mass: 0 });
        const aId = spawnObject({ type: 'block', position: { x: -0.6, y: 3, z: 0 }, size: { x: 0.4, y: 0.4, z: 0.4 }, mass: 1 * scale });
        const bId = spawnObject({ type: 'block', position: { x: 0.6, y: 1.5, z: 0 }, size: { x: 0.6, y: 0.6, z: 0.6 }, mass: 4 * scale });
        pulleySystems.push({ bodyIdA: aId, bodyIdB: bId, railAxis: 'y' });
        break;
      }
      case 'collision-lab': {
        const aId = spawnObject({ type: 'sphere', position: { x: -3, y: 0.5, z: 0 }, size: { x: 0.5, y: 0.5, z: 0.5 }, mass: 1 * scale });
        const bId = spawnObject({ type: 'sphere', position: { x: 3, y: 0.5, z: 0 }, size: { x: 0.5, y: 0.5, z: 0.5 }, mass: 1 * scale });
        const metaA = bodies.get(aId); const metaB = bodies.get(bId);
        if (metaA) metaA.body.velocity.set(4, 0, 0);
        if (metaB) metaB.body.velocity.set(-4, 0, 0);
        break;
      }
      case 'charged-particle-field': {
        const id = spawnObject({ type: 'particle', position: { x: -4, y: 3, z: 0 }, size: { x: 0.1, y: 0.1, z: 0.1 }, mass: 0.001 });
        continuousForces.set('field_force', { bodyId: id, vector: { x: 6 * scale, y: 0, z: 0 }, point: { x: 0, y: 0, z: 0 } });
        break;
      }
      default:
        break;
    }
    FBD.toast && FBD.toast(`Preset loaded (${difficulty})`, 'success');
  }

  /* ============================================================
     WORKSPACE SAVE / LOAD (overrides main.js's default no-ops)
  ============================================================ */
  FBD.getSceneState = function getSceneState() {
    return {
      dimension: currentDimension,
      gravity: { x: world.gravity.x, y: world.gravity.y, z: world.gravity.z },
      friction: world.defaultContactMaterial.friction,
      restitution: world.defaultContactMaterial.restitution,
      drag: dragCoefficient,
      objects: [...bodies.entries()].map(([id, meta]) => ({
        id, type: meta.type, label: meta.label, size: meta.size, mass: meta.body.mass,
        position: { x: meta.body.position.x, y: meta.body.position.y, z: meta.body.position.z },
        quaternion: { x: meta.body.quaternion.x, y: meta.body.quaternion.y, z: meta.body.quaternion.z, w: meta.body.quaternion.w },
      })),
      pulleySystems: pulleySystems.map((p) => ({ ...p })),
    };
  };

  FBD.loadSceneState = function loadSceneState(state) {
    if (!state) return;
    [...bodies.keys()].forEach(removeBody);
    pulleySystems.length = 0;
    (state.objects || []).forEach((obj) => {
      const id = spawnObject({ type: obj.type, position: obj.position, size: obj.size, mass: obj.mass });
      const meta = bodies.get(id);
      if (meta) meta.body.quaternion.set(obj.quaternion.x, obj.quaternion.y, obj.quaternion.z, obj.quaternion.w);
    });
    (state.pulleySystems || []).forEach((p) => pulleySystems.push(p));
  };

  /* ============================================================
     PUBLIC API for render.js
  ============================================================ */
  FBD.physics = {
    world,
    step,
    getTransforms,
    getBodyMeta,
    attachSensor,
    detachSensor,
    removeBody,
    spawnObject,
  };

  document.addEventListener('apexfbd:sensordrop', (e) => {
    attachSensor(e.detail.sensorType, e.detail.targetId);
  });

  console.info('[ApexFBD] Physics engine ready.');
})();
