// Browser frontend for the CeladonCity wasm build.
//
// The wasm module exposes a flat C ABI (see platforms/web/main.cc). This file
// owns the frame clock, the canvas, the audio graph, input, and persistence.

(function () {
    'use strict';

    const GB_WIDTH = 160;
    const GB_HEIGHT = 144;
    const SAMPLE_RATE = 44100;

    // Button codes mirror the GbButton enum in src/input.h.
    const BUTTON = {
        Up: 0, Down: 1, Left: 2, Right: 3,
        A: 4, B: 5, Select: 6, Start: 7,
    };

    const PALETTES = ['DMG', 'Pocket', 'Grayscale', 'Celadon'];

    // Audio pacing. The worklet reports how many stereo pairs it still holds;
    // we nudge the frame rate to keep it near TARGET so video stays locked to
    // the audio clock without drifting.
    const AUDIO_TARGET = 4096;   // ~93 ms
    const AUDIO_LOW = 2048;
    const AUDIO_HIGH = 7168;

    const FAST_FORWARD_RATE = 4;
    const SAVE_DEBOUNCE_FRAMES = 120;

    const ASSET_BASE = '/emu/';
    const DEMO_ROM = ASSET_BASE + 'libbet.gb';

    // ── State ────────────────────────────────────────────────────────────────

    let Module = null;
    let romLoaded = false;
    let paused = false;
    let fastForward = false;
    let romKey = null;
    let romName = '';
    let audioLevel = 0;
    let saveCountdown = -1;

    let audioCtx = null;
    let audioNode = null;
    let audioReady = false;

    let canvas, ctx, imageData;

    // ── Persistence (localStorage, base64-encoded) ───────────────────────────

    function bytesToBase64(bytes) {
        let binary = '';
        const chunk = 0x8000;
        for (let i = 0; i < bytes.length; i += chunk) {
            binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
        }
        return btoa(binary);
    }

    function base64ToBytes(text) {
        const binary = atob(text);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        return bytes;
    }

    function storageRead(key) {
        try {
            const value = localStorage.getItem(key);
            return value ? base64ToBytes(value) : null;
        } catch (e) {
            return null;
        }
    }

    function storageWrite(key, bytes) {
        try {
            localStorage.setItem(key, bytesToBase64(bytes));
            return true;
        } catch (e) {
            // Most likely QuotaExceededError.
            status('Storage full — could not save.');
            return false;
        }
    }

    // FNV-1a over the ROM, enough to key saves per-cartridge.
    function hashRom(bytes) {
        let h = 0x811c9dc5;
        for (let i = 0; i < bytes.length; i++) {
            h ^= bytes[i];
            h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
        }
        return h.toString(16).padStart(8, '0');
    }

    const savKey = () => 'ccity:sav:' + romKey;
    const stateKey = (slot) => 'ccity:state:' + romKey + ':' + slot;

    // ── Wasm buffer helpers ──────────────────────────────────────────────────

    // Copies bytes into the module's scratch buffer. HEAPU8 is re-read after
    // the call because allocating may have grown (and detached) the heap.
    function writeInput(parts) {
        const total = parts.reduce((n, p) => n + p.length, 0);
        const ptr = Module._gb_input_buffer(total);
        let offset = ptr;
        for (const part of parts) {
            Module.HEAPU8.set(part, offset);
            offset += part.length;
        }
        return ptr;
    }

    function readCartRam() {
        const size = Module._gb_ram_size();
        if (size <= 0) return null;
        const ptr = Module._gb_ram_ptr();
        if (!ptr) return null;
        return new Uint8Array(Module.HEAPU8.subarray(ptr, ptr + size));
    }

    // ── ROM loading ──────────────────────────────────────────────────────────

    function loadRom(bytes, name) {
        if (!Module) return;
        flushSave();

        romKey = hashRom(bytes);
        const save = storageRead(savKey());
        const parts = save ? [bytes, save] : [bytes];
        writeInput(parts);

        if (!Module._gb_load_rom(bytes.length, save ? save.length : 0)) {
            status('Failed to load ROM.');
            return;
        }

        const title = Module.UTF8ToString(Module._gb_rom_title());
        romName = title || name || 'ROM';
        romLoaded = true;
        paused = false;
        saveCountdown = -1;

        if (audioNode) audioNode.port.postMessage('reset');
        updateChrome();
        status('Loaded ' + romName + (save ? ' (save restored)' : ''));
    }

    function resetRom() {
        if (!romLoaded) return;
        // Carry battery RAM across the reset the way a real cartridge would.
        const ram = Module._gb_has_battery() ? readCartRam() : null;
        if (ram) writeInput([ram]);
        Module._gb_reset(ram ? ram.length : 0);
        if (audioNode) audioNode.port.postMessage('reset');
        status('Reset');
    }

    // ── Battery saves ────────────────────────────────────────────────────────

    function tickSave() {
        if (!Module._gb_has_battery()) return;
        if (Module._gb_ram_dirty()) {
            Module._gb_clear_ram_dirty();
            saveCountdown = SAVE_DEBOUNCE_FRAMES;
        }
        if (saveCountdown > 0 && --saveCountdown === 0) {
            flushSave();
        }
    }

    function flushSave() {
        if (!romLoaded || !romKey || !Module._gb_has_battery()) return;
        const ram = readCartRam();
        if (ram && ram.length) storageWrite(savKey(), ram);
        saveCountdown = -1;
    }

    // ── Save states ──────────────────────────────────────────────────────────

    function saveState(slot) {
        if (!romLoaded) return;
        const size = Module._gb_save_state();
        if (size <= 0) return;
        const ptr = Module._gb_state_ptr();
        const bytes = new Uint8Array(Module.HEAPU8.subarray(ptr, ptr + size));
        if (storageWrite(stateKey(slot), bytes)) {
            status('Saved state ' + slot);
            refreshSlots();
        }
    }

    function loadState(slot) {
        if (!romLoaded) return;
        const bytes = storageRead(stateKey(slot));
        if (!bytes) {
            status('Slot ' + slot + ' is empty');
            return;
        }
        writeInput([bytes]);
        if (Module._gb_load_state(bytes.length)) {
            if (audioNode) audioNode.port.postMessage('reset');
            status('Loaded state ' + slot);
        }
    }

    // ── Audio ────────────────────────────────────────────────────────────────

    async function initAudio() {
        if (audioReady || audioCtx) return;
        try {
            audioCtx = new (window.AudioContext || window.webkitAudioContext)({
                sampleRate: SAMPLE_RATE,
            });
            await audioCtx.audioWorklet.addModule(ASSET_BASE + 'gb-audio-worklet.js');
            audioNode = new AudioWorkletNode(audioCtx, 'gb-audio', {
                outputChannelCount: [2],
            });
            audioNode.port.onmessage = (e) => { audioLevel = e.data; };
            audioNode.connect(audioCtx.destination);
            audioReady = true;
            updateChrome();
        } catch (e) {
            console.warn('audio unavailable:', e);
            audioReady = false;
        }
    }

    // Browsers block audio until a gesture, so this is wired to the first
    // click or keypress.
    function unlockAudio() {
        if (!audioReady) {
            initAudio().then(() => { if (audioCtx) audioCtx.resume(); });
        } else if (audioCtx.state === 'suspended') {
            audioCtx.resume();
        }
        updateChrome();
    }

    function pumpAudio(discard) {
        const pairs = Module._gb_audio_drain();
        if (pairs <= 0 || discard || !audioNode) return;
        const ptr = Module._gb_audio_ptr();
        const start = ptr >> 2;
        const copy = new Float32Array(Module.HEAPF32.subarray(start, start + pairs * 2));
        audioNode.port.postMessage(copy, [copy.buffer]);
    }

    // ── Frame loop ───────────────────────────────────────────────────────────

    function framesThisTick() {
        if (fastForward) return FAST_FORWARD_RATE;
        if (!audioReady || !audioCtx || audioCtx.state !== 'running') return 1;
        // Steer toward AUDIO_TARGET: run an extra frame when starved, skip one
        // when the buffer has run ahead.
        if (audioLevel < AUDIO_LOW) return 2;
        if (audioLevel > AUDIO_HIGH) return 0;
        return 1;
    }

    function draw() {
        const ptr = Module._gb_framebuffer();
        const size = GB_WIDTH * GB_HEIGHT * 4;
        imageData.data.set(Module.HEAPU8.subarray(ptr, ptr + size));
        ctx.putImageData(imageData, 0, 0);
    }

    function loop() {
        requestAnimationFrame(loop);
        if (!romLoaded || paused) return;

        const count = framesThisTick();
        for (let i = 0; i < count; i++) {
            Module._gb_run_frame();
            // Audio is dropped while fast-forwarding; pushing 4x the samples
            // would just overrun the ring and stutter.
            pumpAudio(fastForward);
            tickSave();
        }
        if (count > 0) draw();
    }

    // ── Input ────────────────────────────────────────────────────────────────

    const KEY_MAP = {
        ArrowUp: BUTTON.Up,
        ArrowDown: BUTTON.Down,
        ArrowLeft: BUTTON.Left,
        ArrowRight: BUTTON.Right,
        KeyZ: BUTTON.A,
        KeyX: BUTTON.B,
        Enter: BUTTON.Start,
        Backspace: BUTTON.Select,
    };

    function setButton(code, pressed) {
        if (!romLoaded) return;
        Module._gb_set_button(code, pressed ? 1 : 0);
    }

    function onKey(event, pressed) {
        unlockAudio();

        const slot = /^F(\d{1,2})$/.exec(event.code);
        if (slot && pressed) {
            const n = parseInt(slot[1], 10);
            if (n >= 1 && n <= 12) {
                event.preventDefault();
                if (event.shiftKey) saveState(n); else loadState(n);
                return;
            }
        }

        if (pressed && event.code === 'KeyP') { togglePause(); return; }
        if (event.code === 'Space') {
            event.preventDefault();
            fastForward = pressed;
            updateChrome();
            return;
        }

        const button = KEY_MAP[event.code];
        if (button === undefined) return;
        event.preventDefault();
        setButton(button, pressed);
    }

    function bindTouch(element, code) {
        const press = (e) => { e.preventDefault(); unlockAudio(); setButton(code, true); };
        const release = (e) => { e.preventDefault(); setButton(code, false); };
        element.addEventListener('touchstart', press, { passive: false });
        element.addEventListener('touchend', release, { passive: false });
        element.addEventListener('touchcancel', release, { passive: false });
        element.addEventListener('mousedown', press);
        element.addEventListener('mouseup', release);
        element.addEventListener('mouseleave', release);
    }

    // ── UI ───────────────────────────────────────────────────────────────────

    let statusEl, pauseBtn, ffBtn, slotsEl, titleEl;

    function status(message) {
        if (statusEl) statusEl.textContent = message;
    }

    function togglePause() {
        if (!romLoaded) return;
        paused = !paused;
        if (audioNode) audioNode.port.postMessage('reset');
        updateChrome();
    }

    function updateChrome() {
        if (pauseBtn) pauseBtn.textContent = paused ? 'Resume' : 'Pause';
        if (ffBtn) ffBtn.classList.toggle('active', fastForward);
        if (titleEl) titleEl.textContent = romLoaded ? romName : 'No ROM loaded';
    }

    function refreshSlots() {
        if (!slotsEl || !romKey) return;
        for (const button of slotsEl.querySelectorAll('[data-slot]')) {
            const slot = button.getAttribute('data-slot');
            button.classList.toggle('filled', !!localStorage.getItem(stateKey(slot)));
        }
    }

    function setupUi() {
        canvas = document.getElementById('gb-canvas');
        canvas.width = GB_WIDTH;
        canvas.height = GB_HEIGHT;
        ctx = canvas.getContext('2d');
        ctx.imageSmoothingEnabled = false;
        imageData = ctx.createImageData(GB_WIDTH, GB_HEIGHT);

        statusEl = document.getElementById('gb-status');
        pauseBtn = document.getElementById('gb-pause');
        ffBtn = document.getElementById('gb-ff');
        slotsEl = document.getElementById('gb-slots');
        titleEl = document.getElementById('gb-title');

        pauseBtn.addEventListener('click', () => { unlockAudio(); togglePause(); });
        document.getElementById('gb-reset').addEventListener('click', () => {
            unlockAudio();
            resetRom();
        });

        // Fast-forward is hold-to-activate, matching the Space key.
        const ffOn = (e) => { e.preventDefault(); fastForward = true; updateChrome(); };
        const ffOff = (e) => { e.preventDefault(); fastForward = false; updateChrome(); };
        ffBtn.addEventListener('mousedown', ffOn);
        ffBtn.addEventListener('mouseup', ffOff);
        ffBtn.addEventListener('mouseleave', ffOff);
        ffBtn.addEventListener('touchstart', ffOn, { passive: false });
        ffBtn.addEventListener('touchend', ffOff, { passive: false });

        document.getElementById('gb-fullscreen').addEventListener('click', () => {
            const shell = document.getElementById('gb-stage');
            if (document.fullscreenElement) document.exitFullscreen();
            else if (shell.requestFullscreen) shell.requestFullscreen();
        });

        const paletteSelect = document.getElementById('gb-palette');
        PALETTES.forEach((name, index) => {
            const option = document.createElement('option');
            option.value = String(index);
            option.textContent = name;
            paletteSelect.appendChild(option);
        });
        paletteSelect.addEventListener('change', () => {
            Module._gb_set_palette(parseInt(paletteSelect.value, 10));
            if (paused || !romLoaded) draw();
        });

        // Save-state slots: click loads, shift-click saves.
        for (let slot = 1; slot <= 12; slot++) {
            const button = document.createElement('button');
            button.className = 'slot';
            button.setAttribute('data-slot', String(slot));
            button.textContent = String(slot);
            button.title = 'Click to load slot ' + slot + ', shift-click to save';
            button.addEventListener('click', (e) => {
                unlockAudio();
                if (e.shiftKey) saveState(slot); else loadState(slot);
            });
            slotsEl.appendChild(button);
        }

        const fileInput = document.getElementById('gb-file');
        document.getElementById('gb-open').addEventListener('click', () => fileInput.click());
        fileInput.addEventListener('change', (e) => {
            const file = e.target.files && e.target.files[0];
            if (file) readRomFile(file);
        });

        // Drag and drop anywhere on the stage.
        const stage = document.getElementById('gb-stage');
        stage.addEventListener('dragover', (e) => {
            e.preventDefault();
            stage.classList.add('dragging');
        });
        stage.addEventListener('dragleave', () => stage.classList.remove('dragging'));
        stage.addEventListener('drop', (e) => {
            e.preventDefault();
            stage.classList.remove('dragging');
            const file = e.dataTransfer.files && e.dataTransfer.files[0];
            if (file) readRomFile(file);
        });

        for (const element of document.querySelectorAll('[data-btn]')) {
            const code = BUTTON[element.getAttribute('data-btn')];
            if (code !== undefined) bindTouch(element, code);
        }

        window.addEventListener('keydown', (e) => onKey(e, true));
        window.addEventListener('keyup', (e) => onKey(e, false));
        stage.addEventListener('click', unlockAudio);

        // Persist battery RAM if the tab goes away mid-game.
        window.addEventListener('pagehide', flushSave);
        document.addEventListener('visibilitychange', () => {
            if (document.hidden) flushSave();
        });
    }

    function readRomFile(file) {
        const reader = new FileReader();
        reader.onload = () => {
            unlockAudio();
            loadRom(new Uint8Array(reader.result), file.name);
            refreshSlots();
        };
        reader.readAsArrayBuffer(file);
    }

    // ── Boot ─────────────────────────────────────────────────────────────────

    function boot() {
        setupUi();
        status('Loading emulator…');

        createCeladonCity().then((instance) => {
            Module = instance;
            status('Ready — press a key or click to enable sound.');
            requestAnimationFrame(loop);

            return fetch(DEMO_ROM)
                .then((response) => {
                    if (!response.ok) throw new Error('HTTP ' + response.status);
                    return response.arrayBuffer();
                })
                .then((buffer) => {
                    loadRom(new Uint8Array(buffer), DEMO_ROM);
                    refreshSlots();
                })
                .catch(() => {
                    status('Drop a .gb file here or click Open ROM to start.');
                });
        }).catch((error) => {
            console.error(error);
            status('Failed to load the emulator: ' + error.message);
        });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot);
    } else {
        boot();
    }
})();
