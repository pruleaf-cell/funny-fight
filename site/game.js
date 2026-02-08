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
      this.sfxEnabled = true;
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
      sfxGain.gain.value = this.sfxEnabled ? 0.95 : 0.0;
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

    setSfxEnabled(v) {
      this.sfxEnabled = !!v;
      if (this.sfxGain) this.sfxGain.gain.value = this.sfxEnabled ? 0.95 : 0.0;
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
      if (!this.ctx || !this.sfxGain || !this.sfxEnabled) return;
      const t = this.ctx.currentTime + 0.001;
      switch (type) {
        case "punch":
          this._thwack(t, 0.10, 420 * intensity, 0.22);
          break;
        case "kick":
          this._thwack(t, 0.13, 260 * intensity, 0.28);
          break;
        case "dash":
          this._whoop(t, 0.06, 520, 220, 0.14);
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
        case "throw":
          this._thwack(t, 0.16, 180 * intensity, 0.34);
          this._hitNoise(t + 0.01, 0.09, 0.12);
          break;
        case "special":
          this._whoop(t, 0.18, 180, 980, 0.28);
          this._hitNoise(t + 0.02, 0.10, 0.10);
          break;
        case "super":
          this._whoop(t, 0.38, 140, 1320, 0.38);
          this._hitNoise(t + 0.03, 0.16, 0.16);
          break;
        case "round":
          this._whoop(t, 0.20, 520, 1040, 0.22);
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
      speed: 318,
      jump: 700,
      dash: 880,
      backdash: 780,
      punch: { dmg: 7, kb: 200 },
      kick: { dmg: 10, kb: 255 },
      sweep: { dmg: 12, kb: 220, kd: 0.62 },
      airPunch: { dmg: 6, kb: 165 },
      airKick: { dmg: 9, kb: 215 },
      throw: { dmg: 12, kb: 360, kd: 0.55 },
      special: { dmg: 14, kb: 210 },
      super: { dmg: 28, kb: 420 },
    },
    dev: {
      id: "dev",
      name: "DEV",
      ui: "DEV",
      c1: "#ff3d8d",
      c2: "#ffd740",
      speed: 300,
      jump: 670,
      dash: 820,
      backdash: 720,
      punch: { dmg: 8, kb: 210 },
      kick: { dmg: 12, kb: 275 },
      sweep: { dmg: 14, kb: 235, kd: 0.68 },
      airPunch: { dmg: 7, kb: 175 },
      airKick: { dmg: 10, kb: 225 },
      throw: { dmg: 13, kb: 380, kd: 0.60 },
      special: { dmg: 16, kb: 230 },
      super: { dmg: 32, kb: 440 },
    },
  };

  const MOVES = {
    punch: { kind: "melee", startup: 0.07, active: 0.09, recovery: 0.12, range: 56, h: 30, yOff: -6, hitstop: 0.045, hitstun: 0.20 },
    kick: { kind: "melee", startup: 0.10, active: 0.11, recovery: 0.16, range: 78, h: 38, yOff: -2, hitstop: 0.055, hitstun: 0.23 },
    sweep: { kind: "melee", startup: 0.14, active: 0.10, recovery: 0.24, range: 92, h: 24, yOff: 18, hitstop: 0.060, hitstun: 0.26, knockdown: 0.62 },
    airPunch: { kind: "melee", startup: 0.05, active: 0.11, recovery: 0.14, range: 54, h: 28, yOff: -18, hitstop: 0.040, hitstun: 0.20, air: true },
    airKick: { kind: "melee", startup: 0.07, active: 0.12, recovery: 0.16, range: 66, h: 34, yOff: -16, hitstop: 0.050, hitstun: 0.22, air: true },
    throw: { kind: "throw", startup: 0.06, active: 0.07, recovery: 0.32, range: 48, h: 54, yOff: -4, hitstop: 0.070, hitstun: 0.28, knockdown: 0.55 },
    special: { kind: "projectile", startup: 0.16, active: 0.02, recovery: 0.24, cost: 45, cooldown: 0.90, proj: { speed: 520, life: 1.15, w: 30, h: 16 }, hitstop: 0.030 },
    super: { kind: "projectile", startup: 0.20, active: 0.02, recovery: 0.42, cost: 100, cooldown: 2.20, proj: { speed: 650, life: 1.35, w: 62, h: 22 }, hitstop: 0.040 },
  };

  const BUF_TIME = 0.14;
  const DASH_TIME = 0.14;
  const DASH_CD = 0.38;
  const THROW_CD = 0.65;

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
      hpBack: 100,
      energy: 0,
      energyMax: 100,

      crouch: false,
      dashT: 0,
      dashDir: 0,
      dashCooldown: 0,
      throwCooldown: 0,
      knockdownT: 0,
      knockdownSlide: 0,

      comboHits: 0,
      comboT: 0,

      // Small input buffer for snappier feel (fighting games buffer inputs).
      buf: { jump: 0, punch: 0, kick: 0, special: 0, throw: 0 },
      lastTapL: -9999,
      lastTapR: -9999,

      state: "idle",
      stateT: 0,
      onGround: true,
      hitstunT: 0,
      invulnT: 0,

      attack: null,
      attackHit: false,
      specialCooldown: 0,

      ai: { thinkT: 0, lastIntent: null },
    };
  }

  function fighterHurtbox(f, camX) {
    const hh = fighterHeightNow(f);
    return {
      x: f.x - f.w / 2 - camX,
      y: FLOOR_Y - hh - f.y,
      w: f.w,
      h: hh,
    };
  }

  function fighterHeightNow(f) {
    if (f.knockdownT > 0) return 46;
    if (f.crouch && f.onGround) return 72;
    return f.h;
  }

  function fighterHurtboxWorld(f) {
    const hh = fighterHeightNow(f);
    return {
      x: f.x - f.w / 2,
      y: -f.y - hh, // relative to floor, y up => negative down
      w: f.w,
      h: hh,
    };
  }

  function attackHitboxWorld(f, moveName) {
    const m = MOVES[moveName];
    if (!m) return null;
    if (m.kind !== "melee" && m.kind !== "throw") return null;
    const forward = f.facing;
    const range = m.range;
    const hx = f.x + forward * (f.w * 0.35 + range * 0.5) - (range * 0.5);
    const fh = fighterHeightNow(f);
    const anchor = 0.72;
    const hy = -f.y - (fh * anchor) - (m.h * 0.5) + (m.yOff || 0);
    return { x: hx, y: hy, w: range, h: m.h };
  }

  function isBlocking(defender, attacker) {
    // Block when holding away + down (classic-ish), but keep it forgiving.
    if (!defender.onGround) return false;
    if (defender.knockdownT > 0) return false;
    if (defender.attack) return false;
    const awayDir = attacker.x > defender.x ? -1 : 1; // which direction is "away" from attacker
    return defender._blockHeld && defender._moveDir === awayDir;
  }

  function aiDiff(diff) {
    switch (diff) {
      case "easy":
        return 0.45;
      case "hard":
        return 0.82;
      case "boss":
        return 0.95;
      case "normal":
      default:
        return 0.65;
    }
  }

  function aiInput(state, me, them, dt, difficulty) {
    const d = aiDiff(difficulty);
    const out = {
      move: 0,
      down: false,
      block: false,
      crouch: false,
      dash: 0,
      jump: false,
      punch: false,
      kick: false,
      special: false,
      throw: false,
    };

    if (state.phase !== "fight") return out;
    if (me.hp <= 0 || them.hp <= 0) return out;

    // Short "brain tick" to feel more arcade and less perfect.
    me.ai.thinkT = Math.max(0, me.ai.thinkT - dt);
    if (me.ai.thinkT > 0) {
      if (me.ai.lastIntent) return { ...out, ...me.ai.lastIntent };
      return out;
    }
    me.ai.thinkT = lerp(0.28, 0.10, d) + rand(0, 0.05);

    const dx = them.x - me.x;
    const dist = Math.abs(dx);
    const toward = dx > 0 ? 1 : -1;
    const away = -toward;

    const inThrow = dist < 60;
    const inPunch = dist < 96;
    const inKick = dist < 128;
    const inSweep = dist < 138;
    const inSpecial = dist > 150 && dist < 480;

    const themAir = !them.onGround && them.y > 6;

    // Defense: react to active attacks.
    if (them.attack && dist < 160 && Math.random() < lerp(0.18, 0.62, d)) {
      out.block = true;
      out.move = away;
      me.ai.lastIntent = out;
      return out;
    }

    // Anti-air: if opponent jumps in, smack them.
    if (themAir && dist < 130 && me.onGround && Math.random() < lerp(0.05, 0.22, d)) {
      out.punch = true;
      out.move = toward;
      me.ai.lastIntent = out;
      return out;
    }

    // Neutral movement: keep a "sweet spot" distance.
    const sweet = lerp(165, 120, d);
    if (dist > sweet + 30) out.move = toward;
    if (dist < sweet - 45) out.move = away;

    // Dash decisions: close distance or disengage.
    if (me.onGround && me.dashCooldown <= 0) {
      if (dist > 260 && Math.random() < lerp(0.02, 0.07, d)) out.dash = toward;
      if (dist < 95 && Math.random() < lerp(0.01, 0.05, d)) out.dash = away;
    }

    // Special / Super (zoning)
    if (!me.attack && me.specialCooldown <= 0 && inSpecial) {
      const wantSuper = me.energy >= 100 && Math.random() < lerp(0.010, 0.040, d);
      const wantSpecial = me.energy >= 45 && Math.random() < lerp(0.012, 0.040, d);
      if (wantSuper || wantSpecial) {
        out.special = true;
        out.move = 0;
        me.ai.lastIntent = out;
        return out;
      }
    }

    // Throws: punish blocking / close quarters
    if (!me.attack && me.throwCooldown <= 0 && inThrow && me.onGround && them.onGround && Math.random() < lerp(0.015, 0.065, d)) {
      out.throw = true;
      out.move = toward;
      me.ai.lastIntent = out;
      return out;
    }

    // Sweeps: low-risk trip when close.
    if (!me.attack && inSweep && me.onGround && Math.random() < lerp(0.010, 0.050, d)) {
      out.kick = true;
      out.crouch = true;
      out.down = true;
      me.ai.lastIntent = out;
      return out;
    }

    // Melee: basic pressure.
    if (!me.attack) {
      if (inPunch && Math.random() < lerp(0.020, 0.085, d)) out.punch = true;
      else if (inKick && Math.random() < lerp(0.015, 0.070, d)) out.kick = true;
    }

    // Dumb jumps (keeps it arcade).
    if (me.onGround && dist < 260 && Math.random() < lerp(0.0015, 0.0060, d)) out.jump = true;

    me.ai.lastIntent = out;
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
      this.particles = [];

      this.hitstopT = 0;
      this.flashT = 0;

      this.state = {
        phase: "pick", // pick|intro|fight|ko
        msg: "",
        msgT: 0,
        timer: 99,
        introT: 0,
        koT: 0,
      };

      this.players = {
        human: null,
        ai: null,
      };

      this.match = {
        bestOf: 3,
        winsL: 0,
        winsR: 0,
        round: 1,
        over: false,
        difficulty: "normal",
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

    setHuman(charId, difficulty = "normal") {
      const leftChar = charId === "rohan" ? "rohan" : "dev";
      const rightChar = charId === "rohan" ? "dev" : "rohan";

      // Human starts left for clarity (Street Fighter vibes).
      this.players.human = leftChar;
      this.players.ai = rightChar;

      this.match.winsL = 0;
      this.match.winsR = 0;
      this.match.round = 1;
      this.match.over = false;
      this.match.difficulty = difficulty;

      this.f1 = makeFighter(leftChar, 520, 1);
      this.f2 = makeFighter(rightChar, 980, -1);

      this._startRoundIntro(true);

      this.projectiles = [];
      this.particles = [];
      this.cameraX = clamp(((this.f1.x + this.f2.x) * 0.5) - VIEW_W * 0.5, 0, STAGE_W - VIEW_W);
      this.shake = 0;
      this.hitstopT = 0;
      this.flashT = 0;

      this._syncHudNames();
      this._setHudVisible(true);
      this._syncHud();
    }

    _startRoundIntro(isNewMatch) {
      // Reset fighters for a new round, keep match wins.
      if (!this.f1 || !this.f2) return;
      this.f1.x = 520;
      this.f2.x = 980;
      this.f1.y = 0;
      this.f2.y = 0;
      this.f1.vx = this.f2.vx = 0;
      this.f1.vy = this.f2.vy = 0;
      this.f1.onGround = this.f2.onGround = true;
      this.f1.crouch = this.f2.crouch = false;
      this.f1.dashT = this.f2.dashT = 0;
      this.f1.dashCooldown = this.f2.dashCooldown = 0;
      this.f1.throwCooldown = this.f2.throwCooldown = 0;
      this.f1.knockdownT = this.f2.knockdownT = 0;
      this.f1.hitstunT = this.f2.hitstunT = 0;
      this.f1.invulnT = this.f2.invulnT = 0;
      this.f1.attack = this.f2.attack = null;
      this.f1.attackHit = this.f2.attackHit = false;
      this.f1.specialCooldown = this.f2.specialCooldown = 0;
      this.f1.energy = this.f2.energy = 0;
      this.f1.hp = this.f2.hp = 100;
      this.f1.hpBack = this.f2.hpBack = 100;
      this.f1.comboHits = this.f2.comboHits = 0;
      this.f1.comboT = this.f2.comboT = 0;
      this.f1.buf = { jump: 0, punch: 0, kick: 0, special: 0, throw: 0 };
      this.f2.buf = { jump: 0, punch: 0, kick: 0, special: 0, throw: 0 };
      this.f1.lastTapL = this.f1.lastTapR = -9999;
      this.f2.lastTapL = this.f2.lastTapR = -9999;

      this.state.phase = "intro";
      this.state.timer = 99;
      this.state.introT = 2.4;
      this.state.koT = 0;
      this.state.msgT = 1.2;
      this.state.msg = isNewMatch ? "ROUND 1" : "ROUND " + String(this.match.round);
      this.audio.sfx("round", 1);
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
      this.setHuman(humanChar, this.match.difficulty);
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

      // "Pressed" keys are one-frame events. Clear once per render frame (not per fixed update).
      this.input.clearPressed();

      this._render();
      requestAnimationFrame(() => this._frame());
    }

    _update(dt) {
      // Global inputs
      if (this.input.consumePressed("m") || this.input.consumePressed("M")) {
        this.audio.setEnabled(!this.audio.enabled);
        syncMuteButton(this.audio.enabled);
      }
      if (this.input.consumePressed("n") || this.input.consumePressed("N")) {
        this.audio.setSfxEnabled(!this.audio.sfxEnabled);
        syncSfxButton(this.audio.sfxEnabled);
      }
      if (this.input.consumePressed("r") || this.input.consumePressed("R")) this.restartRound();

      // Flash decays even during hitstop/ko.
      this.flashT = Math.max(0, this.flashT - dt);

      if (!this.f1 || !this.f2) return;

      const human = this.f1; // human on left by design
      const cpu = this.f2;

      // Inputs (buffered)
      const humanIn = this._readHumanInput(human, cpu);
      const cpuIn = aiInput(this.state, cpu, human, dt, this.match.difficulty);
      this._queueAi(cpu, cpuIn);

      // Hitstop freezes gameplay.
      if (this.hitstopT > 0) {
        this.hitstopT = Math.max(0, this.hitstopT - dt);
        this._syncHud();
        return;
      }

      // Phase transitions
      if (this.state.phase === "intro") {
        this.state.introT -= dt;
        const r = this.match.round;
        if (this.state.introT > 1.65) this.state.msg = "ROUND " + String(r);
        else if (this.state.introT > 0.95) this.state.msg = "READY";
        else this.state.msg = "FIGHT";
        if (this.state.introT <= 0) {
          this.state.phase = "fight";
          this.state.msg = "";
        }
      } else if (this.state.phase === "fight") {
        this.state.timer -= dt;
        if (this.state.timer <= 0) {
          this.state.timer = 0;
          this._enterKO("TIME");
        }
      } else if (this.state.phase === "ko") {
        this.state.koT -= dt;
        if (this.state.koT <= 0) {
          if (this.match.over) {
            this._returnToPick();
            return;
          }
          this.match.round += 1;
          this.projectiles = [];
          this.particles = [];
          this.hitstopT = 0;
          this.flashT = 0;
          this._startRoundIntro(false);
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

      this._applyInput(human, humanIn, cpu, dt, true);
      this._applyInput(cpu, cpuIn, human, dt, false);

      // Physics + resolve overlap
      this._integrate(human, dt);
      this._integrate(cpu, dt);
      this._separateFighters(human, cpu);

      // Projectiles
      this._updateProjectiles(dt);
      this._updateParticles(dt);

      // Attacks / hits
      this._resolveAttacks(human, cpu);
      this._resolveAttacks(cpu, human);

      // KO check
      if (this.state.phase === "fight") {
        if (human.hp <= 0 || cpu.hp <= 0) {
          const winner = human.hp <= 0 ? cpu.name : human.name;
          this._enterKO(winner);
        }
      }

      this._tickHpBack(human, dt);
      this._tickHpBack(cpu, dt);
      this._syncHud();
    }

    _enterKO(winner) {
      if (this.state.phase === "ko") return;
      this.state.phase = "ko";
      this.state.koT = 2.6;

      let winSide = null; // "L" | "R" | null (draw)
      let winName = "";

      if (winner === "TIME") {
        if (this.f1.hp === this.f2.hp) {
          winSide = null;
          winName = "";
          this.state.msg = "DRAW";
        } else if (this.f1.hp > this.f2.hp) {
          winSide = "L";
          winName = this.f1.name;
          this.state.msg = this.f1.name + " WINS";
        } else {
          winSide = "R";
          winName = this.f2.name;
          this.state.msg = this.f2.name + " WINS";
        }
      } else if (winner === this.f1.name) {
        winSide = "L";
        winName = this.f1.name;
        this.state.msg = this.f1.name + " WINS";
      } else if (winner === this.f2.name) {
        winSide = "R";
        winName = this.f2.name;
        this.state.msg = this.f2.name + " WINS";
      } else {
        // Fallback
        winSide = null;
        winName = "";
        this.state.msg = "KO";
      }

      if (winSide === "L") this.match.winsL += 1;
      if (winSide === "R") this.match.winsR += 1;

      const toWin = Math.floor(this.match.bestOf / 2) + 1;
      if (winSide && (this.match.winsL >= toWin || this.match.winsR >= toWin)) {
        this.match.over = true;
        this.state.koT = 4.0;
        this.state.msg = winName ? (winName + " WINS MATCH") : "MATCH OVER";
      }

      // Stop remaining action immediately.
      this.projectiles = [];
      this.f1.attack = null;
      this.f2.attack = null;
      this.f1.dashT = this.f2.dashT = 0;
      this.f1.buf = { jump: 0, punch: 0, kick: 0, special: 0, throw: 0 };
      this.f2.buf = { jump: 0, punch: 0, kick: 0, special: 0, throw: 0 };

      this.audio.sfx("ko", 1);
      this.shake = 1.0;
      this.flashT = Math.max(this.flashT, 0.10);
      this.f1.hp = Math.max(0, this.f1.hp);
      this.f2.hp = Math.max(0, this.f2.hp);
    }

    _readHumanInput(me, them) {
      const left = this.input.isDown("a") || this.input.isDown("A") || this.input.isDown("ArrowLeft");
      const right = this.input.isDown("d") || this.input.isDown("D") || this.input.isDown("ArrowRight");
      const down = this.input.isDown("s") || this.input.isDown("S") || this.input.isDown("ArrowDown");

      const upTap =
        this.input.consumePressed("w") ||
        this.input.consumePressed("W") ||
        this.input.consumePressed("ArrowUp") ||
        this.input.consumePressed(" ");
      const punchTap =
        this.input.consumePressed("j") ||
        this.input.consumePressed("J") ||
        this.input.consumePressed("z") ||
        this.input.consumePressed("Z");
      const kickTap =
        this.input.consumePressed("k") ||
        this.input.consumePressed("K") ||
        this.input.consumePressed("x") ||
        this.input.consumePressed("X");
      const specialTap =
        this.input.consumePressed("l") ||
        this.input.consumePressed("L") ||
        this.input.consumePressed("c") ||
        this.input.consumePressed("C");
      const throwTap =
        this.input.consumePressed("i") ||
        this.input.consumePressed("I") ||
        this.input.consumePressed("v") ||
        this.input.consumePressed("V");

      if (upTap) me.buf.jump = BUF_TIME;
      if (punchTap) me.buf.punch = BUF_TIME;
      if (kickTap) me.buf.kick = BUF_TIME;
      if (specialTap) me.buf.special = BUF_TIME;
      if (throwTap) me.buf.throw = BUF_TIME;

      let move = 0;
      if (left && !right) move = -1;
      if (right && !left) move = 1;

      // Double-tap dash.
      const leftTap = this.input.consumePressed("a") || this.input.consumePressed("A") || this.input.consumePressed("ArrowLeft");
      const rightTap = this.input.consumePressed("d") || this.input.consumePressed("D") || this.input.consumePressed("ArrowRight");
      const t = now();
      let dash = 0;
      if (leftTap) {
        if (t - me.lastTapL < 240) dash = -1;
        me.lastTapL = t;
      }
      if (rightTap) {
        if (t - me.lastTapR < 240) dash = 1;
        me.lastTapR = t;
      }

      // Translate "block" as down+away (Street Fighter-ish). Crouch is down without away.
      const awayDir = them.x > me.x ? -1 : 1;
      const block = !!down && move === awayDir;
      const crouch = !!down && !block;

      return { move, down: !!down, block, crouch, dash };
    }

    _queueAi(me, aiIn) {
      if (!aiIn) return;
      if (aiIn.jump) me.buf.jump = BUF_TIME;
      if (aiIn.punch) me.buf.punch = BUF_TIME;
      if (aiIn.kick) me.buf.kick = BUF_TIME;
      if (aiIn.special) me.buf.special = BUF_TIME;
      if (aiIn.throw) me.buf.throw = BUF_TIME;
    }

    _applyInput(me, input, them, dt, isHuman) {
      // Expose for block rules
      me._blockHeld = !!input.block;
      me._moveDir = input.move;

      // Cooldowns / timers
      me.specialCooldown = Math.max(0, me.specialCooldown - dt);
      me.dashCooldown = Math.max(0, me.dashCooldown - dt);
      me.throwCooldown = Math.max(0, me.throwCooldown - dt);
      me.invulnT = Math.max(0, me.invulnT - dt);
      me.hitstunT = Math.max(0, me.hitstunT - dt);
      me.knockdownT = Math.max(0, me.knockdownT - dt);
      me.comboT = Math.max(0, me.comboT - dt);
      if (me.comboT <= 0) me.comboHits = 0;

      // Input buffer decay
      me.buf.jump = Math.max(0, me.buf.jump - dt);
      me.buf.punch = Math.max(0, me.buf.punch - dt);
      me.buf.kick = Math.max(0, me.buf.kick - dt);
      me.buf.special = Math.max(0, me.buf.special - dt);
      me.buf.throw = Math.max(0, me.buf.throw - dt);

      // Knocked down: no actions.
      if (me.knockdownT > 0) {
        me.state = "down";
        me.attack = null;
        me.vx *= 0.82;
        return;
      }

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

      // Dash in progress
      if (me.dashT > 0) {
        me.dashT = Math.max(0, me.dashT - dt);
        const c = CHAR[me.charId];
        const dashSpeed = me.dashDir === (them.x > me.x ? 1 : -1) ? c.dash : c.backdash;
        me.vx = me.dashDir * dashSpeed;
        me.state = me.dashDir === (them.x > me.x ? 1 : -1) ? "dash" : "backdash";
        if (me.dashT <= 0) {
          me.vx *= 0.4;
          me.dashDir = 0;
        }
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

      // Start dash (double tap)
      if (input.dash && me.onGround && !input.block && me.dashCooldown <= 0) {
        me.dashDir = input.dash;
        me.dashT = DASH_TIME;
        me.dashCooldown = DASH_CD;
        // Backdash gets a tiny invuln window (makes throws less unfair).
        const away = them.x > me.x ? -1 : 1;
        if (me.dashDir === away) me.invulnT = Math.max(me.invulnT, 0.09);
        this.audio.sfx("dash", 1);
        this._spawnDashDust(me);
        // Dashes are committed movement; ignore crouch for this frame.
        me.crouch = false;
        return;
      }

      // Block makes you "sticky" but safe.
      if (input.block) {
        me.state = me.onGround ? "block" : "jump";
        me.vx *= 0.78;
        me.crouch = false;
      } else if (me.onGround) {
        me.crouch = !!input.crouch;
        me.state = me.crouch ? "crouch" : (Math.abs(input.move) > 0 ? "walk" : "idle");
      }

      // Jump
      if (me.buf.jump > 0 && me.onGround && !input.block) {
        me.buf.jump = 0;
        me.vy = me.jump;
        me.onGround = false;
        me.state = "jump";
        me.crouch = false;
        this.audio.sfx("jump", 1);
      }

      // Horizontal movement
      const slow = me.crouch ? 0.55 : 1.0;
      const max = me.speed * slow * (me.onGround ? 1.0 : 0.72);
      const accel = me.onGround ? 2200 : 1400;
      const target = input.move * max;
      me.vx = lerp(me.vx, target, clamp(accel * dt / (max || 1), 0, 1));
      if (Math.abs(me.vx) < 8 && input.move === 0) me.vx = 0;

      // Attacks
      if (this.state.phase === "fight") {
        if (me.buf.throw > 0 && me.throwCooldown <= 0 && me.onGround && !input.block) {
          if (this._startAttack(me, "throw", isHuman)) {
            me.buf.throw = 0;
            me.throwCooldown = THROW_CD;
          }
        } else if (me.buf.punch > 0 && !input.block) {
          const nm = me.onGround ? "punch" : "airPunch";
          if (this._startAttack(me, nm, isHuman)) me.buf.punch = 0;
        } else if (me.buf.kick > 0 && !input.block) {
          const nm = me.onGround ? (me.crouch ? "sweep" : "kick") : "airKick";
          if (this._startAttack(me, nm, isHuman)) me.buf.kick = 0;
        } else if (me.buf.special > 0 && !input.block) {
          const nm = me.energy >= 100 ? "super" : "special";
          if (this._startAttack(me, nm, isHuman)) me.buf.special = 0;
        }
      }
    }

    _startAttack(me, name, isHuman) {
      if (me.attack) return false;
      const mv = MOVES[name];
      if (!mv) return false;

      if (mv.kind === "projectile") {
        const cost = mv.cost ?? 0;
        if (me.energy < cost) return false;
        if (me.specialCooldown > 0) return false;
        me.energy -= cost;
        me.specialCooldown = mv.cooldown ?? 0;
        this.audio.sfx(name === "super" ? "super" : "special", 1);
        if (name === "super") {
          this.flashT = Math.max(this.flashT, 0.12);
          this.shake = Math.max(this.shake, 0.35);
        }
      } else if (mv.kind === "throw") {
        this.audio.sfx("throw", 1);
      } else if (name === "kick" || name === "sweep" || name === "airKick") {
        this.audio.sfx("kick", 1);
      } else {
        this.audio.sfx("punch", 1);
      }

      me.attack = { name };
      me.attackHit = false;
      me.stateT = 0;
      me.state = name;

      // In a "real" fighter you'd buffer inputs; this is intentionally arcade simple.
      if (!isHuman) {
        // CPU sometimes whiffs on purpose to feel more 90's.
        if (Math.random() < 0.03 && (name === "punch" || name === "kick" || name === "sweep")) me.stateT -= 0.03;
      }
      return true;
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
          if (!f.attack) {
            if (f.knockdownT > 0) f.state = "down";
            else f.state = f._blockHeld ? "block" : "idle";
          }
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

      if (m.kind === "projectile") {
        // Spawn once at active start
        attacker.attackHit = true;
        this._spawnProjectile(attacker, a.name);
        return;
      }

      if (m.kind === "throw") {
        // Throws only work on grounded, non-stunned opponents (no-block).
        if (!attacker.onGround || !defender.onGround) return;
        if (defender.hitstunT > 0 || defender.knockdownT > 0) return;
        if (Math.abs(defender.x - attacker.x) > 70) return;
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
      const mv = MOVES[moveName];
      const stats =
        c[moveName] ||
        (moveName === "sweep" ? c.sweep :
          moveName === "airPunch" ? c.airPunch :
          moveName === "airKick" ? c.airKick :
          moveName === "throw" ? c.throw :
          c.punch);
      const baseDmg = stats?.dmg ?? 8;
      const baseKb = stats?.kb ?? 220;

      const isThrow = mv?.kind === "throw";
      const blocked = isThrow ? false : isBlocking(defender, attacker);
      const dmg = blocked ? Math.max(1, Math.floor(baseDmg * 0.35)) : baseDmg;
      const kb = blocked ? baseKb * 0.35 : baseKb;

      defender.hp = Math.max(0, defender.hp - dmg);
      attacker.energy = clamp(attacker.energy + (blocked ? 4 : 8), 0, 100);
      defender.energy = clamp(defender.energy + (blocked ? 6 : 12), 0, 100);

      const dir = attacker.x > defender.x ? -1 : 1;
      defender.vx = dir * kb;
      if (isThrow) {
        defender.vy = 260;
        defender.onGround = false;
      } else {
        defender.vy = defender.onGround ? (blocked ? 110 : 175) : defender.vy;
        defender.onGround = false;
      }

      const baseHitstun = mv?.hitstun ?? 0.22;
      defender.hitstunT = blocked ? baseHitstun * 0.55 : baseHitstun;
      defender.invulnT = blocked ? 0.05 : 0.09;

      const kd = stats?.kd ?? mv?.knockdown ?? 0;
      if (!blocked && kd > 0) defender.knockdownT = Math.max(defender.knockdownT, kd);

      this.shake = Math.max(this.shake, blocked ? 0.22 : (isThrow ? 0.85 : 0.55));
      this.flashT = Math.max(this.flashT, blocked ? 0.03 : (isThrow ? 0.10 : 0.07));
      this.hitstopT = Math.max(this.hitstopT, blocked ? (mv?.hitstop ?? 0.05) * 0.6 : (mv?.hitstop ?? 0.05));
      attacker.comboHits = attacker.comboHits + 1;
      attacker.comboT = 1.2;
      this._spawnHitBurst(attacker, defender, blocked, moveName);

      this.audio.sfx(blocked ? "block" : "hit", blocked ? 0.8 : 1.0);
    }

    _spawnProjectile(owner, kind) {
      const mv = MOVES[kind];
      if (!mv || mv.kind !== "projectile") return;
      const pr = mv.proj;
      const dir = owner.facing;
      const x = owner.x + dir * (owner.w * 0.7 + 16);
      const y = owner.y + fighterHeightNow(owner) * 0.56;
      const p = {
        owner,
        kind,
        x,
        y,
        vx: dir * pr.speed,
        life: pr.life,
        w: pr.w,
        h: pr.h,
        hit: false,
      };
      this.projectiles.push(p);
      this._spawnProjectileTrail(p, true);
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
            this._applyProjectileHit(p.owner, target, p.kind);
          }
        }

        if (Math.random() < 0.22) this._spawnProjectileTrail(p, false);
      }
      this.projectiles = this.projectiles.filter((p) => p.life > 0);
    }

    _applyProjectileHit(attacker, defender, kind) {
      const c = CHAR[attacker.charId];
      const stats = c[kind] || c.special;
      const dmg = stats?.dmg ?? 14;
      const kb = stats?.kb ?? 220;

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

      if (!blocked && kind === "super") {
        defender.knockdownT = Math.max(defender.knockdownT, 0.60);
      }

      this.shake = Math.max(this.shake, blocked ? 0.30 : (kind === "super" ? 1.0 : 0.70));
      this.flashT = Math.max(this.flashT, blocked ? 0.04 : (kind === "super" ? 0.14 : 0.08));
      this.hitstopT = Math.max(this.hitstopT, blocked ? 0.03 : (kind === "super" ? 0.08 : 0.05));
      attacker.comboHits = attacker.comboHits + 1;
      attacker.comboT = 1.2;
      this._spawnHitBurst(attacker, defender, blocked, kind);
      this.audio.sfx(blocked ? "block" : "hit", blocked ? 0.9 : 1.0);
    }

    _tickHpBack(f, dt) {
      if (f.hpBack > f.hp) f.hpBack = Math.max(f.hp, f.hpBack - dt * 55);
      else f.hpBack = f.hp;
    }

    _pushParticle(p) {
      // Cap to keep perf stable.
      if (this.particles.length > 260) this.particles.splice(0, this.particles.length - 260);
      if (p.life0 == null) p.life0 = p.life;
      this.particles.push(p);
    }

    _spawnDashDust(f) {
      const dir = f.dashDir || (f.vx >= 0 ? -1 : 1);
      for (let i = 0; i < 10; i++) {
        this._pushParticle({
          kind: "dust",
          x: f.x + rand(-10, 10) - dir * 10,
          y: rand(2, 10),
          vx: rand(-90, 90) - dir * 140,
          vy: rand(40, 160),
          life: rand(0.18, 0.32),
          ttl: 0,
          size: rand(1, 3),
          a: rand(0.22, 0.45),
          col: "rgba(247,244,255,0.55)",
          grav: 1100,
        });
      }
    }

    _spawnHitBurst(attacker, defender, blocked, moveName) {
      const cx = defender.x + (attacker.x > defender.x ? 10 : -10);
      const cy = defender.y + fighterHeightNow(defender) * 0.56;
      const n = blocked ? 10 : 18;
      const c1 = blocked ? "rgba(247,244,255,0.55)" : attacker.c1;
      const c2 = blocked ? "rgba(247,244,255,0.55)" : attacker.c2;

      // Core flash shard
      this._pushParticle({
        kind: "ring",
        x: cx,
        y: cy,
        vx: 0,
        vy: 0,
        life: blocked ? 0.10 : 0.14,
        ttl: 0,
        size: blocked ? 12 : 18,
        a: blocked ? 0.22 : 0.32,
        col: blocked ? "rgba(255,255,255,0.55)" : "rgba(255,255,255,0.85)",
        grav: 0,
      });

      for (let i = 0; i < n; i++) {
        const ang = rand(-Math.PI * 0.9, Math.PI * 0.9);
        const sp = rand(blocked ? 120 : 220, blocked ? 260 : 460);
        const col = Math.random() < 0.5 ? c1 : c2;
        this._pushParticle({
          kind: "spark",
          x: cx + rand(-3, 3),
          y: cy + rand(-6, 6),
          vx: Math.cos(ang) * sp,
          vy: Math.sin(ang) * sp + rand(120, 260),
          life: rand(0.14, blocked ? 0.22 : 0.32),
          ttl: 0,
          size: rand(1, blocked ? 2 : 3),
          a: rand(0.28, blocked ? 0.40 : 0.55),
          col,
          grav: 1300,
        });
      }
    }

    _spawnProjectileTrail(p, big) {
      const owner = p.owner;
      const tailN = big ? 16 : 3;
      for (let i = 0; i < tailN; i++) {
        const t = big ? i / tailN : 0.0;
        const jitter = big ? 8 : 4;
        const col = p.kind === "super" ? "rgba(255,255,255,0.55)" : owner.c1;
        this._pushParticle({
          kind: "trail",
          x: p.x - Math.sign(p.vx) * (p.w * 0.35 + t * 22) + rand(-jitter, jitter),
          y: p.y + rand(-jitter, jitter),
          vx: rand(-60, 60) - p.vx * 0.05,
          vy: rand(-40, 60),
          life: rand(big ? 0.10 : 0.06, big ? 0.20 : 0.12),
          ttl: 0,
          size: rand(big ? 2 : 1, big ? 4 : 2),
          a: rand(big ? 0.12 : 0.08, big ? 0.22 : 0.16),
          col,
          grav: 0,
        });
      }
    }

    _updateParticles(dt) {
      if (!this.particles.length) return;
      for (const p of this.particles) {
        p.life -= dt;
        p.ttl += dt;
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        if (p.grav) p.vy -= p.grav * dt;
        p.vx *= 0.988;
      }
      this.particles = this.particles.filter((p) => p.life > 0 && p.y > -40);
    }

    _returnToPick() {
      this.state.phase = "pick";
      this.state.msg = "";
      this.state.msgT = 0;
      this.state.timer = 99;
      this.state.introT = 0;
      this.state.koT = 0;

      this.projectiles = [];
      this.particles = [];
      this.hitstopT = 0;
      this.flashT = 0;
      this.shake = 0;

      this.f1 = null;
      this.f2 = null;

      this._setHudVisible(false);
      this.overlay.classList.remove("is-hidden");
    }

    _syncHud() {
      const lhp = document.getElementById("hudLeftHp");
      const lhpBack = document.getElementById("hudLeftHpBack");
      const rhp = document.getElementById("hudRightHp");
      const rhpBack = document.getElementById("hudRightHpBack");
      const le = document.getElementById("hudLeftEnergy");
      const re = document.getElementById("hudRightEnergy");
      const timer = document.getElementById("hudTimer");
      const msg = document.getElementById("hudMsg");
      const lr = document.getElementById("hudLeftRounds");
      const rr = document.getElementById("hudRightRounds");
      const lc = document.getElementById("hudLeftCombo");
      const rc = document.getElementById("hudRightCombo");

      lhp.style.width = clamp(this.f1.hp, 0, 100) + "%";
      lhpBack.style.width = clamp(this.f1.hpBack, 0, 100) + "%";
      rhp.style.width = clamp(this.f2.hp, 0, 100) + "%";
      rhpBack.style.width = clamp(this.f2.hpBack, 0, 100) + "%";
      le.style.width = clamp(this.f1.energy, 0, 100) + "%";
      re.style.width = clamp(this.f2.energy, 0, 100) + "%";

      timer.textContent = String(Math.ceil(this.state.timer)).padStart(2, "0");
      msg.textContent = this.state.msg || "";

      const toWin = Math.floor(this.match.bestOf / 2) + 1;
      const pipHtml = (wins) =>
        Array.from({ length: toWin }, (_, i) => `<span class="hud__pip ${wins > i ? "is-on" : ""}"></span>`).join("");
      lr.innerHTML = pipHtml(this.match.winsL);
      rr.innerHTML = pipHtml(this.match.winsR);

      const setCombo = (el, f, side) => {
        const showCombo = f.comboHits >= 2 && f.comboT > 0;
        const showSuper = f.energy >= 100 && this.state.phase === "fight" && !showCombo;
        if (showCombo) {
          el.textContent = `COMBO x${f.comboHits}`;
          el.classList.add("is-on");
        } else if (showSuper) {
          el.textContent = "SUPER READY";
          el.classList.add("is-on");
        } else {
          el.textContent = "";
          el.classList.remove("is-on");
        }
      };
      setCombo(lc, this.f1, "L");
      setCombo(rc, this.f2, "R");
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
        this._drawParticles(g, cam, shY);
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
      this._drawFlash(g);

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

        const isSuper = p.kind === "super";
        const grd = g.createLinearGradient(-p.w / 2, 0, p.w / 2, 0);
        grd.addColorStop(0, owner.c1);
        grd.addColorStop(0.45, "#ffffff");
        grd.addColorStop(1, owner.c2);
        g.fillStyle = grd;
        g.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);

        // Extra glow for super.
        if (isSuper) {
          g.globalAlpha = 0.35;
          g.fillStyle = "#ffffff";
          g.fillRect(-p.w / 2 - 6, -p.h / 2 - 4, p.w + 12, p.h + 8);
          g.globalAlpha = 1;
        }

        g.fillStyle = isSuper ? "rgba(255,255,255,0.30)" : "rgba(255,255,255,0.18)";
        g.fillRect(-p.w / 2, -1, p.w, 2);
        g.restore();
      }
    }

    _drawParticles(g, camX, shY) {
      if (!this.particles.length) return;
      g.save();
      for (const p of this.particles) {
        const x = p.x - camX;
        const y = FLOOR_Y - p.y + shY;
        if (x < -60 || x > VIEW_W + 60 || y < -60 || y > VIEW_H + 60) continue;
        const fade = p.life0 > 0 ? clamp(p.life / p.life0, 0, 1) : 0;
        const a = clamp((p.a ?? 0.3) * fade, 0, 1);
        if (a <= 0.001) continue;

        if (p.kind === "ring") {
          g.globalAlpha = a;
          g.strokeStyle = p.col;
          g.lineWidth = 2;
          const r = (p.size ?? 10) * (1 + (p.ttl ?? 0) * 3.5);
          g.beginPath();
          g.arc(x, y, r, 0, Math.PI * 2);
          g.stroke();
        } else {
          g.globalAlpha = a;
          g.fillStyle = p.col;
          const s = p.size ?? 2;
          g.fillRect(x - s * 0.5, y - s * 0.5, s, s);
        }
      }
      g.restore();
    }

    _drawFighter(g, f, camX, shY, other) {
      const x = f.x - camX;
      const y = FLOOR_Y - f.y + shY;

      // Shadow
      g.fillStyle = "rgba(0,0,0,0.45)";
      g.beginPath();
      g.ellipse(x, y + 4, 20, 6, 0, 0, Math.PI * 2);
      g.fill();

      const hh = fighterHeightNow(f);
      const top = y - hh;
      const s = hh / f.h;
      const px = (v) => Math.round(v);

      // Tiny animation wobbles
      const walkBob = f.state === "walk" ? Math.sin(performance.now() / 110) * 2 : 0;
      const hitBob = f.state === "hit" ? Math.sin(performance.now() / 70) * 2 : 0;
      const bob = walkBob + hitBob;

      const facing = f.facing;

      // Colors
      const outline = "rgba(0,0,0,0.78)";
      const main = f.c1;
      const accent = f.c2;

      // Knockdown pose (lying down)
      if (f.state === "down") {
        const bodyY = y - 22;
        const bodyW = 74;
        const bodyH = 24;
        const gx = g.createLinearGradient(x - bodyW / 2, 0, x + bodyW / 2, 0);
        gx.addColorStop(0, main);
        gx.addColorStop(1, accent);

        g.save();
        g.translate(x, bodyY);
        g.rotate(facing * 0.06);
        g.fillStyle = outline;
        g.fillRect(-bodyW / 2, -bodyH / 2, bodyW, bodyH);
        g.fillStyle = gx;
        g.fillRect(-bodyW / 2 + 1, -bodyH / 2 + 1, bodyW - 2, bodyH - 2);
        g.fillStyle = "rgba(255,255,255,0.10)";
        g.fillRect(-bodyW / 2 + 2, -bodyH / 2 + 2, bodyW - 4, 6);
        // Head blob
        g.fillStyle = outline;
        g.fillRect(bodyW / 2 - 18, -10, 16, 16);
        g.fillStyle = "rgba(255,255,255,0.14)";
        g.fillRect(bodyW / 2 - 17, -9, 14, 14);
        g.restore();

        // Name tag
        g.fillStyle = "rgba(0,0,0,0.55)";
        g.fillRect(x - 18, y + 10, 36, 8);
        g.fillStyle = "rgba(247,244,255,0.75)";
        g.font = "6px ui-monospace, Menlo, Monaco, monospace";
        g.textAlign = "center";
        g.textBaseline = "middle";
        g.fillText(f.ui, x, y + 14);
        return;
      }

      // Aura when super is ready
      if (f.energy >= 100) {
        const a = 0.10 + Math.sin(performance.now() / 140) * 0.04;
        g.fillStyle = `rgba(255,255,255,${a})`;
        g.fillRect(x - 26, top + 4 + bob, 52, hh + 8);
      }

      // Head
      g.fillStyle = outline;
      g.fillRect(px(x - 12), px(top + 10 * s + bob), px(24), px(18 * s));
      const hg = g.createLinearGradient(x - 12, 0, x + 12, 0);
      hg.addColorStop(0, main);
      hg.addColorStop(1, accent);
      g.fillStyle = hg;
      g.fillRect(px(x - 11), px(top + 11 * s + bob), px(22), px(16 * s));

      // Eyes
      const eyeX = x + facing * 3;
      g.fillStyle = "rgba(0,0,0,0.75)";
      g.fillRect(px(eyeX - 4), px(top + 16 * s + bob), 3, 2);
      g.fillStyle = "rgba(255,255,255,0.75)";
      g.fillRect(px(eyeX - 1), px(top + 16 * s + bob), 2, 2);

      // Torso
      g.fillStyle = outline;
      g.fillRect(px(x - 16), px(top + 28 * s + bob), px(32), px(34 * s));
      g.fillStyle = "rgba(255,255,255,0.08)";
      g.fillRect(px(x - 15), px(top + 29 * s + bob), px(30), px(32 * s));
      g.fillStyle = hg;
      g.fillRect(px(x - 15), px(top + 29 * s + bob), px(30), px(10 * s));

      // Belt
      g.fillStyle = "rgba(0,0,0,0.55)";
      g.fillRect(px(x - 16), px(top + 50 * s + bob), px(32), 4);

      // Arms (simple)
      const armY = top + 40 * s + bob;
      const armReach =
        (f.state === "punch" || f.state === "airPunch") ? 20 :
        (f.state === "kick" || f.state === "airKick") ? 14 :
        f.state === "throw" ? 14 :
        f.state === "block" ? 6 :
        8;
      g.fillStyle = outline;
      g.fillRect(px(x + facing * 14 - 4), px(armY), px(facing * (armReach + 8)), 6);
      g.fillStyle = hg;
      g.fillRect(px(x + facing * 14 - 3), px(armY + 1), px(facing * (armReach + 6)), 4);

      // Legs
      const legY = top + 62 * s + bob;
      const step = f.state === "walk" ? Math.sin(performance.now() / 95) * 6 : 0;
      g.fillStyle = outline;
      const legH1 = 26 * s + (step > 0 ? step : 0);
      const legH2 = 26 * s + (step < 0 ? -step : 0);
      g.fillRect(px(x - 14), px(legY), 10, px(legH1));
      g.fillRect(px(x + 4), px(legY), 10, px(legH2));
      g.fillStyle = "rgba(255,255,255,0.06)";
      g.fillRect(px(x - 13), px(legY + 1), 8, px(24 * s + (step > 0 ? step : 0)));
      g.fillRect(px(x + 5), px(legY + 1), 8, px(24 * s + (step < 0 ? -step : 0)));

      // Sweep leg extension
      if (f.state === "sweep") {
        g.fillStyle = outline;
        g.fillRect(px(x + facing * 8), px(legY + 12 * s), px(facing * 30), 6);
        g.fillStyle = hg;
        g.fillRect(px(x + facing * 8), px(legY + 13 * s), px(facing * 28), 4);
      }

      // Block shimmer
      if (f.state === "block") {
        const a = 0.12 + Math.sin(performance.now() / 80) * 0.04;
        g.fillStyle = `rgba(255,255,255,${a})`;
        g.fillRect(px(x - 18), px(top + 22 * s + bob), 36, px(34 * s));
      }

      // Special aura for a moment after firing
      if (f.specialCooldown > 0.55) {
        const a = clamp((f.specialCooldown - 0.55) / 0.35, 0, 1);
        g.strokeStyle = `rgba(255,255,255,${0.12 * a})`;
        g.lineWidth = 2;
        g.beginPath();
        g.arc(x, top + 44 * s + bob, 30, 0, Math.PI * 2);
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

    _drawFlash(g) {
      if (this.flashT <= 0) return;
      const a = clamp(this.flashT / 0.14, 0, 1);
      g.fillStyle = `rgba(255,255,255,${0.14 * a})`;
      g.fillRect(0, 0, VIEW_W, VIEW_H);
      g.fillStyle = `rgba(0,229,255,${0.03 * a})`;
      g.fillRect(0, 0, VIEW_W, VIEW_H);
    }
  }

  // Boot
  const canvas = document.getElementById("game");
  const hud = document.getElementById("hud");
  const overlay = document.getElementById("overlay");
  const muteBtn = document.getElementById("muteBtn");
  const sfxBtn = document.getElementById("sfxBtn");
  const pickRohan = document.getElementById("pickRohan");
  const pickDev = document.getElementById("pickDev");
  const difficulty = document.getElementById("difficulty");

  const audio = new RetroAudio();
  const game = new Game(canvas, hud, overlay, audio);
  game.start();

  function syncMuteButton(enabled) {
    muteBtn.textContent = enabled ? "Music: ON (M)" : "Music: OFF (M)";
    muteBtn.style.borderColor = enabled ? "rgba(247, 244, 255, 0.18)" : "rgba(255, 23, 68, 0.35)";
  }
  function syncSfxButton(enabled) {
    sfxBtn.textContent = enabled ? "SFX: ON (N)" : "SFX: OFF (N)";
    sfxBtn.style.borderColor = enabled ? "rgba(247, 244, 255, 0.18)" : "rgba(255, 23, 68, 0.35)";
  }
  syncMuteButton(audio.enabled);
  syncSfxButton(audio.sfxEnabled);

  async function startWith(charId) {
    // Hide overlay, show HUD, lock audio.
    overlay.classList.add("is-hidden");
    await audio.unlock();
    audio.startMusic();
    const diff = (difficulty && difficulty.value) ? difficulty.value : "normal";
    game.setHuman(charId, diff);
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

  sfxBtn.addEventListener("click", async () => {
    await audio.unlock();
    audio.setSfxEnabled(!audio.sfxEnabled);
    syncSfxButton(audio.sfxEnabled);
  });

})();
