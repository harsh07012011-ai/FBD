/* ==========================================================================
   APEX FBD — main.js
   Owns: UI wiring only (accordions, dropdowns, dimension switch, time engine
   controls, form panels, dark mode, IndexedDB workspace save/load).

   Does NOT touch Three.js or Cannon.js directly. Instead it talks to
   physics.js / render.js through a small global contract, `window.ApexFBD`,
   so the three files stay decoupled:

     Events dispatched on `document` (physics.js / render.js should listen):
       apexfbd:dimensionchange   { dimension: '1d'|'2d'|'3d' }
       apexfbd:play                (no detail)
       apexfbd:pause               (no detail)
       apexfbd:rewind              (no detail)
       apexfbd:scrub              { value: 0-1000 }
       apexfbd:timescale          { scale: number }
       apexfbd:spawn             { type, position:{x,y,z}, size:{x,y,z}, mass }
       apexfbd:forceapply        { targetId, vector:{x,y,z}, point:{x,y,z}, continuous }
       apexfbd:forceclear        { forceId }
       apexfbd:environmentchange { gravity, gravityDir, friction, restitution, drag, wind }
       apexfbd:presetload        { presetId, difficulty }
       apexfbd:sensordrop        { sensorType, targetId }
       apexfbd:clearscene          (no detail)
       apexfbd:inspectordelete   { objectId }
       apexfbd:inspectorupdate   { objectId, mass, position, restitution }
       apexfbd:camerapreset      { preset: 'front'|'top'|'iso' }
       apexfbd:togglegrid        { visible }
       apexfbd:togglevectors     { visible }
       apexfbd:togglelabels      { visible }
       apexfbd:workspaceload     { sceneState }

     Functions physics.js / render.js may CALL on window.ApexFBD (all
     no-op-safe if the UI hasn't loaded yet, and safe if never called):
       ApexFBD.updateObjectList(objects)      // objects: [{id,label}] -> refreshes Force Target <select>
       ApexFBD.showInspector(obj)             // obj: {id,label,mass,position:{x,y,z},restitution}
       ApexFBD.hideInspector()
       ApexFBD.updateSensorReadouts(list)     // list: [{id,label,type,value,unit}]
       ApexFBD.setTimeReadout(seconds)
       ApexFBD.setFPS(fps)
       ApexFBD.toast(message, kind)           // kind: 'info'|'success'|'error'
       ApexFBD.getSceneState()                // physics.js should OVERRIDE this — used by Save Workspace
       ApexFBD.loadSceneState(state)          // physics.js should OVERRIDE this — used by Load Workspace
   ========================================================================== */

