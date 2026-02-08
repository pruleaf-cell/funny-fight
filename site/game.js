(() => {
  "use strict";

  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const lerp = (a, b, t) => a + (b - a) * t;
  const rand = (a, b) => a + Math.random() * (b - a);
  const now = () => performance.now();

  function rectsOverlap(a, b) {
    return (
      a.x < b.x + b.w &&
      a.x + a.w > b.x &&
      a.y < b.y + b.h &&
      a.y + a.h > b.y
    );
  }

  function noteFreq(note) {
    // note like "E2", "A#3"
    const m = /^([A-G])(#|b)?(\d+)$/.exec(note);
    if (!m) return 440;
    const n = m[1];
    const accidental = m[2] || "";
    const octave = Number(m[3]);
    const semis =
      ({
        C: 0,
        D: 2,
        E: 4,
        F: 5,
        G: 7,
        A: 9,
        B: 11,
      }[n] ?? 9) +
      (accidental === "#" ? 1 : accidental === "b" ? -1 : 0);
    const midi = (octave + 1) * 12 + semis;
    return 440 * Math.pow(2, (midi - 69) / 12);
  }

  class RetroAudio {
    constructor() {
      this.ctx = null;
      this.master = null;
      this.musicGain = null;
      this.sfxGain = null;
      this.enabled = true;
      this.musicStarted = false;

      this._tickTimer = null;
      this._nextNoteTime = 0;
      this._step = 0;
      this._tempo = 148;
      this._swing = 0.12;

      this._noise = null;
    }

    init() {
      if (this.ctx) return;
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      this.ctx = new Ctx();

      const master = this.ctx.createGain();
      master.gain.value = this.enabled ? 0.95 : 0.0;
      master.connect(this.ctx.destination);
      this.master = master;

      const comp = this.ctx.createDynamicsCompressor();
      comp.threshold.value = -18;
      comp.knee.value = 18;
      comp.ratio.value = 6;
      comp.attack.value = 0.003;
      comp.release.value = 0.12;
      comp.connect(master);

      const drive = this.ctx.createWaveShaper();
      drive.curve = this._makeDriveCurve(240);
      drive.oversample = "2x";
      drive.connect(comp);

      const musicGain = this.ctx.createGain();
      musicGain.gain.value = 0.55;
      musicGain.connect(drive);
      this.musicGain = musicGain;

      const sfxGain = this.ctx.createGain();
      sfxGain.gain.value = 0.95;
      sfxGain.connect(drive);
      this.sfxGain = sfxGain;

      this._noise = this._makeNoiseBuffer();
    }

    async unlock() {
      this.init();
      if (!this.ctx) return;
      if (this.ctx.state === "suspended") {
        try {
          await this.ctx.resume();
        } catch (_) {
          // ignore
        }
      }
    }

    setEnabled(v) {
      this.enabled = !!v;
      if (this.master) this.master.gain.value = this.enabled ? 0.95 : 0.0;
    }

    startMusic() {
      this.init();
      if (!this.ctx || this.musicStarted) return;
      this.musicStarted = true;
      this._step = 0;
      this._nextNoteTime = this.ctx.currentTime + 0.05;
      this._tickTimer = window.setInterval(() => this._scheduler(), 25);
    }

    stopMusic() {
      if (this._tickTimer) {
        window.clearInterval(this._tickTimer);
        this._tickTimer = null;
      }
      this.musicStarted = false;
    }

    _scheduler() {
      if (!this.ctx) return;
      const scheduleAhead = 0.14;
      while (this._nextNoteTime < this.ctx.currentTime + scheduleAhead) {
        this._scheduleStep(this._step, this._nextNoteTime);
        const baseStepDur = (60 / this._tempo) / 4; // 16th
        const swing = (this._step % 2 === 1 ? this._swing : -this._swing) * baseStepDur;
        this._nextNoteTime += baseStepDur + swing;
        this._step = (this._step + 1) % 32;
      }
    }

    _scheduleStep(step, t) {
      // Patterns are intentionally cheesy.
      const bass = [
        "E2", 0, "E2", 0, "G2", 0, "E2", 0,
        "A1", 0, "A1", 0, "B1", 0, "C2", 0,
        "E2", 0, "E2", 0, "G2", 0, "E2", 0,
        "D2", 0, "D2", 0, "C2", 0, "B1", 0,
      ];
      const lead = [
        0, 0, "E4", 0, 0, "G4", 0, 0,
        "A4", 0, 0, "B4", 0, 0, "C5", 0,
        0, 0, "B4", 0, 0, "A4", 0, 0,
        "G4", 0, 0, "E4", 0, 0, "D4", 0,
      ];

      const b = bass[step];
      if (b) this._tone({ t, freq: noteFreq(b), dur: 0.11, type: "square", gain: 0.15, cut: 650 });

      const l = lead[step];
      if (l) this._tone({ t, freq: noteFreq(l), dur: 0.08, type: "sawtooth", gain: 0.09, cut: 2400, vib: 7.5 });

      // Drums
      const s = step % 16;
      if (s === 0 || s === 8) this._kick(t, 0.55);
      if (s === 4 || s === 12) this._snare(t, 0.45);
      if (s % 2 === 0) this._hat(t, 0.18);
    }

    _tone({ t, freq, dur, type, gain, cut, vib }) {
      if (!this.ctx) return;
      const o = this.ctx.createOscillator();
      o.type = type;
      o.frequency.setValueAtTime(freq, t);
      if (vib) {
        const lfo = this.ctx.createOscillator();
        const lfoGain = this.ctx.createGain();
        lfo.frequency.setValueAtTime(vib, t);
        lfoGain.gain.setValueAtTime(freq * 0.01, t);
        lfo.connect(lfoGain);
        lfoGain.connect(o.frequency);
        lfo.start(t);
        lfo.stop(t + dur + 0.02);
      }

      const g = this.ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(gain, t + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);

      const f = this.ctx.createBiquadFilter();
      f.type = "lowpass";
      f.frequency.setValueAtTime(cut, t);
      f.Q.setValueAtTime(0.8, t);

      o.connect(f);
      f.connect(g);
      g.connect(this.musicGain);

      o.start(t);
      o.stop(t + dur + 0.02);
    }

    _kick(t, level) {
      if (!this.ctx) return;
      const o = this.ctx.createOscillator();
      o.type = "sine";
      o.frequency.setValueAtTime(160, t);
      o.frequency.exponentialRampToValueAtTime(48, t + 0.10);

      const g = this.ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(level, t + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.14);

      o.connect(g);
      g.connect(this.musicGain);
      o.start(t);
      o.stop(t + 0.16);
    }

    _snare(t, level) {
      if (!this.ctx || !this._noise) return;
      const src = this.ctx.createBufferSource();
      src.buffer = this._noise;

      const bp = this.ctx.createBiquadFilter();
      bp.type = "bandpass";
      bp.frequency.setValueAtTime(1450, t);
      bp.Q.setValueAtTime(0.9, t);

      const g = this.ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(level, t + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.12);

      src.connect(bp);
      bp.connect(g);
      g.connect(this.musicGain);
      src.start(t);
      src.stop(t + 0.13);
    }

    _hat(t, level) {
      if (!this.ctx || !this._noise) return;
      const src = this.ctx.createBufferSource();
      src.buffer = this._noise;

      const hp = this.ctx.createBiquadFilter();
      hp.type = "highpass";
      hp.frequency.setValueAtTime(6500, t);
      hp.Q.setValueAtTime(0.7, t);

      const g = this.ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(level, t + 0.003);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.04);

      src.connect(hp);
      hp.connect(g);
      g.connect(this.musicGain);
      src.start(t);
      src.stop(t + 0.05);
    }

    sfx(type, intensity = 1) {
      this.init();
      if (!this.ctx || !this.sfxGain) return;
      const t = this.ctx.currentTime + 0.001;
      switch (type) {
        case "punch":
          this._thwack(t, 0.10, 420 * intensity, 0.22);
          break;
        case "kick":
          this._thwack(t, 0.13, 260 * intensity, 0.28);
          break;
        case "hit":
          this._hitNoise(t, 0.08, 0.32 * intensity);
          break;
        case "block":
          this._hitNoise(t, 0.06, 0.18 * intensity);
          break;
        case "jump":
          this._whoop(t, 0.10, 280, 620, 0.18);
          break;
        case "special":
          this._whoop(t, 0.18, 180, 980, 0.28);
          this._hitNoise(t + 0.02, 0.10, 0.10);
          break;
        case "ko":
          this._whoop(t, 0.45, 120, 60, 0.40);
          break;
        default:
          break;
      }
    }

    _thwack(t, dur, freq, level) {
      const o = this.ctx.createOscillator();
      o.type = "square";
      o.frequency.setValueAtTime(freq, t);
      o.frequency.exponentialRampToValueAtTime(freq * 0.55, t + dur);

      const g = this.ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(level, t + 0.005);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);

      const f = this.ctx.createBiquadFilter();
      f.type = "lowpass";
      f.frequency.setValueAtTime(1800, t);
      f.Q.setValueAtTime(0.7, t);

      o.connect(f);
      f.connect(g);
      g.connect(this.sfxGain);
      o.start(t);
      o.stop(t + dur + 0.02);
    }

    _whoop(t, dur, from, to, level) {
      const o = this.ctx.createOscillator();
      o.type = "sawtooth";
      o.frequency.setValueAtTime(from, t);
      if (to > 0) o.frequency.exponentialRampToValueAtTime(Math.max(1, to), t + dur);

      const g = this.ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(level, t + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);

      const f = this.ctx.createBiquadFilter();
      f.type = "lowpass";
      f.frequency.setValueAtTime(2100, t);
      f.Q.setValueAtTime(0.8, t);

      o.connect(f);
      f.connect(g);
      g.connect(this.sfxGain);
      o.start(t);
      o.stop(t + dur + 0.03);
    }

    _hitNoise(t, dur, level) {
      if (!this._noise) return;
      const src = this.ctx.createBufferSource();
      src.buffer = this._noise;

      const hp = this.ctx.createBiquadFilter();
      hp.type = "highpass";
      hp.frequency.setValueAtTime(900, t);
      hp.Q.setValueAtTime(0.7, t);

      const g = this.ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(level, t + 0.003);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);

      src.connect(hp);
      hp.connect(g);
      g.connect(this.sfxGain);
      src.start(t);
      src.stop(t + dur + 0.01);
    }

    _makeNoiseBuffer() {
      const len = Math.floor(this.ctx.sampleRate * 1.0);
      const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const data = buf.getChannelData(0);
      for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * 0.75;
      return buf;
    }

    _makeDriveCurve(k) {
      // Simple non-linear curve. Larger k => more dirt.
      const n = 44100;
      const curve = new Float32Array(n);
      const deg = Math.PI / 180;
      for (let i = 0; i < n; i++) {
        const x = (i * 2) / (n - 1) - 1;
        curve[i] = ((3 + k) * x * 20 * deg) / (Math.PI + k * Math.abs(x));
      }
      return curve;
    }
  }

  class Input {
    constructor() {
      this.down = new Set();
      this.pressed = new Set();
      this._boundDown = (e) => this._onDown(e);
      this._boundUp = (e) => this._onUp(e);
      window.addEventListener("keydown", this._boundDown);
      window.addEventListener("keyup", this._boundUp);
    }

    destroy() {
      window.removeEventListener("keydown", this._boundDown);
      window.removeEventListener("keyup", this._boundUp);
    }

    _onDown(e) {
      const k = e.key;
      if (!this.down.has(k)) this.pressed.add(k);
      this.down.add(k);
      if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", " "].includes(k)) e.preventDefault();
    }

    _onUp(e) {
      this.down.delete(e.key);
    }

    consumePressed(k) {
      if (this.pressed.has(k)) {
        this.pressed.delete(k);
        return true;
      }
      return false;
    }

    clearPressed() {
      this.pressed.clear();
    }

    isDown(k) {
      return this.down.has(k);
    }
  }

  const VIEW_W = 480;
  const VIEW_H = 270;
  const CANVAS_W = 960;
  const CANVAS_H = 540;

  const STAGE_W = 1900;
  const FLOOR_Y = 228;
  const GRAV = 1500;

  const CHAR = {
    rohan: {
      id: "rohan",
      name: "ROHAN",
      ui: "ROHAN",
      c1: "#00e5ff",
      c2: "#b2ff59",
      speed: 300,
      jump: 680,
      punch: { dmg: 7, kb: 210 },
      kick: { dmg: 10, kb: 260 },
      special: { dmg: 14, kb: 210 },
    },
    dev: {
      id: "dev",
      name: "DEV",
      ui: "DEV",
      c1: "#ff3d8d",
      c2: "#ffd740",
      speed: 280,
      jump: 650,
      punch: { dmg: 8, kb: 220 },
      kick: { dmg: 11, kb: 275 },
      special: { dmg: 16, kb: 230 },
    },
  };

  const MOVES = {
    punch: { startup: 0.08, active: 0.10, recovery: 0.14, range: 56, h: 36 },
    kick: { startup: 0.11, active: 0.13, recovery: 0.18, range: 76, h: 42 },
    special: { startup: 0.16, active: 0.02, recovery: 0.22 },
  };

  function makeFighter(charId, x, side) {
    const c = CHAR[charId];
    return {
      charId,
      name: c.name,
      ui: c.ui,
      c1: c.c1,
      c2: c.c2,
      speed: c.speed,
      jump: c.jump,

      x,
      y: 0,
      vx: 0,
      vy: 0,
      facing: side, // 1 => right, -1 => left

      w: 46,
      h: 92,
      hp: 100,
      energy: 0,

      state: "idle",
      stateT: 0,
      onGround: true,
      hitstunT: 0,
      invulnT: 0,

      attack: null,
      attackHit: false,
      specialCooldown: 0,
    };
  }

  function fighterHurtbox(f, camX) {
    return {
      x: f.x - f.w / 2 - camX,
      y: FLOOR_Y - f.h - f.y,
      w: f.w,
      h: f.h,
    };
  }

  function fighterHurtboxWorld(f) {
    return {
      x: f.x - f.w / 2,
      y: -f.y - f.h, // relative to floor, y up => negative down
      w: f.w,
      h: f.h,
    };
  }

  function attackHitboxWorld(f, moveName) {
    const m = MOVES[moveName];
    if (!m) return null;
    const forward = f.facing;
    const hx = f.x + forward * (f.w * 0.35 + m.range * 0.5) - (m.range * 0.5);
    const hy = -f.y - (f.h * 0.72) - (m.h * 0.5);
    return { x: hx, y: hy, w: m.range, h: m.h };
  }

  function isBlocking(defender, attacker) {
    // Block when holding away + down (classic-ish), but keep it forgiving.
    const awayDir = attacker.x > defender.x ? -1 : 1; // which direction is "away" from attacker
    return defender._blockHeld && defender._moveDir === awayDir;
  }

  function aiInput(state, me, them) {
    const out = {
      move: 0,
      jump: false,
      block: false,
      punch: false,
      kick: false,
      special: false,
    };
    if (state.phase !== "fight") return out;
    if (me.hp <= 0 || them.hp <= 0) return out;
    if (me.hitstunT > 0) {
      out.block = true;
      out.move = (them.x > me.x ? -1 : 1);
      return out;
    }

    const dx = them.x - me.x;
    const dist = Math.abs(dx);
    const toward = dx > 0 ? 1 : -1;
    const away = -toward;
    const inPunch = dist < 92;
    const inKick = dist < 116;
    const inSpecial = dist < 420;

    // Occasionally do dumb jumps like an arcade CPU.
    if (me.onGround && Math.random() < 0.004 && dist < 240) out.jump = true;

    // If far, walk in.
    if (dist > 140) out.move = toward;
    // If close, do micro-shuffle.
    if (dist < 105 && Math.random() < 0.06) out.move = away;

    // Defense reaction
    if (them.attack && Math.random() < 0.35) {
      out.block = true;
      out.move = away;
    }

    // Attack decisions
    const canAct = !me.attack && me.specialCooldown <= 0;
    if (canAct) {
      if (inPunch && Math.random() < 0.06) out.punch = true;
      else if (inKick && Math.random() < 0.04) out.kick = true;
      else if (inSpecial && me.energy >= 45 && Math.random() < 0.018) out.special = true;
    }

    // If opponent is low, get extra rude.
    if (canAct && them.hp < 26 && inKick && Math.random() < 0.06) out.kick = true;

    return out;
  }

  class Game {
    constructor(canvas, hud, overlay, audio) {
      this.canvas = canvas;
      this.ctx = canvas.getContext("2d", { alpha: false });
      this.hud = hud;
      this.overlay = overlay;
      this.audio = audio;

      this.off = document.createElement("canvas");
      this.off.width = VIEW_W;
      this.off.height = VIEW_H;
      this.offCtx = this.off.getContext("2d", { alpha: false });

      this.input = new Input();

      this.cameraX = 0;
      this.shake = 0;
      this.shakeX = 0;
      this.shakeY = 0;

      this.projectiles = [];

      this.state = {
        phase: "pick", // pick|intro|fight|ko
        msg: "",
        timer: 99,
        introT: 0,
      };

      this.players = {
        human: null,
        ai: null,
      };

      this.f1 = null;
      this.f2 = null;

      this._last = now();
      this._acc = 0;
      this._running = false;

      // Simple background flavor
      this._skyline = this._makeSkyline();
      this._stars = this._makeStars();
    }

    _makeSkyline() {
      const blocks = [];
      let x = 0;
      while (x < STAGE_W) {
        const w = rand(28, 86);
        const h = rand(34, 120);
        blocks.push({ x, w, h, r: Math.random() });
        x += w + rand(6, 20);
      }
      return blocks;
    }

    _makeStars() {
      const n = 80;
      const s = [];
      for (let i = 0; i < n; i++) {
        s.push({
          x: rand(0, STAGE_W),
          y: rand(0, 110),
          a: rand(0.25, 0.95),
          tw: rand(0.6, 1.8),
        });
      }
      return s;
    }

    setHuman(charId) {
      const leftChar = charId === "rohan" ? "rohan" : "dev";
      const rightChar = charId === "rohan" ? "dev" : "rohan";

      // Human starts left for clarity (Street Fighter vibes).
      this.players.human = leftChar;
      this.players.ai = rightChar;

      this.f1 = makeFighter(leftChar, 520, 1);
      this.f2 = makeFighter(rightChar, 980, -1);

      this.state.phase = "intro";
      this.state.timer = 99;
      this.state.introT = 2.2;
      this.state.msg = "READY";

      this.projectiles = [];
      this.cameraX = clamp(((this.f1.x + this.f2.x) * 0.5) - VIEW_W * 0.5, 0, STAGE_W - VIEW_W);
      this.shake = 0;

      this._syncHudNames();
      this._setHudVisible(true);
      this._syncHud();
    }

    _setHudVisible(v) {
      if (v) this.hud.setAttribute("aria-hidden", "false");
      else this.hud.setAttribute("aria-hidden", "true");
      this.hud.style.display = v ? "grid" : "none";
    }

    _syncHudNames() {
      const ln = document.getElementById("hudLeftName");
      const rn = document.getElementById("hudRightName");
      ln.textContent = this.f1.ui;
      rn.textContent = this.f2.ui;
    }

    start() {
      if (this._running) return;
      this._running = true;
      this._last = now();
      requestAnimationFrame(() => this._frame());
    }

    stop() {
      this._running = false;
    }

    restartRound() {
      if (!this.f1 || !this.f2) return;
      const humanChar = this.players.human;
      this.setHuman(humanChar);
    }

    _frame() {
      if (!this._running) return;
      const t = now();
      let dt = (t - this._last) / 1000;
      this._last = t;

      // Clamp huge pauses.
      dt = Math.min(dt, 0.05);
      this._acc += dt;

      const step = 1 / 60;
      while (this._acc >= step) {
        this._update(step);
        this._acc -= step;
      }

      this._render();
      requestAnimationFrame(() => this._frame());
    }

    _update(dt) {
      // Global inputs
      if (this.input.consumePressed("m") || this.input.consumePressed("M")) {
        this.audio.setEnabled(!this.audio.enabled);
        syncMuteButton(this.audio.enabled);
      }
      if (this.input.consumePressed("r") || this.input.consumePressed("R")) this.restartRound();

      if (!this.f1 || !this.f2) return;

      // Phase transitions
      if (this.state.phase === "intro") {
        this.state.introT -= dt;
        if (this.state.introT < 1.1) this.state.msg = "FIGHT";
        if (this.state.introT <= 0) {
          this.state.phase = "fight";
          this.state.msg = "";
        }
      }

      if (this.state.phase === "fight") {
        this.state.timer -= dt;
        if (this.state.timer <= 0) {
          this.state.timer = 0;
          this._enterKO("TIME");
        }
      }

      // Camera
      const targetCam = clamp(((this.f1.x + this.f2.x) * 0.5) - VIEW_W * 0.5, 0, STAGE_W - VIEW_W);
      this.cameraX = lerp(this.cameraX, targetCam, 0.10);

      // Shake decay
      this.shake = Math.max(0, this.shake - dt * 8);
      const sh = this.shake * 7;
      this.shakeX = (Math.random() * 2 - 1) * sh;
      this.shakeY = (Math.random() * 2 - 1) * sh;

      // Face each other
      this.f1.facing = this.f2.x > this.f1.x ? 1 : -1;
      this.f2.facing = this.f1.x > this.f2.x ? 1 : -1;

      // Inputs
      const human = this.f1; // human on left by design
      const cpu = this.f2;
      const humanIn = this._readHumanInput(human, cpu);
      const cpuIn = aiInput(this.state, cpu, human);

      this._applyInput(human, humanIn, cpu, dt, true);
      this._applyInput(cpu, cpuIn, human, dt, false);

      // Physics + resolve overlap
      this._integrate(human, dt);
      this._integrate(cpu, dt);
      this._separateFighters(human, cpu);

      // Projectiles
      this._updateProjectiles(dt);

      // Attacks / hits
      this._resolveAttacks(human, cpu);
      this._resolveAttacks(cpu, human);

      // KO check
      if (this.state.phase !== "ko") {
        if (human.hp <= 0 || cpu.hp <= 0) {
          const winner = human.hp <= 0 ? cpu.name : human.name;
          this._enterKO(winner);
        }
      }

      this._syncHud();
    }

    _enterKO(winner) {
      this.state.phase = "ko";
      if (winner === "TIME") {
        if (this.f1.hp === this.f2.hp) this.state.msg = "DRAW";
        else this.state.msg = (this.f1.hp > this.f2.hp ? this.f1.name : this.f2.name) + " WINS";
      } else {
        this.state.msg = winner + " WINS";
      }
      this.audio.sfx("ko", 1);
      this.shake = 1.0;
      this.f1.hp = Math.max(0, this.f1.hp);
      this.f2.hp = Math.max(0, this.f2.hp);
    }

    _readHumanInput(me, them) {
      const left = this.input.isDown("a") || this.input.isDown("A") || this.input.isDown("ArrowLeft");
      const right = this.input.isDown("d") || this.input.isDown("D") || this.input.isDown("ArrowRight");
      const up =
        this.input.consumePressed("w") ||
        this.input.consumePressed("W") ||
        this.input.consumePressed("ArrowUp") ||
        this.input.consumePressed(" ");
      const down = this.input.isDown("s") || this.input.isDown("S") || this.input.isDown("ArrowDown");

      const punch = this.input.consumePressed("j") || this.input.consumePressed("J") || this.input.consumePressed("z") || this.input.consumePressed("Z");
      const kick = this.input.consumePressed("k") || this.input.consumePressed("K") || this.input.consumePressed("x") || this.input.consumePressed("X");
      const special = this.input.consumePressed("l") || this.input.consumePressed("L") || this.input.consumePressed("c") || this.input.consumePressed("C");

      let move = 0;
      if (left && !right) move = -1;
      if (right && !left) move = 1;

      // Translate "block" as down+away (Street Fighter-ish). We'll store extra metadata for block.
      const awayDir = them.x > me.x ? -1 : 1;
      const block = !!down && move === awayDir;

      return { move, jump: !!up, block, punch: !!punch, kick: !!kick, special: !!special };
    }

    _applyInput(me, input, them, dt, isHuman) {
      // Expose for block rules
      me._blockHeld = !!input.block;
      me._moveDir = input.move;

      // Cooldowns / timers
      me.specialCooldown = Math.max(0, me.specialCooldown - dt);
      me.invulnT = Math.max(0, me.invulnT - dt);
      me.hitstunT = Math.max(0, me.hitstunT - dt);
      if (me.hitstunT > 0) {
        me.state = "hit";
        me.attack = null;
        me.vx *= 0.88;
        return;
      }

      if (this.state.phase !== "fight" && this.state.phase !== "intro") {
        me.vx *= 0.82;
        return;
      }

      // Attacking state update
      if (me.attack) {
        me.stateT += dt;
        const a = me.attack;
        const m = MOVES[a.name];
        const total = m.startup + m.active + m.recovery;
        if (me.stateT >= total) {
          me.attack = null;
          me.attackHit = false;
          me.state = me.onGround ? "idle" : "jump";
          me.stateT = 0;
        } else {
          // Movement lock during attacks
          me.vx *= 0.86;
        }
        return;
      }

      // Block makes you "sticky" but safe.
      if (input.block) {
        me.state = me.onGround ? "block" : "jump";
        me.vx *= 0.78;
      } else if (me.onGround) {
        me.state = Math.abs(input.move) > 0 ? "walk" : "idle";
      }

      // Jump
      if (input.jump && me.onGround && !input.block) {
        me.vy = me.jump;
        me.onGround = false;
        me.state = "jump";
        this.audio.sfx("jump", 1);
      }

      // Horizontal movement
      const max = me.speed * (me.onGround ? 1.0 : 0.72);
      const accel = me.onGround ? 2200 : 1400;
      const target = input.move * max;
      me.vx = lerp(me.vx, target, clamp(accel * dt / (max || 1), 0, 1));
      if (Math.abs(me.vx) < 8 && input.move === 0) me.vx = 0;

      // Attacks
      if (this.state.phase === "fight") {
        if (input.punch) this._startAttack(me, "punch", isHuman);
        else if (input.kick) this._startAttack(me, "kick", isHuman);
        else if (input.special) this._startAttack(me, "special", isHuman);
      }
    }

    _startAttack(me, name, isHuman) {
      if (me.attack) return;
      if (name === "special") {
        if (me.energy < 45) return;
        if (me.specialCooldown > 0) return;
        me.energy -= 45;
        me.specialCooldown = 0.9;
        this.audio.sfx("special", 1);
      } else {
        this.audio.sfx(name, 1);
      }

      me.attack = { name };
      me.attackHit = false;
      me.stateT = 0;
      me.state = name;

      // In a "real" fighter you'd buffer inputs; this is intentionally arcade simple.
      if (!isHuman) {
        // CPU sometimes whiffs on purpose to feel more 90's.
        if (Math.random() < 0.05 && (name === "punch" || name === "kick")) me.stateT -= 0.03;
      }
    }

    _integrate(f, dt) {
      // Gravity
      if (!f.onGround) {
        f.vy -= GRAV * dt;
        f.y += f.vy * dt;
        if (f.y <= 0) {
          f.y = 0;
          f.vy = 0;
          f.onGround = true;
          if (!f.attack) f.state = f._blockHeld ? "block" : "idle";
        }
      }

      f.x += f.vx * dt;

      // Stage bounds
      const half = f.w * 0.5;
      f.x = clamp(f.x, half + 20, STAGE_W - half - 20);
    }

    _separateFighters(a, b) {
      const min = (a.w + b.w) * 0.5 + 8;
      const dx = b.x - a.x;
      const dist = Math.abs(dx);
      if (dist < min && dist > 0.0001) {
        const push = (min - dist) * 0.5;
        const dir = dx > 0 ? 1 : -1;
        a.x -= push * dir;
        b.x += push * dir;
        a.x = clamp(a.x, a.w * 0.5 + 20, STAGE_W - a.w * 0.5 - 20);
        b.x = clamp(b.x, b.w * 0.5 + 20, STAGE_W - b.w * 0.5 - 20);
      }
    }

    _resolveAttacks(attacker, defender) {
      if (!attacker.attack) return;
      const a = attacker.attack;
      const m = MOVES[a.name];
      if (!m) return;
      const t = attacker.stateT;
      const inActive = t >= m.startup && t < (m.startup + m.active);
      if (!inActive) return;
      if (attacker.attackHit) return;
      if (defender.invulnT > 0 || defender.hp <= 0) return;

      if (a.name === "special") {
        // Spawn once at active start
        attacker.attackHit = true; // counts as "used" for spawning
        this._spawnProjectile(attacker);
        return;
      }

      const hitbox = attackHitboxWorld(attacker, a.name);
      if (!hitbox) return;
      const hurt = fighterHurtboxWorld(defender);

      // Convert to same coordinate space. In world: x is x, y is negative-down.
      if (rectsOverlap(hitbox, hurt)) {
        attacker.attackHit = true;
        this._applyHit(attacker, defender, a.name);
      }
    }

    _applyHit(attacker, defender, moveName) {
      const c = CHAR[attacker.charId];
      const stats = c[moveName];
      const baseDmg = stats?.dmg ?? 8;
      const baseKb = stats?.kb ?? 220;

      const blocked = isBlocking(defender, attacker);
      const dmg = blocked ? Math.max(1, Math.floor(baseDmg * 0.35)) : baseDmg;
      const kb = blocked ? baseKb * 0.35 : baseKb;

      defender.hp = Math.max(0, defender.hp - dmg);
      attacker.energy = clamp(attacker.energy + (blocked ? 3 : 6), 0, 100);
      defender.energy = clamp(defender.energy + (blocked ? 4 : 8), 0, 100);

      const dir = attacker.x > defender.x ? -1 : 1;
      defender.vx = dir * kb;
      defender.vy = defender.onGround ? (blocked ? 110 : 170) : defender.vy;
      defender.onGround = false;
      defender.hitstunT = blocked ? 0.12 : 0.22;
      defender.invulnT = blocked ? 0.05 : 0.08;

      this.shake = Math.max(this.shake, blocked ? 0.25 : 0.55);

      this.audio.sfx(blocked ? "block" : "hit", blocked ? 0.8 : 1.0);
    }

    _spawnProjectile(owner) {
      const dir = owner.facing;
      const x = owner.x + dir * (owner.w * 0.7 + 16);
      const y = owner.y + owner.h * 0.55;
      const p = {
        owner,
        x,
        y,
        vx: dir * 520,
        life: 1.2,
        w: 28,
        h: 16,
        hit: false,
      };
      this.projectiles.push(p);
    }

    _updateProjectiles(dt) {
      if (!this.projectiles.length) return;
      for (const p of this.projectiles) {
        p.life -= dt;
        p.x += p.vx * dt;

        // A little bob for drama.
        p.y += Math.sin((1.2 - p.life) * 18) * 0.3;

        const target = p.owner === this.f1 ? this.f2 : this.f1;
        if (!p.hit && target.hp > 0 && target.invulnT <= 0) {
          const hb = fighterHurtboxWorld(target);
          const box = { x: p.x - p.w / 2, y: -(p.y) - p.h / 2, w: p.w, h: p.h };
          if (rectsOverlap(box, hb)) {
            p.hit = true;
            p.life = 0;
            this._applyProjectileHit(p.owner, target);
          }
        }
      }
      this.projectiles = this.projectiles.filter((p) => p.life > 0);
    }

    _applyProjectileHit(attacker, defender) {
      const c = CHAR[attacker.charId];
      const dmg = c.special?.dmg ?? 14;
      const kb = c.special?.kb ?? 220;

      const blocked = isBlocking(defender, attacker);
      const finalDmg = blocked ? Math.max(1, Math.floor(dmg * 0.45)) : dmg;
      const finalKb = blocked ? kb * 0.35 : kb;

      defender.hp = Math.max(0, defender.hp - finalDmg);
      attacker.energy = clamp(attacker.energy + (blocked ? 5 : 9), 0, 100);
      defender.energy = clamp(defender.energy + (blocked ? 5 : 10), 0, 100);

      const dir = attacker.x > defender.x ? -1 : 1;
      defender.vx = dir * finalKb;
      defender.vy = defender.onGround ? (blocked ? 130 : 210) : defender.vy;
      defender.onGround = false;
      defender.hitstunT = blocked ? 0.14 : 0.26;
      defender.invulnT = blocked ? 0.06 : 0.10;

      this.shake = Math.max(this.shake, blocked ? 0.30 : 0.70);
      this.audio.sfx(blocked ? "block" : "hit", blocked ? 0.9 : 1.0);
    }

    _syncHud() {
      const lhp = document.getElementById("hudLeftHp");
      const rhp = document.getElementById("hudRightHp");
      const le = document.getElementById("hudLeftEnergy");
      const re = document.getElementById("hudRightEnergy");
      const timer = document.getElementById("hudTimer");
      const msg = document.getElementById("hudMsg");

      lhp.style.width = clamp(this.f1.hp, 0, 100) + "%";
      rhp.style.width = clamp(this.f2.hp, 0, 100) + "%";
      le.style.width = clamp(this.f1.energy, 0, 100) + "%";
      re.style.width = clamp(this.f2.energy, 0, 100) + "%";

      timer.textContent = String(Math.ceil(this.state.timer)).padStart(2, "0");
      msg.textContent = this.state.msg || "";
    }

    _render() {
      this._resize();

      // Low-res pass
      const g = this.offCtx;
      g.save();
      g.clearRect(0, 0, VIEW_W, VIEW_H);

      const cam = this.cameraX + this.shakeX;
      const shY = this.shakeY;

      this._drawBackground(g, cam, shY);
      this._drawFloor(g, cam, shY);
      if (this.f1 && this.f2) {
        this._drawProjectiles(g, cam, shY);
        this._drawFighter(g, this.f1, cam, shY, this.f2);
        this._drawFighter(g, this.f2, cam, shY, this.f1);
      } else {
        // Pick screen: keep rendering (and avoid crashing) before fighters exist.
        g.fillStyle = "rgba(0,0,0,0.35)";
        g.fillRect(0, 0, VIEW_W, VIEW_H);
        g.fillStyle = "rgba(247,244,255,0.92)";
        g.font = "16px ui-monospace, Menlo, Monaco, monospace";
        g.textAlign = "center";
        g.textBaseline = "middle";
        g.fillText("PICK YOUR FIGHTER", VIEW_W / 2, VIEW_H / 2 - 10);
        g.fillStyle = "rgba(247,244,255,0.65)";
        g.font = "10px ui-monospace, Menlo, Monaco, monospace";
        g.fillText("(Rohan or Dev)  then press R to rematch later", VIEW_W / 2, VIEW_H / 2 + 14);
      }

      // Scanlines + noise (intentionally gross)
      this._drawVHS(g);

      g.restore();

      // Present to main canvas, pixelated
      const ctx = this.ctx;
      ctx.save();
      ctx.imageSmoothingEnabled = false;
      ctx.clearRect(0, 0, CANVAS_W, CANVAS_H);
      ctx.drawImage(this.off, 0, 0, CANVAS_W, CANVAS_H);
      ctx.restore();
    }

    _resize() {
      // Keep internal canvas fixed; CSS scales it. Still, match DPR for crispness.
      const dpr = Math.max(1, Math.floor(window.devicePixelRatio || 1));
      const wantW = CANVAS_W * dpr;
      const wantH = CANVAS_H * dpr;
      if (this.canvas.width !== wantW || this.canvas.height !== wantH) {
        this.canvas.width = wantW;
        this.canvas.height = wantH;
        this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      }
    }

    _drawBackground(g, camX, shY) {
      // Sky gradient
      const grad = g.createLinearGradient(0, 0, 0, VIEW_H);
      grad.addColorStop(0, "#1a0930");
      grad.addColorStop(0.55, "#090515");
      grad.addColorStop(1, "#06030d");
      g.fillStyle = grad;
      g.fillRect(0, 0, VIEW_W, VIEW_H);

      // Big synth sun
      const sunX = 90 + (camX * 0.04);
      const sunY = 52 + shY * 0.4;
      const r = 34;
      const sg = g.createRadialGradient(sunX, sunY, 4, sunX, sunY, 60);
      sg.addColorStop(0, "rgba(255,215,64,0.85)");
      sg.addColorStop(0.25, "rgba(255,61,141,0.45)");
      sg.addColorStop(1, "rgba(0,0,0,0)");
      g.fillStyle = sg;
      g.beginPath();
      g.arc(sunX, sunY, 60, 0, Math.PI * 2);
      g.fill();

      // Stars
      for (const s of this._stars) {
        const x = (s.x - camX * 0.2) % STAGE_W;
        const sx = x < 0 ? x + STAGE_W : x;
        const px = sx - camX * 0.0;
        if (px < -4 || px > VIEW_W + 4) continue;
        const tw = (Math.sin((performance.now() / 1000) * s.tw + s.x) * 0.5 + 0.5) * 0.6 + 0.4;
        g.fillStyle = `rgba(247,244,255,${s.a * tw})`;
        g.fillRect(px, s.y, 1, 1);
      }

      // Skyline silhouette
      g.fillStyle = "rgba(0,0,0,0.65)";
      for (const b of this._skyline) {
        const x = b.x - camX * 0.55;
        if (x + b.w < -30 || x > VIEW_W + 30) continue;
        const baseY = 172 + shY * 0.15;
        g.fillRect(x, baseY - b.h, b.w, b.h);

        // windows (random but stable-ish)
        g.fillStyle = `rgba(0,229,255,${0.08 + b.r * 0.08})`;
        const wx = x + 4;
        const wy = baseY - b.h + 6;
        for (let yy = wy; yy < baseY - 10; yy += 8) {
          for (let xx = wx; xx < x + b.w - 6; xx += 10) {
            if ((Math.floor(xx + yy + b.w) % 3) === 0) g.fillRect(xx, yy, 2, 2);
          }
        }
        g.fillStyle = "rgba(0,0,0,0.65)";
      }

      // Distant haze
      g.fillStyle = "rgba(0,229,255,0.05)";
      g.fillRect(0, 0, VIEW_W, VIEW_H);
    }

    _drawFloor(g, camX, shY) {
      // Ground
      const y = FLOOR_Y + shY;
      const grad = g.createLinearGradient(0, y - 12, 0, VIEW_H);
      grad.addColorStop(0, "rgba(0,0,0,0.10)");
      grad.addColorStop(1, "rgba(0,0,0,0.85)");
      g.fillStyle = grad;
      g.fillRect(0, y, VIEW_W, VIEW_H - y);

      // Grid
      g.strokeStyle = "rgba(0,229,255,0.09)";
      g.lineWidth = 1;
      g.beginPath();
      for (let i = 0; i <= 16; i++) {
        const px = (i / 16) * VIEW_W;
        g.moveTo(px, y);
        g.lineTo(px, VIEW_H);
      }
      for (let j = 0; j <= 7; j++) {
        const py = y + (j / 7) * (VIEW_H - y);
        g.moveTo(0, py);
        g.lineTo(VIEW_W, py);
      }
      g.stroke();

      // Floor glow streak
      const glow = g.createLinearGradient(0, y, VIEW_W, y);
      glow.addColorStop(0, "rgba(255,61,141,0.05)");
      glow.addColorStop(0.5, "rgba(0,229,255,0.09)");
      glow.addColorStop(1, "rgba(178,255,89,0.05)");
      g.fillStyle = glow;
      g.fillRect(0, y - 2, VIEW_W, 4);
    }

    _drawProjectiles(g, camX, shY) {
      if (!this.projectiles.length) return;
      for (const p of this.projectiles) {
        const x = p.x - camX;
        const y = FLOOR_Y - p.y + shY;
        const owner = p.owner;

        g.save();
        g.translate(x, y);
        g.rotate(Math.sin((1.2 - p.life) * 16) * 0.05);

        const grd = g.createLinearGradient(-p.w / 2, 0, p.w / 2, 0);
        grd.addColorStop(0, owner.c1);
        grd.addColorStop(0.5, "#ffffff");
        grd.addColorStop(1, owner.c2);
        g.fillStyle = grd;
        g.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);

        g.fillStyle = "rgba(255,255,255,0.18)";
        g.fillRect(-p.w / 2, -1, p.w, 2);
        g.restore();
      }
    }

    _drawFighter(g, f, camX, shY, other) {
      const x = f.x - camX;
      const y = FLOOR_Y - f.y + shY;

      // Shadow
      g.fillStyle = "rgba(0,0,0,0.45)";
      g.beginPath();
      g.ellipse(x, y + 4, 20, 6, 0, 0, Math.PI * 2);
      g.fill();

      // Body base
      const bodyW = f.w;
      const bodyH = f.h;
      const top = y - bodyH;

      // Tiny animation wobbles
      const walkBob = f.state === "walk" ? Math.sin(performance.now() / 110) * 2 : 0;
      const hitBob = f.state === "hit" ? Math.sin(performance.now() / 70) * 2 : 0;
      const bob = walkBob + hitBob;

      const facing = f.facing;

      // Colors
      const outline = "rgba(0,0,0,0.78)";
      const main = f.c1;
      const accent = f.c2;

      // Head
      g.fillStyle = outline;
      g.fillRect(x - 12, top + 10 + bob, 24, 18);
      const hg = g.createLinearGradient(x - 12, 0, x + 12, 0);
      hg.addColorStop(0, main);
      hg.addColorStop(1, accent);
      g.fillStyle = hg;
      g.fillRect(x - 11, top + 11 + bob, 22, 16);

      // Eyes
      const eyeX = x + facing * 3;
      g.fillStyle = "rgba(0,0,0,0.75)";
      g.fillRect(eyeX - 4, top + 16 + bob, 3, 2);
      g.fillStyle = "rgba(255,255,255,0.75)";
      g.fillRect(eyeX - 1, top + 16 + bob, 2, 2);

      // Torso
      g.fillStyle = outline;
      g.fillRect(x - 16, top + 28 + bob, 32, 34);
      g.fillStyle = "rgba(255,255,255,0.08)";
      g.fillRect(x - 15, top + 29 + bob, 30, 32);
      g.fillStyle = hg;
      g.fillRect(x - 15, top + 29 + bob, 30, 10);

      // Belt
      g.fillStyle = "rgba(0,0,0,0.55)";
      g.fillRect(x - 16, top + 50 + bob, 32, 4);

      // Arms (simple)
      const armY = top + 40 + bob;
      const armReach =
        f.state === "punch" ? 18 :
        f.state === "kick" ? 12 :
        f.state === "block" ? 6 :
        8;
      const armX = x + facing * (12 + armReach);
      g.fillStyle = outline;
      g.fillRect(x + facing * 14 - 4, armY, facing * (armReach + 8), 6);
      g.fillStyle = hg;
      g.fillRect(x + facing * 14 - 3, armY + 1, facing * (armReach + 6), 4);

      // Legs
      const legY = top + 62 + bob;
      const step = f.state === "walk" ? Math.sin(performance.now() / 95) * 6 : 0;
      g.fillStyle = outline;
      g.fillRect(x - 14, legY, 10, 26 + (step > 0 ? step : 0));
      g.fillRect(x + 4, legY, 10, 26 + (step < 0 ? -step : 0));
      g.fillStyle = "rgba(255,255,255,0.06)";
      g.fillRect(x - 13, legY + 1, 8, 24 + (step > 0 ? step : 0));
      g.fillRect(x + 5, legY + 1, 8, 24 + (step < 0 ? -step : 0));

      // Special aura for a moment after firing
      if (f.specialCooldown > 0.55) {
        const a = clamp((f.specialCooldown - 0.55) / 0.35, 0, 1);
        g.strokeStyle = `rgba(255,255,255,${0.12 * a})`;
        g.lineWidth = 2;
        g.beginPath();
        g.arc(x, top + 44 + bob, 30, 0, Math.PI * 2);
        g.stroke();
      }

      // Name tag near feet (tiny)
      g.fillStyle = "rgba(0,0,0,0.55)";
      g.fillRect(x - 18, y + 10, 36, 8);
      g.fillStyle = "rgba(247,244,255,0.75)";
      g.font = "6px ui-monospace, Menlo, Monaco, monospace";
      g.textAlign = "center";
      g.textBaseline = "middle";
      g.fillText(f.ui, x, y + 14);
    }

    _drawVHS(g) {
      // Scanlines
      g.fillStyle = "rgba(0,0,0,0.14)";
      for (let y = 0; y < VIEW_H; y += 2) g.fillRect(0, y, VIEW_W, 1);

      // Random noise blocks
      for (let i = 0; i < 10; i++) {
        const w = rand(14, 70);
        const h = rand(2, 10);
        const x = rand(-10, VIEW_W - 10);
        const y = rand(0, VIEW_H);
        g.fillStyle = `rgba(255,255,255,${rand(0.015, 0.05)})`;
        g.fillRect(x, y, w, h);
      }

      // Slight RGB shift bars (cheap chromatic aberration vibe)
      const barY = (performance.now() / 12) % VIEW_H;
      g.fillStyle = "rgba(255,61,141,0.06)";
      g.fillRect(0, barY, VIEW_W, 2);
      g.fillStyle = "rgba(0,229,255,0.05)";
      g.fillRect(0, (barY + 1) % VIEW_H, VIEW_W, 2);
    }
  }

  // Boot
  const canvas = document.getElementById("game");
  const hud = document.getElementById("hud");
  const overlay = document.getElementById("overlay");
  const muteBtn = document.getElementById("muteBtn");
  const pickRohan = document.getElementById("pickRohan");
  const pickDev = document.getElementById("pickDev");

  const audio = new RetroAudio();
  const game = new Game(canvas, hud, overlay, audio);
  game.start();

  function syncMuteButton(enabled) {
    muteBtn.textContent = enabled ? "Music: ON (M)" : "Music: OFF (M)";
    muteBtn.style.borderColor = enabled ? "rgba(247, 244, 255, 0.18)" : "rgba(255, 23, 68, 0.35)";
  }
  syncMuteButton(audio.enabled);

  async function startWith(charId) {
    // Hide overlay, show HUD, lock audio.
    overlay.classList.add("is-hidden");
    await audio.unlock();
    audio.startMusic();
    game.setHuman(charId);
  }

  pickRohan.addEventListener("click", () => startWith("rohan"));
  pickDev.addEventListener("click", () => startWith("dev"));

  // Click anywhere unlocks audio (Safari/iOS vibes)
  window.addEventListener("pointerdown", async () => {
    await audio.unlock();
  }, { passive: true });

  muteBtn.addEventListener("click", async () => {
    await audio.unlock();
    audio.setEnabled(!audio.enabled);
    syncMuteButton(audio.enabled);
    if (audio.enabled) audio.startMusic();
  });

})();