(function () {
  'use strict';

  window.ApexFBD = window.ApexFBD || {};
  const FBD = window.ApexFBD;

  /* ---------------------------------- utils -------------------------------- */
  const qs = (sel, ctx) => (ctx || document).querySelector(sel);
  const qsa = (sel, ctx) => Array.from((ctx || document).querySelectorAll(sel));
  const on = (el, ev, fn, opts) => el && el.addEventListener(ev, fn, opts);
  const emit = (name, detail) => document.dispatchEvent(new CustomEvent(name, { detail: detail || {} }));

  function fireAndForget(fn) {
    try { return fn(); } catch (err) { console.error('[ApexFBD]', err); }
  }

  /* ============================================================
     TOASTS
  ============================================================ */
  function toast(message, kind) {
    const container = qs('#toast-container');
    if (!container) return;
    const el = document.createElement('div');
    el.className = 'toast';
    if (kind === 'error') el.style.background = 'var(--danger)';
    if (kind === 'success') el.style.background = 'var(--success)';
    el.textContent = message;
    container.appendChild(el);
    setTimeout(() => {
      el.style.transition = 'opacity .25s ease';
      el.style.opacity = '0';
      setTimeout(() => el.remove(), 250);
    }, 2600);
  }
  FBD.toast = toast;

  /* ============================================================
     DARK MODE
  ============================================================ */
  function initDarkMode() {
    const toggle = qs('#dark-mode-toggle');
    const root = document.documentElement;
    const saved = localStorage.getItem('apexfbd:theme');
    const prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    const initial = saved || (prefersDark ? 'dark' : 'light');
    applyTheme(initial);

    on(toggle, 'click', () => {
      const current = root.getAttribute('data-theme') || 'light';
      applyTheme(current === 'dark' ? 'light' : 'dark');
    });

    function applyTheme(theme) {
      root.setAttribute('data-theme', theme);
      localStorage.setItem('apexfbd:theme', theme);
      if (toggle) {
        toggle.setAttribute('aria-pressed', String(theme === 'dark'));
        qs('.icon-sun', toggle).hidden = theme === 'dark';
        qs('.icon-moon', toggle).hidden = theme !== 'dark';
        const label = qs('.dark-mode-label', toggle);
        if (label) label.textContent = theme === 'dark' ? 'Light Mode' : 'Dark Mode';
      }
    }
  }

  /* ============================================================
     DIMENSION SWITCH (1D / 2D / 3D)
  ============================================================ */
  function initDimensionSwitch() {
    const buttons = qsa('.dim-btn');
    const saved = localStorage.getItem('apexfbd:dimension') || '3d';
    setDimension(saved, { silent: true });

    buttons.forEach((btn) => {
      on(btn, 'click', () => setDimension(btn.dataset.dim));
    });

    function setDimension(dim, opts) {
      document.documentElement.setAttribute('data-dimension', dim);
      localStorage.setItem('apexfbd:dimension', dim);
      buttons.forEach((btn) => {
        const active = btn.dataset.dim === dim;
        btn.classList.toggle('is-active', active);
        btn.setAttribute('aria-selected', String(active));
      });
      if (!(opts && opts.silent)) {
        emit('apexfbd:dimensionchange', { dimension: dim });
        toast(`Switched to ${dim.toUpperCase()} mode`);
      } else {
        emit('apexfbd:dimensionchange', { dimension: dim });
      }
    }
  }

  /* ============================================================
     GENERIC DROPDOWNS (Export / Overflow / Timeline popover)
  ============================================================ */
  function initDropdowns() {
    const dropdowns = qsa('.dropdown');

    dropdowns.forEach((dd) => {
      const trigger = qs('.dropdown-trigger', dd);
      on(trigger, 'click', (e) => {
        e.stopPropagation();
        const willOpen = !dd.classList.contains('is-open');
        closeAll();
        if (willOpen) openDropdown(dd);
      });
    });

    on(document, 'click', () => closeAll());
    on(document, 'keydown', (e) => { if (e.key === 'Escape') closeAll(); });

    function openDropdown(dd) {
      dd.classList.add('is-open');
      const trigger = qs('.dropdown-trigger', dd);
      if (trigger) trigger.setAttribute('aria-expanded', 'true');
    }
    function closeAll() {
      dropdowns.forEach((dd) => {
        dd.classList.remove('is-open');
        const trigger = qs('.dropdown-trigger', dd);
        if (trigger) trigger.setAttribute('aria-expanded', 'false');
      });
    }
  }

  /* ============================================================
     ACCORDION (only one open at a time)
  ============================================================ */
  function initAccordion() {
    const sections = qsa('.accordion');
    sections.forEach((section) => {
      const header = qs('.accordion-header', section);
      on(header, 'click', () => {
        const isOpen = header.getAttribute('aria-expanded') === 'true';
        sections.forEach((s) => qs('.accordion-header', s).setAttribute('aria-expanded', 'false'));
        header.setAttribute('aria-expanded', String(!isOpen));
      });
    });
  }

  /* ============================================================
     TIME ENGINE (play / pause / rewind / scrub / speed)
  ============================================================ */
  function initTimeEngine() {
    const btnPlay = qs('#btn-play');
    const btnPause = qs('#btn-pause');
    const btnRewind = qs('#btn-rewind');
    const scrubber = qs('#timeline-scrubber');
    const speedSelect = qs('#time-scale');
    const readout = qs('#time-readout');

    setPlaybackState('paused');

    on(btnPlay, 'click', () => { setPlaybackState('playing'); emit('apexfbd:play'); });
    on(btnPause, 'click', () => { setPlaybackState('paused'); emit('apexfbd:pause'); });
    on(btnRewind, 'click', () => {
      setPlaybackState('paused');
      if (scrubber) scrubber.value = 0;
      emit('apexfbd:rewind');
      setTimeReadout(0);
    });
    on(scrubber, 'input', () => emit('apexfbd:scrub', { value: Number(scrubber.value) }));
    on(speedSelect, 'change', () => emit('apexfbd:timescale', { scale: Number(speedSelect.value) }));

    function setPlaybackState(state) {
      if (btnPlay) btnPlay.hidden = state === 'playing';
      if (btnPause) btnPause.hidden = state === 'paused';
    }

    function setTimeReadout(seconds) {
      if (readout) readout.textContent = `t = ${Number(seconds).toFixed(2)}s`;
    }
    FBD.setTimeReadout = setTimeReadout;
  }

  /* ============================================================
     VIEWPORT HUD (camera presets, grid/vector/label toggles, FPS)
  ============================================================ */
  function initViewportHud() {
    on(qs('#cam-front'), 'click', () => emit('apexfbd:camerapreset', { preset: 'front' }));
    on(qs('#cam-top'), 'click', () => emit('apexfbd:camerapreset', { preset: 'top' }));
    on(qs('#cam-iso'), 'click', () => emit('apexfbd:camerapreset', { preset: 'iso' }));

    wireToggle('#toggle-grid', 'apexfbd:togglegrid');
    wireToggle('#toggle-vectors', 'apexfbd:togglevectors');
    wireToggle('#toggle-labels', 'apexfbd:togglelabels');

    function wireToggle(sel, eventName) {
      const btn = qs(sel);
      on(btn, 'click', () => {
        const next = btn.getAttribute('aria-pressed') !== 'true';
        btn.setAttribute('aria-pressed', String(next));
        emit(eventName, { visible: next });
      });
    }

    FBD.setFPS = (fps) => {
      const el = qs('#fps-readout');
      if (el) el.textContent = `${Math.round(fps)} FPS`;
    };
  }

  /* ============================================================
     SPAWN PANEL
  ============================================================ */
  function initSpawnPanel() {
    const typeSelect = qs('#spawn-object-type');
    const sketchRow = qs('#sketch-tool-row');
    const confirmBtn = qs('#btn-spawn-confirm');
    const sizeHint = qs('#spawn-size-hint');

    const SIZE_HINTS = {
      'point-mass': 'Size ignored — fixed micro mass point',
      rod: 'X = length, Y = thickness (Z unused)',
      circle: 'X = diameter (Y, Z unused)',
      rectangle: 'X = width, Y = height (Z unused)',
      'triangle-2d': 'X = base, Y = height (Z unused)',
      polygon: 'X = diameter, Y = number of sides (3-12)',
      cube: 'X = edge length (uniform on all sides)',
      block: 'X = width, Y = height, Z = depth',
      sphere: 'X = diameter (Y, Z unused)',
      cylinder: 'X = diameter, Y = height (Z unused)',
      cone: 'X = base diameter, Y = height (Z unused)',
      pyramid: 'X = base width, Y = height, Z = base depth',
      prism: 'X = base width, Y = height, Z = length',
      pulley: 'X = wheel diameter (Y, Z unused)',
      spring: 'Y = coil length (X, Z unused)',
      particle: 'Size ignored — fixed micro particle',
      sketch: 'Set via Sketch Canvas + Extrusion Depth',
    };

    function filterTypesForDimension(dim) {
      if (!typeSelect) return;
      const options = qsa('option', typeSelect);
      options.forEach((opt) => { opt.hidden = (opt.dataset.dim || '3d') !== dim; });
      qsa('optgroup', typeSelect).forEach((group) => {
        group.hidden = !qsa('option', group).some((o) => !o.hidden);
      });
      const current = typeSelect.selectedOptions[0];
      if (!current || current.hidden) {
        const firstVisible = options.find((o) => !o.hidden);
        if (firstVisible) typeSelect.value = firstVisible.value;
      }
      updateForType();
    }

    function updateForType() {
      if (sketchRow) sketchRow.hidden = typeSelect.value !== 'sketch';
      if (sizeHint) sizeHint.textContent = SIZE_HINTS[typeSelect.value] || 'X = width, Y = height, Z = depth';
    }

    on(typeSelect, 'change', updateForType);
    document.addEventListener('apexfbd:dimensionchange', (e) => filterTypesForDimension(e.detail.dimension));
    filterTypesForDimension(document.documentElement.getAttribute('data-dimension') || '3d');

    on(confirmBtn, 'click', () => {
      const type = typeSelect ? typeSelect.value : 'block';
      const size = {
        x: numVal('#spawn-size-x', 1),
        y: numVal('#spawn-size-y', 1),
        z: numVal('#spawn-size-z', 1),
      };
      if (type === 'cube') { size.y = size.x; size.z = size.x; }

      const detail = {
        type,
        position: {
          x: numVal('#spawn-x'),
          y: numVal('#spawn-y'),
          z: numVal('#spawn-z'),
        },
        size,
        mass: numVal('#spawn-mass', 1),
      };
      emit('apexfbd:spawn', detail);
      toast(`${labelForType(detail.type)} added to scene`);
    });

    function labelForType(type) {
      const map = {
        block: 'Cuboid', cube: 'Cube', sphere: 'Sphere', cylinder: 'Cylinder', cone: 'Cone',
        pyramid: 'Pyramid', prism: 'Triangular prism', circle: 'Circle', rectangle: 'Rectangle',
        'triangle-2d': 'Triangle', polygon: 'Polygon', 'point-mass': 'Point mass', rod: 'Rod',
        pulley: 'Pulley', spring: 'Spring', particle: 'Electron', sketch: 'Sketch shape',
      };
      return map[type] || 'Object';
    }
  }

  /* ============================================================
     FORCES PANEL
  ============================================================ */
  function initForcesPanel() {
    const segmentedBtns = qsa('.segmented-btn[data-force-mode]');
    const modePanels = qsa('.force-mode-panel');
    const applyBtn = qs('#btn-apply-force');
    const targetSelect = qs('#force-target');
    const listEl = qs('#active-forces-list');

    const activeForces = [];

    segmentedBtns.forEach((btn) => {
      on(btn, 'click', () => {
        segmentedBtns.forEach((b) => b.classList.toggle('is-active', b === btn));
        modePanels.forEach((p) => { p.hidden = p.dataset.modePanel !== btn.dataset.forceMode; });
      });
    });

    on(applyBtn, 'click', () => {
      if (!targetSelect || !targetSelect.value) {
        toast('Select a target object first', 'error');
        return;
      }
      const mode = qs('.segmented-btn.is-active', document)?.dataset.forceMode || 'magnitude';
      let vector;
      if (mode === 'magnitude') {
        const mag = numVal('#force-magnitude', 0);
        const theta = (numVal('#force-angle-theta', 0) * Math.PI) / 180;
        const phi = (numVal('#force-angle-phi', 0) * Math.PI) / 180;
        vector = {
          x: mag * Math.cos(theta) * Math.cos(phi),
          y: mag * Math.sin(theta) * Math.cos(phi),
          z: mag * Math.sin(phi),
        };
      } else {
        vector = { x: numVal('#force-fx', 0), y: numVal('#force-fy', 0), z: numVal('#force-fz', 0) };
      }
      const point = { x: numVal('#force-app-x', 0), y: numVal('#force-app-y', 0), z: numVal('#force-app-z', 0) };
      const continuous = qs('#force-continuous')?.checked || false;
      const targetLabel = targetSelect.options[targetSelect.selectedIndex].text;

      const forceId = `f_${Date.now()}`;
      activeForces.push({ id: forceId, targetLabel, vector, continuous });
      renderForceList();

      emit('apexfbd:forceapply', { forceId, targetId: targetSelect.value, vector, point, continuous });
      toast(`Force applied to ${targetLabel}`);
    });

    function renderForceList() {
      if (!listEl) return;
      if (activeForces.length === 0) {
        listEl.innerHTML = '<li class="mini-list-empty">No forces applied yet.</li>';
        return;
      }
      listEl.innerHTML = '';
      activeForces.forEach((f) => {
        const li = document.createElement('li');
        li.className = 'preset-item';
        li.style.display = 'flex';
        li.style.alignItems = 'center';
        li.style.justifyContent = 'space-between';
        const mag = Math.hypot(f.vector.x, f.vector.y, f.vector.z).toFixed(1);
        li.innerHTML = `<span class="mono">${f.targetLabel} · ${mag} N${f.continuous ? ' · continuous' : ''}</span>`;
        const removeBtn = document.createElement('button');
        removeBtn.className = 'icon-btn icon-btn--sm';
        removeBtn.title = 'Remove force';
        removeBtn.textContent = '×';
        on(removeBtn, 'click', () => {
          const idx = activeForces.findIndex((x) => x.id === f.id);
          if (idx > -1) activeForces.splice(idx, 1);
          renderForceList();
          emit('apexfbd:forceclear', { forceId: f.id });
        });
        li.appendChild(removeBtn);
        listEl.appendChild(li);
      });
    }

    // physics.js calls this whenever the object roster changes
    FBD.updateObjectList = (objects) => {
      if (!targetSelect) return;
      const currentValue = targetSelect.value;
      targetSelect.innerHTML = '<option value="">— Select object —</option>';
      (objects || []).forEach((obj) => {
        const opt = document.createElement('option');
        opt.value = obj.id;
        opt.textContent = obj.label;
        targetSelect.appendChild(opt);
      });
      if ([...targetSelect.options].some((o) => o.value === currentValue)) {
        targetSelect.value = currentValue;
      }
    };
  }

  /* ============================================================
     ENVIRONMENT PANEL
  ============================================================ */
  function initEnvironmentPanel() {
    bindRangeOutput('#env-gravity', '#env-gravity-value', 2);
    bindRangeOutput('#env-friction', '#env-friction-value', 2);
    bindRangeOutput('#env-restitution', '#env-restitution-value', 2);
    bindRangeOutput('#env-drag', '#env-drag-value', 2);

    const gravityDirSelect = qs('#env-gravity-dir');
    let customVectorRow = null;

    on(gravityDirSelect, 'change', () => {
      toggleCustomVectorFields(gravityDirSelect.value === 'custom');
      broadcastEnvironment();
    });

    function toggleCustomVectorFields(show) {
      if (show && !customVectorRow) {
        customVectorRow = document.createElement('div');
        customVectorRow.className = 'field-row';
        customVectorRow.id = 'env-gravity-custom-row';
        customVectorRow.innerHTML = `
          <input type="number" id="env-gravity-custom-x" step="0.1" value="0" placeholder="Gx" />
          <input type="number" id="env-gravity-custom-y" step="0.1" value="-9.81" placeholder="Gy" />
          <input type="number" id="env-gravity-custom-z" step="0.1" value="0" placeholder="Gz" class="z-field" />
        `;
        gravityDirSelect.closest('.field').insertAdjacentElement('afterend', customVectorRow);
        qsa('input', customVectorRow).forEach((inp) => on(inp, 'input', broadcastEnvironment));
      }
      if (customVectorRow) customVectorRow.hidden = !show;
    }

    const windCheckbox = qs('#env-wind-enabled');
    const windFields = qs('#env-wind-fields');
    on(windCheckbox, 'change', () => {
      if (windFields) windFields.hidden = !windCheckbox.checked;
      broadcastEnvironment();
    });

    ['#env-gravity', '#env-friction', '#env-restitution', '#env-drag', '#env-wind-x', '#env-wind-y', '#env-wind-z'].forEach((sel) => {
      on(qs(sel), 'input', broadcastEnvironment);
    });

    function broadcastEnvironment() {
      emit('apexfbd:environmentchange', {
        gravity: numVal('#env-gravity', 9.81),
        gravityDir: gravityDirSelect ? gravityDirSelect.value : '-y',
        gravityCustom: customVectorRow ? {
          x: numVal('#env-gravity-custom-x', 0),
          y: numVal('#env-gravity-custom-y', -9.81),
          z: numVal('#env-gravity-custom-z', 0),
        } : null,
        friction: numVal('#env-friction', 0.4),
        restitution: numVal('#env-restitution', 0.3),
        drag: numVal('#env-drag', 0.05),
        wind: windCheckbox && windCheckbox.checked
          ? { x: numVal('#env-wind-x', 0), y: numVal('#env-wind-y', 0), z: numVal('#env-wind-z', 0) }
          : null,
      });
    }

    function bindRangeOutput(rangeSel, outputSel, decimals) {
      const range = qs(rangeSel);
      const output = qs(outputSel);
      if (!range || !output) return;
      const update = () => { output.textContent = Number(range.value).toFixed(decimals); };
      update();
      on(range, 'input', () => { update(); broadcastEnvironment(); });
    }
  }

  /* ============================================================
     PRESETS PANEL
  ============================================================ */
  function initPresetsPanel() {
    const items = qsa('.preset-item');
    const loadBtn = qs('#btn-load-preset');
    const difficultySelect = qs('#preset-difficulty');
    let selectedPreset = null;

    items.forEach((item) => {
      on(item, 'click', () => {
        items.forEach((i) => i.classList.toggle('is-active', i === item));
        selectedPreset = item.dataset.preset;
        if (loadBtn) loadBtn.disabled = false;
      });
    });

    on(loadBtn, 'click', () => {
      if (!selectedPreset) return;
      emit('apexfbd:presetload', {
        presetId: selectedPreset,
        difficulty: difficultySelect ? difficultySelect.value : 'jee-main',
      });
      toast(`Loading preset: ${selectedPreset.replace(/-/g, ' ')}`);
    });
  }

  /* ============================================================
     SENSORS PANEL (drag chips onto the canvas — canvas drop target
     is registered by render.js; this just supplies drag data)
  ============================================================ */
  function initSensorsPanel() {
    qsa('.sensor-chip').forEach((chip) => {
      on(chip, 'dragstart', (e) => {
        e.dataTransfer.setData('text/apexfbd-sensor', chip.dataset.sensor);
        e.dataTransfer.effectAllowed = 'copy';
      });
    });

    FBD.updateSensorReadouts = (list) => {
      const container = qs('#sensor-readout-list');
      if (!container) return;
      if (!list || list.length === 0) {
        container.innerHTML = '<p class="mini-list-empty">No sensors attached yet.</p>';
        return;
      }
      container.innerHTML = '';
      list.forEach((s) => {
        const row = document.createElement('div');
        row.className = 'field-with-value';
        row.innerHTML = `<span style="flex:1;font-size:12px;color:var(--text-secondary);">${s.label}</span><output>${s.value}${s.unit || ''}</output>`;
        container.appendChild(row);
      });
    };
  }

  /* ============================================================
     INSPECTOR PANEL (floating; populated by physics.js/render.js)
  ============================================================ */
  function initInspectorPanel() {
    const panel = qs('#inspector-panel');
    const closeBtn = qs('#inspector-close');
    const deleteBtn = qs('#insp-delete');
    let currentObjectId = null;

    on(closeBtn, 'click', hideInspector);
    on(deleteBtn, 'click', () => {
      if (currentObjectId) emit('apexfbd:inspectordelete', { objectId: currentObjectId });
      hideInspector();
    });

    ['#insp-mass', '#insp-pos-x', '#insp-pos-y', '#insp-pos-z', '#insp-restitution'].forEach((sel) => {
      on(qs(sel), 'input', () => {
        if (!currentObjectId) return;
        emit('apexfbd:inspectorupdate', {
          objectId: currentObjectId,
          mass: numVal('#insp-mass', 1),
          position: { x: numVal('#insp-pos-x', 0), y: numVal('#insp-pos-y', 0), z: numVal('#insp-pos-z', 0) },
          restitution: numVal('#insp-restitution', 0.3),
        });
      });
    });

    function showInspector(obj) {
      if (!panel || !obj) return;
      currentObjectId = obj.id;
      qs('#inspector-title').textContent = obj.label || 'Object';
      setVal('#insp-mass', obj.mass ?? 1);
      setVal('#insp-pos-x', obj.position?.x ?? 0);
      setVal('#insp-pos-y', obj.position?.y ?? 0);
      setVal('#insp-pos-z', obj.position?.z ?? 0);
      setVal('#insp-restitution', obj.restitution ?? 0.3);
      panel.hidden = false;
    }
    function hideInspector() {
      if (panel) panel.hidden = true;
      currentObjectId = null;
    }
    FBD.showInspector = showInspector;
    FBD.hideInspector = hideInspector;
  }

  /* ============================================================
     PYSCRIPT CONSOLE DRAWER
  ============================================================ */
  function initPyConsole() {
    const drawer = qs('#py-console');
    const toggleBtn = qs('#py-console-toggle');
    const runBtn = qs('#py-run');
    const clearBtn = qs('#py-clear');
    const input = qs('#py-input');
    const output = qs('#py-output');

    on(toggleBtn, 'click', () => {
      const open = drawer.dataset.open === 'true';
      drawer.dataset.open = String(!open);
    });

    on(runBtn, 'click', () => {
      const code = input ? input.value : '';
      if (!code.trim()) return;
      if (window.pyscript && typeof window.pyscript.interpreter !== 'undefined') {
        fireAndForget(() => {
          window.pyscript.interpreter.interface.runPython(code);
        });
      } else {
        appendOutput('# PyScript engine not yet loaded — this console is wired but the runtime attaches in physics.js.');
      }
    });

    on(clearBtn, 'click', () => { if (output) output.textContent = ''; });

    function appendOutput(text) {
      if (!output) return;
      output.textContent += (output.textContent ? '\n' : '') + text;
      output.scrollTop = output.scrollHeight;
    }
  }

  /* ============================================================
     CLEAR SCENE
  ============================================================ */
  function initClearScene() {
    on(qs('#btn-clear-scene'), 'click', () => {
      if (confirm('Clear all objects from the scene? This cannot be undone.')) {
        emit('apexfbd:clearscene');
        FBD.hideInspector && FBD.hideInspector();
        toast('Scene cleared');
      }
    });
  }

  /* ============================================================
     WORKSPACE PERSISTENCE (IndexedDB)
  ============================================================ */
  const DB_NAME = 'apexfbd-db';
  const DB_VERSION = 1;
  const STORE = 'workspaces';

  function openDb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          const store = db.createObjectStore(STORE, { keyPath: 'id' });
          store.createIndex('savedAt', 'savedAt');
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function saveWorkspace(name, sceneState) {
    const db = await openDb();
    const record = { id: `ws_${Date.now()}`, name, savedAt: new Date().toISOString(), sceneState };
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(record);
      tx.oncomplete = () => resolve(record);
      tx.onerror = () => reject(tx.error);
    });
  }

  async function listWorkspaces() {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).getAll();
      req.onsuccess = () => resolve(req.result.sort((a, b) => b.savedAt.localeCompare(a.savedAt)));
      req.onerror = () => reject(req.error);
    });
  }

  async function deleteWorkspace(id) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  function initWorkspaceModal() {
    const modal = qs('#workspace-modal');
    const closeBtn = qs('#workspace-modal-close');
    const nameInput = qs('#workspace-name-input');
    const saveConfirmBtn = qs('#workspace-save-confirm');
    const listEl = qs('#workspace-list');
    const labelText = qs('#workspace-label-text');

    on(qs('#btn-save-workspace'), 'click', () => openModal('save'));
    on(qs('#btn-load-workspace'), 'click', () => openModal('load'));
    on(qs('#btn-new-workspace'), 'click', () => {
      if (confirm('Start a new workspace? Unsaved changes will be lost.')) {
        emit('apexfbd:clearscene');
        if (labelText) labelText.textContent = 'Untitled Workspace';
        toast('New workspace started');
      }
    });
    on(closeBtn, 'click', closeModal);
    on(modal, 'click', (e) => { if (e.target === modal) closeModal(); });
    on(document, 'keydown', (e) => { if (e.key === 'Escape' && !modal.hidden) closeModal(); });

    on(saveConfirmBtn, 'click', async () => {
      const name = (nameInput.value || 'Untitled Workspace').trim();
      const sceneState = fireAndForget(() => FBD.getSceneState ? FBD.getSceneState() : {}) || {};
      try {
        await saveWorkspace(name, sceneState);
        if (labelText) labelText.textContent = name;
        toast(`Saved "${name}"`, 'success');
        closeModal();
      } catch (err) {
        console.error(err);
        toast('Failed to save workspace', 'error');
      }
    });

    async function openModal(mode) {
      modal.hidden = false;
      qs('#workspace-modal-title').textContent = mode === 'save' ? 'Save Workspace' : 'Load Workspace';
      saveConfirmBtn.hidden = mode !== 'save';
      if (mode === 'save') nameInput.focus();
      await refreshList();
    }
    function closeModal() { modal.hidden = true; }

    async function refreshList() {
      try {
        const items = await listWorkspaces();
        if (items.length === 0) {
          listEl.innerHTML = '<li class="mini-list-empty">No saved workspaces yet.</li>';
          return;
        }
        listEl.innerHTML = '';
        items.forEach((item) => {
          const li = document.createElement('li');
          li.className = 'preset-item';
          li.style.display = 'flex';
          li.style.alignItems = 'center';
          li.style.justifyContent = 'space-between';
          const date = new Date(item.savedAt).toLocaleString();
          li.innerHTML = `
            <span>
              <span class="preset-item-title">${item.name}</span>
              <span class="preset-item-desc">${date}</span>
            </span>
          `;
          const btnRow = document.createElement('div');
          btnRow.style.display = 'flex';
          btnRow.style.gap = '4px';

          const loadBtn = document.createElement('button');
          loadBtn.className = 'btn btn--ghost btn--sm';
          loadBtn.textContent = 'Load';
          on(loadBtn, 'click', () => {
            emit('apexfbd:workspaceload', { sceneState: item.sceneState });
            fireAndForget(() => FBD.loadSceneState && FBD.loadSceneState(item.sceneState));
            if (labelText) labelText.textContent = item.name;
            toast(`Loaded "${item.name}"`, 'success');
            closeModal();
          });

          const delBtn = document.createElement('button');
          delBtn.className = 'icon-btn icon-btn--sm';
          delBtn.title = 'Delete';
          delBtn.textContent = '×';
          on(delBtn, 'click', async () => {
            await deleteWorkspace(item.id);
            refreshList();
          });

          btnRow.appendChild(loadBtn);
          btnRow.appendChild(delBtn);
          li.appendChild(btnRow);
          listEl.appendChild(li);
        });
      } catch (err) {
        console.error(err);
        listEl.innerHTML = '<li class="mini-list-empty">Could not load workspaces.</li>';
      }
    }
  }

  // Default hooks so physics.js can override, but nothing throws if it hasn't loaded yet
  FBD.getSceneState = FBD.getSceneState || (() => ({}));
  FBD.loadSceneState = FBD.loadSceneState || (() => {});

  /* ============================================================
     HELPERS
  ============================================================ */
  function numVal(sel, fallback) {
    const el = qs(sel);
    if (!el || el.value === '') return fallback ?? 0;
    const n = Number(el.value);
    return Number.isFinite(n) ? n : (fallback ?? 0);
  }
  function setVal(sel, value) {
    const el = qs(sel);
    if (el) el.value = value;
  }

  /* ============================================================
     INIT
  ============================================================ */
  document.addEventListener('DOMContentLoaded', () => {
    initDarkMode();
    initDimensionSwitch();
    initDropdowns();
    initAccordion();
    initTimeEngine();
    initViewportHud();
    initSpawnPanel();
    initForcesPanel();
    initEnvironmentPanel();
    initPresetsPanel();
    initSensorsPanel();
    initInspectorPanel();
    initPyConsole();
    initClearScene();
    initWorkspaceModal();

    console.info('[ApexFBD] UI ready.');
  });
})();
