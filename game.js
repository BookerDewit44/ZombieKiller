// ============================================================
// ZOMBIE KILLER — Canvas Side-Scroller
// ============================================================

const canvas = document.getElementById('gameCanvas');
// `desynchronized: true` lets the browser composite the canvas directly to the
// screen without an extra back-buffer copy — meaningful win on mobile GPUs.
const ctx = canvas.getContext('2d', { alpha: false, desynchronized: true });
canvas.width = 900;
canvas.height = 500;

// Detect mobile / low-end device. Use userAgent only — `maxTouchPoints > 1` falsely
// flags Windows laptops/desktops that have touchscreens (or Chrome's experimental
// touch flags) and was blocking click-to-shoot for desktop users.
const lowQuality = /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
if (lowQuality) document.body.classList.add('is-mobile');
// Mobile: suppress only the shadow/glow effects — they're the single heaviest GPU
// cost on phones (applied per particle, bullet, zombie, etc., across 60+ call sites).
// Atmosphere, vignette, gradients, platform decorations etc. all stay on for the full look.
if (lowQuality) {
  Object.defineProperty(ctx, 'shadowBlur',  { set() {}, get() { return 0; }, configurable: true });
  Object.defineProperty(ctx, 'shadowColor', { set() {}, get() { return 'transparent'; }, configurable: true });
}

// Per-platform machine-gun audio: a punchier sample for desktop, mobile-optimized variant for phones.
const MG_FIRE_AUDIO = lowQuality
  ? 'audio/mobile/machine-gunfire-45754.mp3'
  : 'audio/machine-gunfire-1.mp3';

// Block the long-press "copy image" / "save image" callout on mobile.
// Apply at document level (capture phase) so it stops the gesture before any
// child element can show a system popup.
document.addEventListener('contextmenu', e => e.preventDefault(), { capture: true });
document.addEventListener('selectstart', e => e.preventDefault(), { capture: true });
document.addEventListener('dragstart',   e => e.preventDefault(), { capture: true });
canvas.addEventListener('contextmenu', e => e.preventDefault());
document.getElementById('game-container').addEventListener('contextmenu', e => e.preventDefault());

// ── Audio ─────────────────────────────────────────────────────
const introClip = new Audio('audio/come-here-scum-323781(Radio).mp3');
introClip.volume = 0.75;
introClip.addEventListener('ended', () => { startMusic(); });

// Start playlist on first user interaction (browsers require a gesture for autoplay).
document.addEventListener('click', function playIntro() {
  startMusic();
  document.removeEventListener('click', playIntro);
}, { once: true });

const musicMain  = new Audio('audio/edm-loop-319038.mp3'); musicMain.volume  = 0.4; musicMain.loop  = true;
const musicLevel5 = new Audio('audio/Confined5.wav');        musicLevel5.volume = 0.4; musicLevel5.loop = true;
// Keep PLAYLIST as alias so existing pause calls still work
const PLAYLIST = [musicMain, musicLevel5];
let playlistIndex = 0; // unused but kept for safety

const sfxShoot = new Audio('audio/pistol-shot-233473.mp3');
sfxShoot.volume = 0.6;

const sfxM60 = new Audio('audio/mg42-sfx-80169.mp3');
sfxM60.volume = 0.55;

// (sfxM16 retained as alias so any legacy reference keeps working — same file as M60 loop.)
const sfxM16 = new Audio(MG_FIRE_AUDIO);
sfxM16.volume = 0.55;

const sfxGameOver = new Audio('audio/game-over-deep-male-voice-clip-352695.mp3');
sfxGameOver.volume = 0.85;

const sfxBanshee = new Audio('audio/banshie-scream-70413.mp3');
sfxBanshee.volume = 0.85;

const sfxSpawnLine = new Audio('audio/come-here-scum-323781.mp3');
sfxSpawnLine.volume = 0.9;

const sfxJump = new Audio('audio/freesound_community-jumping_1-6452.mp3');
sfxJump.volume = 0.55;

const sfxBonusChant = new Audio('audio/fidelfortune-beauty-woman-voice-ancient-chant-mystic-205225.mp3');
sfxBonusChant.volume = 0.85;
sfxBonusChant.loop = true;

// Set to true while the level-5 banshee scream is playing; blocks both zombie
// spawning and the "level clear" auto-trigger that would otherwise fire on the empty horde.
let pendingZombieSpawn = false;
sfxBanshee.addEventListener('ended', () => {
  if (pendingZombieSpawn) {
    pendingZombieSpawn = false;
    spawnZombies();
  }
});

const sfxRocket = new Audio('audio/futuristic-zoom-whoosh-2-183978.mp3');
sfxRocket.volume = 0.7;

// Two zombie groan clips — each zombie alternates between them.
const sfxZombies = [
  new Audio('audio/zombie-15965.mp3'),
  new Audio('audio/zombie-sound-2-357976.mp3'),
];
sfxZombies.forEach(a => { a.volume = 0.35; });
let zombieSfxIndex = 0;

function togglePause() {
  if (gameState === 'playing') {
    gameState = 'paused';
    stopMGLoop();
    PLAYLIST.forEach(a => a.pause());
    sfxBonusChant.pause();
  } else if (gameState === 'paused') {
    gameState = 'playing';
    if (inHiddenLevel) {
      sfxBonusChant.play().catch(() => {});
    } else {
      (level === 5 ? musicLevel5 : musicMain).play().catch(() => {});
    }
  }
}

function startMusic() {
  introClip.pause();
  sfxBonusChant.pause(); sfxBonusChant.currentTime = 0;
  PLAYLIST.forEach(a => { a.pause(); a.currentTime = 0; });
  playlistIndex = 0;
  (level === 5 ? musicLevel5 : musicMain).play().catch(() => {});
}

// Audio pools — pre-allocated round-robin Audio elements per weapon so we don't
// cloneNode() on every shot. cloneNode allocates + decodes metadata and is very
// laggy on mobile when firing at 12-20 rounds/sec (M60/M16).
function _makePool(src, size, volume) {
  const pool = [];
  for (let i = 0; i < size; i++) {
    const a = new Audio(src);
    a.volume = volume;
    pool.push(a);
  }
  return { pool, idx: 0 };
}
const _shootPools = {
  pistol: _makePool('audio/pistol-shot-233473.mp3', 6, 0.6),
  m60:    _makePool('audio/mg42-sfx-80169.mp3', 6, 0.55),
  m16:    _makePool(MG_FIRE_AUDIO, 8, 0.55),
  rocket: _makePool('audio/futuristic-zoom-whoosh-2-183978.mp3', 3, 0.7),
};
// Web Audio API for gun SFX — HTMLAudioElement.play() is one of the slowest things
// on mobile and was responsible for the heavy lag during rapid fire. Web Audio
// decodes each sample once into an AudioBuffer, then plays via throwaway
// AudioBufferSourceNodes — sample-accurate, ~zero per-play overhead.
let audioCtx = null;
const _gunBuffers = {}; // { pistol: { buffer, volume }, ... }
const _gunSrcs = [
  ['pistol', 'audio/pistol-shot-233473.mp3', 0.6],
  ['m60',    'audio/mg42-sfx-80169.mp3',    0.55],
  ['m16',    MG_FIRE_AUDIO, 0.55],
  ['rocket', 'audio/futuristic-zoom-whoosh-2-183978.mp3', 0.7],
];
function initAudioCtx() {
  if (audioCtx) {
    if (audioCtx.state === 'suspended') audioCtx.resume();
    return;
  }
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return;
  audioCtx = new AC();
  for (const [key, src, vol] of _gunSrcs) {
    fetch(src)
      .then(r => r.arrayBuffer())
      .then(buf => audioCtx.decodeAudioData(buf))
      .then(decoded => { _gunBuffers[key] = { buffer: decoded, volume: vol }; })
      .catch(() => { /* fall back to HTMLAudio pool */ });
  }
}

// Looping MG fire sample for M16/M60 — one playing audio element instead of one
// per-bullet trigger. Eliminates the mobile lag spike caused by rapid play()s.
const sfxMGLoop = new Audio(MG_FIRE_AUDIO);
sfxMGLoop.loop = true;
sfxMGLoop.volume = 0.55;
function startMGLoop() {
  if (sfxMGLoop.paused) {
    try { sfxMGLoop.currentTime = 0; } catch (_) {}
    sfxMGLoop.play().catch(() => {});
  }
}
function stopMGLoop() {
  if (!sfxMGLoop.paused) {
    sfxMGLoop.pause();
    try { sfxMGLoop.currentTime = 0; } catch (_) {}
  }
}

// Light throttle to avoid stacking too many overlapping samples per second.
let _lastShootSfxTime = 0;
function playShootSfx(weapon) {
  // Full-auto weapons use the looping sample instead of a per-bullet sound.
  if (weapon === 'm16' || weapon === 'm60') {
    startMGLoop();
    return;
  }
  if (lowQuality) {
    const now = performance.now();
    if (now - _lastShootSfxTime < 70 && weapon !== 'rocket') return;
    _lastShootSfxTime = now;
  }
  // Prefer Web Audio if the buffer for this weapon has decoded.
  const wb = _gunBuffers[weapon];
  if (audioCtx && wb) {
    const src = audioCtx.createBufferSource();
    src.buffer = wb.buffer;
    const gain = audioCtx.createGain();
    gain.gain.value = wb.volume;
    src.connect(gain).connect(audioCtx.destination);
    try { src.start(0); } catch (_) {}
    return;
  }
  // Fallback: HTMLAudio pool (before buffers decode, or if Web Audio missing).
  const p = _shootPools[weapon] || _shootPools.pistol;
  const a = p.pool[p.idx];
  p.idx = (p.idx + 1) % p.pool.length;
  try { a.currentTime = 0; } catch (_) {}
  a.play().catch(() => {});
}

function playZombieGroan(volume) {
  const src = sfxZombies[zombieSfxIndex];
  zombieSfxIndex = (zombieSfxIndex + 1) % sfxZombies.length;
  const s = src.cloneNode();
  s.volume = Math.max(0.03, Math.min(0.35, volume));
  s.play().catch(() => {});
}

// ── Zombie individual sprites ────────────────────────────────
const ZOMBIE_DIR = 'images/zombie_character_snips_transparent_pngs/';
// Canonical standing-frame pixel height — every frame is scaled against this
// so lying-down death frames stay proportional instead of stretching to fill the hitbox.
const ZOMBIE_REF_H = 123;
const ZOMBIE_ANIMS = {
  idle:   { prefix: 'zombie_basic_movement_idle_', frames: 3, speed: 14 },
  walk:   { prefix: 'zombie_basic_movement_walk_', frames: 3, speed: 10 },
  run:    { prefix: 'zombie_basic_movement_run_',  frames: 3, speed: 7  },
  attack:   { prefix: 'zombie_attacks_melee_',       frames: 8, speed: 6  },
  gunshoot: { prefix: 'zombie_gun_actions_',          frames: 8, speed: 5  },
  die:      { prefix: 'zombie_death_animations_',    frames: 7, speed: 8  },
};
const zombieSprites = {};
let zombieLoadedCount = 0;

// Big Boss Zombie sprites used for mega boss levels 2-5
const BIG_BOSS_DIR = "images/zombie_character_snips_transparent_pngs/Boss Zombie/";
const bigBossSprites = { appear: new Image(), walk: new Image(), jump: new Image(), dead: new Image() };
bigBossSprites.appear.src = BIG_BOSS_DIR + 'Big_Boss_Zombie_Appear_transparent.png';
bigBossSprites.walk.src   = BIG_BOSS_DIR + 'Big_Boss_Zombie_Walk_transparent.png';
bigBossSprites.jump.src   = BIG_BOSS_DIR + 'big_boss_zombie_jump_transparent.png';
bigBossSprites.dead.src   = BIG_BOSS_DIR + 'Big Boss Zombie dead.png';

// Dog Zombie sprites
const DOG_ZOMBIE_DIR = 'images/zombie_character_snips_transparent_pngs/Dog Zombie/';
const dogZombieSprites = {
  idle:   (() => { const i = new Image(); i.src = DOG_ZOMBIE_DIR + 'Idol_Dog_Zombie_transparent.png'; return i; })(),
  attack: (() => { const i = new Image(); i.src = DOG_ZOMBIE_DIR + 'attacking_Zombie_Dog_transparent.png'; return i; })(),
  dead:   (() => { const i = new Image(); i.src = DOG_ZOMBIE_DIR + 'dead_Zombie_Dog_transparent.png'; return i; })(),
  walk: ['Walking_Dog_Zombie_transparent.png','Walking_Dog_Zombie2_transparent.png','Walking_Zombie_Dog3_transparent.png']
         .map(n => { const i = new Image(); i.src = DOG_ZOMBIE_DIR + n; return i; }),
};
const sfxDogSpawn  = new Audio('audio/Dog/freesound_community-075681_electric-shock-33018.mp3'); sfxDogSpawn.volume = 0.85;
const sfxDogWalk   = [new Audio('audio/Dog/very-angry-dog-101287.mp3'), new Audio('audio/Dog/dogbeaething.mp3')];
sfxDogWalk.forEach(a => { a.volume = 0.6; });
const sfxDogAttack = new Audio('audio/Dog/Dog monster-growl-390285.mp3'); sfxDogAttack.volume = 0.85;

// Demon Boss sprites (level 5)
const DEMON_DIR = 'images/Demon Boss/';
const demonBossSprites = {
  idle:   (() => { const i = new Image(); i.src = DEMON_DIR + 'IdolDemonBoss_transparent.png'; return i; })(),
  attack: (() => { const i = new Image(); i.src = DEMON_DIR + 'jumpattackdemonboss_transparent.png'; return i; })(),
  dead:   (() => { const i = new Image(); i.src = DEMON_DIR + 'DeadDemonBoss_transparent.png'; return i; })(),
  walk:   ['walking_demonboss_transparent.png','walking_demonboss2_transparent.png','walking_demonboss3_transparent.png']
            .map(n => { const i = new Image(); i.src = DEMON_DIR + n; return i; }),
};

// Demon Boss audio
const sfxDemonLaugh    = new Audio('audio/Demon/demonic-laughter-477923.mp3');   sfxDemonLaugh.volume = 0.9;
const sfxDemonGrowl    = new Audio('audio/Demon/demon-voice-growling-503874.mp3'); sfxDemonGrowl.volume = 0.75;
const sfxDemonNoMercy  = new Audio('audio/Demon/Demon-voice-no-mercy-477827.mp3'); sfxDemonNoMercy.volume = 0.9;
const sfxDemonNoRun    = new Audio('audio/Demon/demon-voice-no-more-running-480562.mp3'); sfxDemonNoRun.volume = 0.9;
const zombieTotalImages = Object.values(ZOMBIE_ANIMS).reduce((s, a) => s + a.frames, 0);

for (const [name, cfg] of Object.entries(ZOMBIE_ANIMS)) {
  zombieSprites[name] = [];
  for (let i = 1; i <= cfg.frames; i++) {
    const img = new Image();
    img.onload = () => { zombieLoadedCount++; };
    img.onerror = () => console.error('Failed to load zombie sprite', img.src);
    img.src = ZOMBIE_DIR + cfg.prefix + String(i).padStart(2, '0') + '.png';
    zombieSprites[name].push(img);
  }
}

// ZS retains anim metadata used by the AI/animation loops
const ZS = {
  anim: {
    idle:   { frames: ZOMBIE_ANIMS.idle.frames,   speed: ZOMBIE_ANIMS.idle.speed   },
    walk:   { frames: ZOMBIE_ANIMS.walk.frames,   speed: ZOMBIE_ANIMS.walk.speed   },
    run:    { frames: ZOMBIE_ANIMS.run.frames,    speed: ZOMBIE_ANIMS.run.speed    },
    attack:   { frames: ZOMBIE_ANIMS.attack.frames,   speed: ZOMBIE_ANIMS.attack.speed   },
    gunshoot: { frames: ZOMBIE_ANIMS.gunshoot.frames, speed: ZOMBIE_ANIMS.gunshoot.speed },
    die:      { frames: ZOMBIE_ANIMS.die.frames,      speed: ZOMBIE_ANIMS.die.speed      },
  },
};

// ── Ziggy Kramer individual sprites ──────────────────────────
const ZIGGY_DIR = 'images/commando_organized_132x174_animation_files/';
const ZIGGY_ANIMS = {
  idle:  { folder: 'idol_file',   prefix: 'idol_',   nums: [3,5,6],       speed: 6 },
  walk:  { folder: 'walk_file',   prefix: 'walk_',   nums: [1,2,4,5,4,2], speed: 7 },
  jump:  { folder: 'jump_file',   prefix: 'jump_',   nums: [1,2,3,4,5],   speed: 4 },
  shoot: { folder: 'pistol_file', prefix: 'pistol_', nums: [3],           speed: 3 },
  m16:   { folder: 'm16_file',    prefix: 'm16_',    nums: [4,5],         speed: 2 },
  melee: { folder: 'mele_file',   prefix: 'mele_',   nums: [2,3,4],       speed: 2 },
  die:   { folder: 'die_file',    prefix: 'die_',    nums: [5,6,7,8],     speed: 6 },
};
const ziggySprites = {};
let ziggyLoadedCount = 0;

for (const [name, cfg] of Object.entries(ZIGGY_ANIMS)) {
  ziggySprites[name] = [];
  for (const n of cfg.nums) {
    const img = new Image();
    img.onload = () => { ziggyLoadedCount++; };
    img.src = ZIGGY_DIR + cfg.folder + '/' + cfg.prefix + String(n).padStart(3, '0') + '.png';
    ziggySprites[name].push(img);
  }
}

// New sprites: 132×174 canvas, character fills nearly the full height, feet at row ~171.
// Display height matches Viper (208 * 0.6 = 124.8) so both characters appear the same size.
const ZIGGY_HEIGHT    = 105;
const ZIGGY_FOOT_FRAC = 0.989;

let playerAnim = { state: 'idle', frame: 0, timer: 0 };

// ── Level background images ───────────────────────────────────
const BG_IMAGES = {};
[['1','images/bg_scaled/destroyed_city_level.png'],
 ['2','images/bg_scaled/dungeon_level.png'],
 ['3','images/bg_scaled/jungle_level.png'],
 ['4','images/bg_scaled/space_station_level.png'],
 ['5','images/bg_scaled/hell_level.png']].forEach(([lvl, src]) => {
  const img = new Image(); img.src = src; BG_IMAGES[lvl] = img;
});

// ── Viper individual sprites ──────────────────────────────────
const VIPER_DIR = 'images/full_character_snips_no_background/';
const VIPER_ANIMS = {
  idle:     { prefix: '01_idle_',                 frames: 9, speed: 10 },
  walk:     { prefix: '02_walking_',              frames: 9, speed: 8  },
  jump:     { prefix: '03_jumping_',              frames: 9, speed: 7  },
  shoot:    { prefix: '04_pistol_shooting_',      frames: 9, speed: 5  },
  m60shoot: { prefix: '05_m60_shooting_',         frames: 5, speed: 4  },
  die:      { prefix: '08_dying_',                frames: 9, speed: 10 },
};
const viperSprites = {};
let viperLoadedCount = 0;
const viperTotalImages = Object.values(VIPER_ANIMS).reduce((s, a) => s + a.frames, 0);

for (const [name, cfg] of Object.entries(VIPER_ANIMS)) {
  viperSprites[name] = [];
  for (let i = 1; i <= cfg.frames; i++) {
    const img = new Image();
    img.onload = () => { viperLoadedCount++; if (name === 'idle') renderCharPreviews(); };
    img.src = VIPER_DIR + cfg.prefix + String(i).padStart(2, '0') + '.png';
    viperSprites[name].push(img);
  }
}

const VIPER_SCALE = 0.6; // 128×208 → ~77×125 on screen

// ── Rocket launcher shooting sprites (single frame each) ─────
const ziggyRocketImg = new Image();
ziggyRocketImg.src = 'images/commando_redone_same_size_zero_white_edges/rocket_launcher_shooting/commando_rocket_launcher_shooting_01.png';
const viperRocketImg = new Image();
viperRocketImg.src = 'images/full_character_snips_no_background/07_rocket_launcher_shooting_04.png';

// ── Character selection ───────────────────────────────────────
let selectedChar = 'rambo';

function activePlayerLoaded() {
  if (selectedChar === 'viper') return viperLoadedCount >= VIPER_ANIMS.idle.frames;
  return ziggyLoadedCount >= ZIGGY_ANIMS.idle.nums.length;
}

// ── State ────────────────────────────────────────────────────
let gameState = 'menu'; // menu | playing | dead | levelup | win
let neverDied = true;
let portal = null;      // secret portal object
let portalSpawned = false;
let inHiddenLevel = false;
let portalSearchTimer = 0;
let score = 0;
let level = 1;
let frameCount = 0;
let cameraX = 0;
let keys = {};
let lastShot = 0;
let lastGrenade = 0;

// ── Level config ─────────────────────────────────────────────
const LEVELS = [
  { zombies: 4,  speed: 0.7, bg: '#1a0a00', groundColor: '#3a1500' },
  { zombies: 14, speed: 1.6, bg: '#0a0a1a', groundColor: '#1a1540' },
  { zombies: 20, speed: 2.0, bg: '#0a1a00', groundColor: '#1a3500' },
  { zombies: 28, speed: 2.5, bg: '#1a001a', groundColor: '#350035' },
  { zombies: 36, speed: 3.0, bg: '#1a0000', groundColor: '#350000' },
];

// ── Hidden bonus level config ────────────────────────────────
const HIDDEN_LEVEL_CONFIG = {
  zombies: 8,
  speed: 2.6,
  zombieHpMult: 2.0,
};

// ── Per-level mega boss tuning ────────────────────────────────
const BOSS_CONFIGS = [
  // L1 — slow, telegraphed, no spit.  Let the player figure out the pounce pattern.
  { hp: 500,  w: 80,  h: 190, speed: 1.8, pounceVx: 8,  pounceVy: -8,  retreatVx: 7,  meleeDmg: 12, attackDelayMin: 280, attackDelayRand: 200, lungeStart: 85, spitEnabled: false, spitOrbs: 0, spitCooldownBase: 9999, prefMin: 200, prefMax: 450, hopVy: -5.0 },
  // L2 — faster, spit unlocked (2 orbs).
  { hp: 900,  w: 88,  h: 210, speed: 2.3, pounceVx: 10, pounceVy: -10, retreatVx: 8,  meleeDmg: 18, attackDelayMin: 220, attackDelayRand: 160, lungeStart: 80, spitEnabled: true,  spitOrbs: 2, spitCooldownBase: 150, prefMin: 220, prefMax: 420, hopVy: -6.0 },
  // L3 — aggressive, 3-orb spread spit.
  { hp: 1300, w: 95,  h: 225, speed: 2.8, pounceVx: 12, pounceVy: -11, retreatVx: 10, meleeDmg: 25, attackDelayMin: 160, attackDelayRand: 120, lungeStart: 75, spitEnabled: true,  spitOrbs: 3, spitCooldownBase: 120, prefMin: 240, prefMax: 400, hopVy: -6.5 },
  // L4 — relentless, tight range, 4-orb fan.
  { hp: 1800, w: 102, h: 240, speed: 3.3, pounceVx: 13, pounceVy: -12, retreatVx: 11, meleeDmg: 32, attackDelayMin: 110, attackDelayRand: 100, lungeStart: 70, spitEnabled: true,  spitOrbs: 4, spitCooldownBase:  95, prefMin: 200, prefMax: 380, hopVy: -7.0 },
  // L5 — nightmare.  5-orb wall, short attack pause, huge HP.
  { hp: 2600, w: 112, h: 260, speed: 4.0, pounceVx: 15, pounceVy: -13, retreatVx: 13, meleeDmg: 40, attackDelayMin:  70, attackDelayRand:  80, lungeStart: 65, spitEnabled: true,  spitOrbs: 5, spitCooldownBase:  75, prefMin: 180, prefMax: 360, hopVy: -7.5 },
];

const GROUND_Y = 400;
const WORLD_WIDTH = 3600;
const PLATFORM_H = 16;

// ── Platforms ────────────────────────────────────────────────
// Floating platforms are regenerated each level/round; the ground tile is always present.
let basePlatforms = [{ x: 0, y: GROUND_Y, w: WORLD_WIDTH, h: PLATFORM_H }];

function generatePlatforms() {
  basePlatforms = [{ x: 0, y: GROUND_Y, w: WORLD_WIDTH, h: PLATFORM_H }];
  // Y-range bounds keep platforms reachable from the ground (jump apex ≈ 154px above the ground).
  const minY = 230, maxY = 340;
  let x = 220; // leave the player spawn area clear
  while (x < WORLD_WIDTH - 180) {
    const w = 110 + Math.floor(Math.random() * 80);
    const y = minY + Math.floor(Math.random() * (maxY - minY));
    basePlatforms.push({ x, y, w, h: PLATFORM_H });
    // Gap between platforms — wide enough to be a jump challenge, tight enough to be reachable.
    x += w + 110 + Math.floor(Math.random() * 180);
  }
}
generatePlatforms();

// ── Player ───────────────────────────────────────────────────
const player = {
  x: 80, y: GROUND_Y - 56,
  w: 28, h: 56,
  vx: 0, vy: 0,
  onGround: false,
  facing: 1,       // 1=right, -1=left
  hp: 100,
  maxHp: 100,
  ammo: 30,
  weapon: 'pistol',
  heavyAmmo: 0,
  lives: 3,
  deathTimer: 0,
  anim: 0,
  animTimer: 0,
  isMoving: false,
  isShooting: false,
  isMelee: false,
  shootTimer: 0,
  invincible: 0,
};

// ── Weapons ──────────────────────────────────────────────────
const WEAPONS = {
  pistol: { fireRate: 8, damage: 20, bulletSpeed: 14, spread: 0,    color: '#ffffff', flash: '#ffcc00', name: 'Pistol', auto: false },
  m16:    { fireRate: 3, damage: 18, bulletSpeed: 18, spread: 0.05, color: '#ffe680', flash: '#ffee66', name: 'M16',    auto: true  },
  m60:    { fireRate: 5, damage: 34, bulletSpeed: 16, spread: 0.09, color: '#ff9933', flash: '#ff6600', name: 'M60',    auto: true  },
  rocket: { fireRate: 55, damage: 220, bulletSpeed: 6,  spread: 0,    color: '#ff5500', flash: '#ff3300', name: 'RPG',    auto: false },
};
const HEAVY_AMMO_ON_PICKUP = { m16: 60, m60: 100, rocket: 5 };
const HEAVY_AMMO_MAX = 200;
function characterWeapon() { return selectedChar === 'viper' ? 'm60' : 'm16'; }

// ── Collections ──────────────────────────────────────────────
let bullets = [];
let grenadeList = [];
let explosions = [];
let zombies = [];
let particles = [];
let ammoPickups = [];
let weaponPickups = [];
let bloodSplatters = [];
let slimeProjectiles = [];
let lightningBolts = [];
let spawnQueue = [];
let spawnTimer  = 0;
const SPAWN_INTERVAL = 120; // frames between each zombie (~2 s at 60 fps)

let bossRoundActive = false;
let bossSpawnedThisLevel = false;
let bossAnnounceTimer = 0;
let healthDroppedThisLevel = false;
let dogLevels = [];
let dogEventState = 'idle'; // 'idle'|'freeze'|'active'|'dissipating'|'done'
let dogFogAlpha = 0;
let dogEventTimer = 0;
let pendingDogEvent = false;
let dogSpawnQueue = []; // [{timer}] staggered dog spawns

// ── Spawn zombies for current level ─────────────────────────
function randomSpawnX() {
  // Pick a random point across the world, at least 350 px from the player.
  let x, attempts = 0;
  do {
    x = 200 + Math.random() * (WORLD_WIDTH - 400);
    attempts++;
  } while (Math.abs(x - player.x) < 350 && attempts < 20);
  return x;
}

function spawnZombies() {
  zombies = [];
  spawnQueue = [];
  spawnTimer = 0;
  bossSpawnedThisLevel = false;
  bossRoundActive = false;
  dogEventState = 'idle'; dogFogAlpha = 0; pendingDogEvent = false; dogSpawnQueue = []; healthDroppedThisLevel = false; healthDroppedThisLevel = false; dogSpawnQueue = [];
  const cfg = LEVELS[level - 1];
  // On mobile, scale the horde down so the CPU/GPU can keep up at 60fps.
  for (let i = 0; i < cfg.zombies; i++) {
    spawnQueue.push({ x: randomSpawnX(), speed: cfg.speed + Math.random() * 0.5 });
  }
  // Release the first one immediately so the screen isn't empty
  if (spawnQueue.length > 0) {
    const e = spawnQueue.shift();
    const fz = createZombie(e.x, e.speed);
    zombies.push(fz);
  }
}

function createZombie(x, speed) {
  const isBoss  = Math.random() < 0.1;
  const isGunner = !isBoss && Math.random() < 0.28; // ~28% of non-boss zombies are gunners
  const w  = isBoss ? 52 : 32;
  const h  = isBoss ? 130 : 85;
  const hp = isBoss ? 200 + level * 50 : 30 + level * 10;
  return {
    x, y: GROUND_Y,   // starts at ground surface; rises up to GROUND_Y - h
    w, h,
    vx: 0, vy: 0,
    onGround: false,
    hp,
    maxHp: hp,
    speed: isBoss ? speed * 0.5 : speed,
    anim: 0,
    animTimer: 0,
    attackCooldown: 0,
    dead: false,
    deathTimer: 0,
    type: isBoss ? 'big' : isGunner ? 'gunner' : 'normal',
    state: 'walk',
    stateFrame: 0,
    stateTimer: 0,
    nextGroan: frameCount + 90 + Math.floor(Math.random() * 480),
    spitCooldown:  isBoss   ? 90  + Math.floor(Math.random() * 90)  : 0,
    shootCooldown: isGunner ? 40 + Math.floor(Math.random() * 60) : 0,
    jumpTimer: 60 + Math.floor(Math.random() * 180),
    rising: true,
    riseSpeed: 2.2,
    retreatTimer: 0,
  };
}

function createMegaBoss(x) {
  const cfg = BOSS_CONFIGS[Math.min(level - 1, BOSS_CONFIGS.length - 1)];
  return {
    x, y: GROUND_Y,
    w: cfg.w, h: cfg.h,
    vx: 0, vy: 0, onGround: false,
    hp: cfg.hp, maxHp: cfg.hp,
    speed: cfg.speed,
    anim: 0, animTimer: 0,
    attackCooldown: 0,
    dead: false, deathTimer: 0,
    type: 'mega',
    bossLevel: level,
    state: 'walk', stateFrame: 0, stateTimer: 0,
    nextGroan: frameCount + 60 + Math.floor(Math.random() * 120),
    spitCooldown: cfg.spitCooldownBase,
    // Cached config values so the AI loop doesn't re-index every frame
    pounceVx: cfg.pounceVx, pounceVy: cfg.pounceVy, retreatVx: cfg.retreatVx,
    meleeDmg: cfg.meleeDmg, lungeStart: cfg.lungeStart,
    spitEnabled: cfg.spitEnabled, spitOrbs: cfg.spitOrbs,
    spitCooldownBase: cfg.spitCooldownBase,
    prefMin: cfg.prefMin, prefMax: cfg.prefMax, hopVy: cfg.hopVy,
    // Pounce state machine
    megaState: 'evade',
    attackDir: 1,
    attackDelay: cfg.attackDelayMin + Math.floor(Math.random() * cfg.attackDelayRand),
    attackDelayMin: cfg.attackDelayMin, attackDelayRand: cfg.attackDelayRand,
    hopTimer: 90 + Math.floor(Math.random() * 60),
    lungeTimer: 0,
    retreatTimer: 0,
    hasHitOnLunge: false,
    contactCooldown: 0,
    rising: true, riseSpeed: 1.0,
    demonAnnounced: false,
    demonWalkTimer: 120,
    demonWalkFrame: 0, demonWalkFrameTimer: 0,
  };
}

function createDogZombie(x) {
  return {
    x, y: GROUND_Y,
    w: 112, h: 65,
    vx: 0, vy: 0, onGround: false,
    hp: 180 + level * 50, maxHp: 180 + level * 50,
    speed: 3.8 + Math.random() * 1.2,
    type: 'dog',
    state: 'walk', stateFrame: 0, stateTimer: 0,
    dead: false, deathTimer: 0,
    attackCooldown: 0,
    nextGroan: frameCount + 120 + Math.floor(Math.random() * 180),
    frozen: false,
    rising: true, riseSpeed: 4.5,
    dogWalkFrame: 0, dogWalkFrameTimer: 0,
    dogWalkSfxTimer: 40 + Math.floor(Math.random() * 60),
    dogWalkSfxAlt: 0,
    jumpTimer: 80 + Math.floor(Math.random() * 80),
    spitCooldown: 0, shootCooldown: 0, anim: 0, animTimer: 0,
    dogState: 'evade',
    dogAttackDelay: 60 + Math.floor(Math.random() * 80),
    dogLungeTimer: 0, dogRetreatTimer: 0, dogHasHit: false,
  };
}

function spawnMegaBoss() {
  bossRoundActive = true;
  bossAnnounceTimer = 210;
  const bx = Math.max(200, Math.min(WORLD_WIDTH - 200, WORLD_WIDTH / 2 + (Math.random() - 0.5) * 600));
  zombies.push(createMegaBoss(bx));
}


// ── Secret portal ────────────────────────────────────────────
function spawnPortalScene() {
  portalSpawned = true;
  const side = Math.random() < 0.5 ? 1 : -1;
  const px = Math.max(200, Math.min(WORLD_WIDTH - 200, player.x + side * (120 + Math.random() * 100)));
  const py = GROUND_Y - 90;
  portal = { x: px, y: py, w: 60, h: 90, anim: 0, active: true };
  spawnAmmoPickup(px - 80, GROUND_Y - 14);
  spawnAmmoPickup(px + 90, GROUND_Y - 14);
  spawnAmmoPickup(px - 40, GROUND_Y - 14);
  ammoPickups.push({ x: px + 150, y: GROUND_Y - 14, w: 20, h: 14, anim: 0, isHealth: true });
  ammoPickups.push({ x: px - 160, y: GROUND_Y - 14, w: 20, h: 14, anim: 0, isHealth: true });
}

function enterHiddenLevel() {
  PLAYLIST.forEach(a => { a.pause(); a.currentTime = 0; });
  sfxBonusChant.currentTime = 0;
  sfxBonusChant.play().catch(() => {});
  inHiddenLevel = true;
  level = 99;
  portal = null;
  gameState = 'playing';
  zombies = [];
  spawnQueue = [];
  spawnTimer = 0;
  bossSpawnedThisLevel = false;
  bossRoundActive = false;
  generatePlatforms();
  resetPlayerPos();
  bullets = []; grenadeList = []; explosions = [];
  particles = []; bloodSplatters = []; slimeProjectiles = [];
  ammoPickups = []; weaponPickups = [];
  const cfg = HIDDEN_LEVEL_CONFIG;
  for (let i = 0; i < cfg.zombies; i++) {
    spawnQueue.push({ x: randomSpawnX(), speed: cfg.speed + Math.random() * 0.5, hpMult: cfg.zombieHpMult });
  }
  if (spawnQueue.length > 0) {
    const e = spawnQueue.shift();
    zombies.push(createZombieEx(e.x, e.speed, e.hpMult));
  }
  updateLevelUI();
}

function createZombieEx(x, speed, hpMult) {
  const z = createZombie(x, speed);
  z.hp = Math.ceil(z.hp * (hpMult || 1));
  z.maxHp = z.hp;
  return z;
}

function createCharBoss(x) {
  const other = selectedChar === 'viper' ? 'rambo' : 'viper';
  const hp = 1800;
  return {
    x, y: GROUND_Y,
    w: 28, h: 85,
    vx: 0, vy: 0, onGround: false,
    hp, maxHp: hp,
    speed: 5.5,
    type: 'charBoss',
    charSkin: other,
    state: 'walk', stateFrame: 0, stateTimer: 0,
    attackCooldown: 0,
    dead: false, deathTimer: 0,
    nextGroan: frameCount + 60,
    megaState: 'evade',
    attackDir: 1,
    attackDelay: 55 + Math.floor(Math.random() * 55),
    attackDelayMin: 50, attackDelayRand: 55,
    hopTimer: 30 + Math.floor(Math.random() * 50),
    lungeTimer: 0,
    retreatTimer: 0,
    hasHitOnLunge: false,
    contactCooldown: 0,
    jumpTimer: 30 + Math.floor(Math.random() * 60),
    shootCooldown: 25 + Math.floor(Math.random() * 25),
    burstCount: 0,      // tracks rapid-fire burst shots
    pounceVx: 15, pounceVy: -13, retreatVx: 13,
    meleeDmg: 35, lungeStart: 60,
    prefMin: 90, prefMax: 280,
    hopVy: -13,
    rising: true, riseSpeed: 2.0,
  };
}

function spawnCharBoss() {
  bossRoundActive = true;
  bossAnnounceTimer = 210;
  const bx = Math.max(300, Math.min(WORLD_WIDTH - 300, WORLD_WIDTH / 2 + (Math.random() - 0.5) * 400));
  zombies.push(createCharBoss(bx));
}

function spawnAmmoPickup(x, y) {
  ammoPickups.push({ x, y, w: 20, h: 14, anim: 0 });
}

function spawnWeaponPickup(x, y, weapon) {
  weapon = weapon || characterWeapon();
  weaponPickups.push({ x, y, w: 44, h: 16, weapon, anim: 0 });
}

// ── Physics helpers ──────────────────────────────────────────
function applyGravity(entity) {
  const g   = level === 4 ? 0.15 : 0.55;
  const cap = level === 4 ? 5    : 18;
  entity.vy += g;
  if (entity.vy > cap) entity.vy = cap;
}

function resolveGroundCollision(entity) {
  entity.onGround = false;
  entity.x += entity.vx;
  entity.y += entity.vy;

  for (const p of basePlatforms) {
    if (
      entity.x + entity.w > p.x &&
      entity.x < p.x + p.w &&
      entity.y + entity.h > p.y &&
      entity.y + entity.h < p.y + p.h + Math.abs(entity.vy) + 4 &&
      entity.vy >= 0
    ) {
      entity.y = p.y - entity.h;
      entity.vy = 0;
      entity.onGround = true;
    }
  }
  // world bounds
  if (entity.x < 0) entity.x = 0;
  if (entity.x + entity.w > WORLD_WIDTH) entity.x = WORLD_WIDTH - entity.w;
}

// ── Shooting ─────────────────────────────────────────────────
function shoot() {
  const usingHeavy = player.weapon !== 'pistol';
  // Heavy weapons require their own ammo; if it runs out, drop back to pistol.
  if (usingHeavy && player.heavyAmmo <= 0) {
    player.weapon = 'pistol';
  }
  const isHeavy = player.weapon !== 'pistol';
  // Both characters now have unlimited pistol ammo.
  const w = WEAPONS[player.weapon];
  if (frameCount - lastShot < w.fireRate) return;
  lastShot = frameCount;
  if (isHeavy) player.heavyAmmo--;
  player.isShooting = true;
  player.shootTimer = 10;
  playShootSfx(player.weapon);

  // Per-weapon barrel height. M60 (Viper) is hip-braced low; M16 (Ziggy) sits a touch higher;
  // Ziggy's pistol also holds slightly higher than Viper's.
  const muzzleY =
    player.weapon === 'm60' ? player.y - 1 :
    player.weapon === 'm16' ? player.y - 24 :
    player.weapon === 'pistol' && selectedChar !== 'viper' ? player.y - 24 :
    player.y - 18;
  const spread = w.spread ? (Math.random() - 0.5) * 2 * w.spread : 0;
  // Per-weapon barrel reach. M16 and Ziggy's pistol extend further forward in the sprites.
  const barrelReach =
    player.weapon === 'm16' ? 34 :
    player.weapon === 'm60' ? 20 :
    player.weapon === 'pistol' && selectedChar !== 'viper' ? 22 :
    12;
  bullets.push({
    // Spawn forward of the player so rounds visibly leave the barrel instead of the body.
    x: player.x + (player.facing === 1 ? player.w + barrelReach : -barrelReach),
    y: muzzleY,
    vx: w.bulletSpeed * player.facing,
    vy: spread * w.bulletSpeed,
    life: player.weapon === 'rocket' ? 90 : 60,
    fromPlayer: true,
    damage: w.damage + level * 2,
    color: w.color,
    heavy: isHeavy,
    isRocket: player.weapon === 'rocket',
  });

  // muzzle flash — emerge from the same forward offset as the bullets
  particles.push(...createSparks(
    player.x + (player.facing === 1 ? player.w + barrelReach : -barrelReach),
    muzzleY, w.flash, isHeavy ? 6 : 4
  ));
  updateAmmoUI();
}

function meleeAttack() {
  if (frameCount - lastShot < 25) return;
  lastShot = frameCount;
  player.isMelee = true;
  player.shootTimer = 15;

  const range = 56;
  const px = player.x + player.w / 2;
  const py = player.y + player.h / 2;
  for (const z of zombies) {
    if (z.dead) continue;
    const dx = (z.x + z.w / 2) - px;
    const dy = (z.y + z.h / 2) - py;
    const inFront = player.facing === 1 ? (dx > -10 && dx < range) : (dx < 10 && dx > -range);
    if (inFront && Math.abs(dy) < 60) {
      damageZombie(z, 35, player.facing * 6);
    }
  }
  particles.push(...createSparks(
    player.x + (player.facing === 1 ? player.w + 12 : -12),
    player.y - 20, '#ffffff', 5
  ));
}

function throwGrenade() {
  if (player.grenades <= 0) return;
  if (frameCount - lastGrenade < 60) return;
  lastGrenade = frameCount;
  player.grenades--;

  grenadeList.push({
    x: player.x + player.w / 2,
    y: player.y,
    vx: 7 * player.facing,
    vy: -9,
    life: 90,
    fuse: 70,
  });
}

// ── Explosion ────────────────────────────────────────────────
function createExplosion(x, y, radius) {
  explosions.push({ x, y, radius, maxRadius: radius, life: 30, maxLife: 30 });
  particles.push(...createSparks(x, y, '#ff8800', 18));
  particles.push(...createSparks(x, y, '#ffff00', 10));

  // damage zombies in radius
  for (const z of zombies) {
    if (z.dead) continue;
    const cx = z.x + z.w / 2;
    const cy = z.y + z.h / 2;
    const dist = Math.hypot(cx - x, cy - y);
    if (dist < radius) {
      const dmg = Math.floor(80 * (1 - dist / radius));
      damageZombie(z, dmg, x < cx ? 5 : -5);
    }
  }
  // damage player
  const pd = Math.hypot(player.x + 14 - x, player.y + 28 - y);
  if (pd < radius * 0.6 && player.invincible <= 0) {
    hurtPlayer(Math.floor(25 * (1 - pd / radius)));
  }
}

// ── Damage ───────────────────────────────────────────────────
function damageZombie(z, amount, knockX = 0) {
  z.hp -= amount;
  if (knockX) z.vx = knockX;
  bloodSplatters.push({ x: z.x + z.w / 2, y: z.y + z.h / 3, life: 40 });

  if (z.hp <= 0 && !z.dead) {
    z.dead = true;
    z.deathTimer = 110;
    // Snap sprite-based enemies to ground so dead sprite renders flat at ground level
    if (z.type === 'dog' || (z.type === 'mega' && z.bossLevel >= 2)) {
      z.y = GROUND_Y - z.h; z.vy = 0; z.vx = 0; z.onGround = true;
    }
    // Stop all dog bark/pant audio on death
    if (z.type === 'dog' && z.barkAudios) {
      z.barkAudios.forEach(a => { a.pause(); a.currentTime = 0; });
    }
    score += z.type === 'mega' ? 2000 : z.type === 'charBoss' ? 1500 : z.type === 'big' ? 500 : 100;
    updateScoreUI();
    if (Math.random() < 0.3) spawnAmmoPickup(z.x, z.y + z.h - 14);
    if (!healthDroppedThisLevel && z.type !== 'mega' && z.type !== 'charBoss' && Math.random() < 0.25) {
      ammoPickups.push({ x: z.x, y: z.y + z.h - 14, w: 20, h: 14, anim: 0, isHealth: true });
      healthDroppedThisLevel = true;
    }
    if (z.type === 'charBoss') {
      spawnWeaponPickup(z.x + z.w / 2 - 22, z.y + z.h - 16, 'rocket');
      spawnAmmoPickup(z.x, z.y + z.h - 14);
      bossRoundActive = false;
    } else if (z.type === 'mega') {
      // Mega boss always drops rocket + double ammo
      spawnWeaponPickup(z.x + z.w / 2 - 22, z.y + z.h - 16, 'rocket');
      spawnAmmoPickup(z.x + z.w / 2 - 14, z.y + z.h - 14);
      spawnAmmoPickup(z.x + z.w / 2 + 20, z.y + z.h - 14);
      bossRoundActive = false;
    } else if (z.type === 'big') {
      const drop = level >= 3 && Math.random() < 0.35 ? 'rocket' : characterWeapon();
      spawnWeaponPickup(z.x + z.w / 2 - 22, z.y + z.h - 16, drop);
    } else if (z.type === 'gunner') {
      spawnWeaponPickup(z.x + z.w / 2 - 22, z.y + z.h - 16, characterWeapon());
    } else if (Math.random() < 0.05) {
      const drop = level >= 4 && Math.random() < 0.08 ? 'rocket' : characterWeapon();
      spawnWeaponPickup(z.x + z.w / 2 - 22, z.y + z.h - 16, drop);
    }
    particles.push(...createSparks(z.x + z.w / 2, z.y + z.h / 2, '#880000', 8));
  }
}

function hurtPlayer(amount) {
  if (godMode) return;
  if (player.invincible > 0) return;
  player.hp = Math.max(0, player.hp - amount);
  player.invincible = 90;
  updateHealthUI();
  if (player.hp <= 0) triggerDeath();
}

// Triggered when hp hits 0 — plays the death animation, then respawns or ends the game.
function triggerDeath() {
  if (gameState === 'dying' || gameState === 'dead') return;
  gameState = 'dying';
  stopMGLoop();
  player.deathTimer = 100;     // long enough for Ziggy (64 ticks) and Viper (90 ticks) anims to finish
  // Reset anim state so the die animation plays from frame 0
  playerAnim.frame = 0;
  playerAnim.timer = 0;
}

function respawnOrGameOver() {
  neverDied = false;
  player.lives--;
  updateLivesUI();
  if (player.lives <= 0) {
    gameState = 'dead';
    introClip.pause();
    sfxBonusChant.pause(); sfxBonusChant.currentTime = 0;
    PLAYLIST.forEach(a => { a.pause(); a.currentTime = 0; });
    sfxGameOver.currentTime = 0;
    sfxGameOver.play().catch(() => {});
    showOverlay('GAME OVER', `Score: ${score}`, 'TRY AGAIN');
    return;
  }
  // Respawn — heal, brief invincibility, reset position
  player.hp = player.maxHp;
  player.invincible = 180;
  player.deathTimer = 0;
  playerAnim.frame = 0;
  playerAnim.timer = 0;
  resetPlayerPos();
  updateHealthUI();
  triggerSpawnLightning(player.x + player.w / 2, player.y + player.h);
  gameState = 'playing';
}

// ── Particle helpers ─────────────────────────────────────────
function createSparks(x, y, color, count) {
  // Halve particle count on mobile so the per-frame update loop and draw don't blow up
  // during heavy combat (muzzle flash at 20 rounds/sec + kills + explosions).
  return Array.from({ length: count }, () => ({
    x, y,
    vx: (Math.random() - 0.5) * 8,
    vy: (Math.random() - 0.5) * 8 - 2,
    life: 20 + Math.random() * 20,
    color,
    size: 2 + Math.random() * 3,
  }));
}

// Thor-style spawn bolt: arches across the sky to (worldX, worldY)
// with branched jagged stroke, a bright screen flash and a shower of sparks at impact.
function triggerSpawnLightning(worldX, worldY) {
  const SEGMENTS = 16;
  // Arc bow: bolt starts well off to one side and curves into the impact point.
  const sideDir = Math.random() < 0.5 ? -1 : 1;
  const arcOffset = (140 + Math.random() * 100) * sideDir;
  const points = [];
  for (let i = 0; i <= SEGMENTS; i++) {
    const t = i / SEGMENTS;
    const sy = t * worldY;
    // Quadratic ease so the arc starts wide and tightens onto the target X.
    const arcX = arcOffset * (1 - t) * (1 - t);
    const wobble = (i === 0 || i === SEGMENTS) ? 0 : (Math.random() - 0.5) * 46;
    points.push({ x: worldX + arcX + wobble, y: sy });
  }
  // Branches forked off the main arc
  const branches = [];
  for (let b = 0; b < 3; b++) {
    const startIdx = 4 + Math.floor(Math.random() * 8);
    const branch = [{ x: points[startIdx].x, y: points[startIdx].y }];
    let bx = points[startIdx].x, by = points[startIdx].y;
    const dir = Math.random() < 0.5 ? -1 : 1;
    const len = 3 + Math.floor(Math.random() * 4);
    for (let j = 0; j < len; j++) {
      bx += dir * (18 + Math.random() * 28);
      by += 18 + Math.random() * 20;
      branch.push({ x: bx, y: by });
    }
    branches.push(branch);
  }
  lightningBolts.push({
    points, branches,
    impactX: worldX, impactY: worldY,
    life: 32, maxLife: 32,
  });
  particles.push(...createSparks(worldX, worldY, '#ffffff', 22));
  particles.push(...createSparks(worldX, worldY, '#aaccff', 16));
  // "Come here, scum" voice line — clone-and-play so overlapping spawns don't clip each other.
  const s = sfxSpawnLine.cloneNode();
  s.volume = sfxSpawnLine.volume;
  s.play().catch(() => {});
}

// ── UI updates ───────────────────────────────────────────────
function updateHealthUI() {
  document.getElementById('health-fill').style.width = `${player.hp / player.maxHp * 100}%`;
}

function updateAmmoUI() {
  const el = document.getElementById('ammo-count');
  if (player.weapon !== 'pistol') {
    const w = WEAPONS[player.weapon];
    el.textContent = `${w.name} ${player.heavyAmmo}`;
  } else {
    // Both characters have unlimited pistol ammo now.
    el.textContent = '∞';
  }
}

function updateScoreUI() {
  document.getElementById('score').textContent = score;
}

function updateLevelUI() {
  document.getElementById('level').textContent = level;
}

function updateLivesUI() {
  const el = document.getElementById('lives');
  if (el) el.textContent = player.lives;
}

function showOverlay(title, subtitle, btnText) {
  document.getElementById('overlay-title').textContent = title;
  document.getElementById('overlay-subtitle').textContent = subtitle;
  document.getElementById('start-btn').textContent = btnText;
  const isMenu = btnText === 'START GAME';
  document.getElementById('overlay-controls').style.display = isMenu ? 'block' : 'none';
  const cs = document.getElementById('char-select');
  if (cs) cs.style.display = isMenu ? 'block' : 'none';
  if (isMenu) renderCharPreviews();
  document.getElementById('screen-overlay').classList.remove('hidden');
}

// ── Character select ──────────────────────────────────────────
function setChar(which) {
  selectedChar = which;
  playerAnim.frame = 0;
  playerAnim.timer = 0;
  document.querySelectorAll('.char-card').forEach(c => c.classList.remove('selected'));
  const el = document.getElementById(`char-${which}`);
  if (el) el.classList.add('selected');
  updateAmmoUI();
}

function renderCharPreviews() {
  // Both previews are static <img> tags set in HTML — nothing to render here
}

document.getElementById('char-rambo')?.addEventListener('click', () => setChar('rambo'));
document.getElementById('char-viper')?.addEventListener('click', () => setChar('viper'));

function hideOverlay() {
  document.getElementById('screen-overlay').classList.add('hidden');
}

// ── Level transition ─────────────────────────────────────────
function nextLevel() {
  if (level >= LEVELS.length) {
    gameState = 'win';
    showOverlay('YOU WIN!', `Final Score: ${score}`, 'PLAY AGAIN');
    return;
  }
  level++;
  if (level === 5) startMusic(); // EDM keeps playing levels 1-4; switch to Confined5 only on level 5
  updateLevelUI();
  generatePlatforms();
  resetPlayerPos();
  // Level 5: play the banshee scream first, hold off on spawning zombies until it ends.
  if (level === 5) {
    pendingZombieSpawn = true;
    zombies = [];
    try { sfxBanshee.currentTime = 0; } catch (_) {}
    sfxBanshee.play().catch(() => {
      // Autoplay blocked or load failure — fall back to a fixed delay so play isn't stalled forever.
      setTimeout(() => {
        if (pendingZombieSpawn) { pendingZombieSpawn = false; spawnZombies(); }
      }, 4000);
    });
  } else {
    spawnZombies();
  }
  bullets = [];
  grenadeList = [];
  explosions = [];
  particles = [];
  bloodSplatters = [];
  ammoPickups = [];
  weaponPickups = [];
  slimeProjectiles = [];
  lightningBolts = [];
  player.ammo = 30;
  player.hp = player.maxHp;
  updateHealthUI();
  updateAmmoUI();
  triggerSpawnLightning(player.x + player.w / 2, player.y + player.h);
}

function resetPlayerPos() {
  player.x = 80;
  player.y = GROUND_Y - player.h;
  player.vx = 0;
  player.vy = 0;
  cameraX = 0;
}

// ── Input ────────────────────────────────────────────────────
let godMode = false;
function toggleGodMode() {
  godMode = !godMode;
  const el = document.getElementById('god-indicator');
  if (el) el.style.display = godMode ? 'inline' : 'none';
}

document.addEventListener('keydown', e => {
  keys[e.code] = true;
  if (e.code === 'KeyP') togglePause();
  if (e.code === 'KeyI') toggleGodMode();
  e.preventDefault();
});
document.addEventListener('keyup', e => {
  keys[e.code] = false;
});
let mouseDown = false;
// Block synthetic mouse events that touch devices fire after a tap — otherwise
// tapping anywhere on the canvas triggers shoot() in addition to the touch button.
// The preventDefault on touchstart suppresses the synthetic mousedown that would
// otherwise follow, so the mousedown handler below only fires for real mouse input.
canvas.addEventListener('touchstart', e => e.preventDefault(), { passive: false });
canvas.addEventListener('mousedown', e => {
  if (e.button === 0) {
    mouseDown = true;
    if (gameState === 'playing') shoot();
  }
});
const releaseMouse = e => { if (e.button === 0) mouseDown = false; };
document.addEventListener('mouseup', releaseMouse);
canvas.addEventListener('mouseleave', () => { mouseDown = false; });
canvas.addEventListener('contextmenu', e => e.preventDefault());

document.getElementById('pause-btn').addEventListener('click', () => togglePause());

// ── Touch controls ───────────────────────────────────────────
// Bind on-screen buttons to the same input state as the keyboard so the existing
// movement/shoot/jump logic works unchanged on mobile.
function bindTouchHold(elId, onDown, onUp) {
  const el = document.getElementById(elId);
  if (!el) return;
  const down = e => { e.preventDefault(); onDown(); };
  const up   = e => { e.preventDefault(); onUp(); };
  el.addEventListener('touchstart', down, { passive: false });
  el.addEventListener('touchend',   up,   { passive: false });
  el.addEventListener('touchcancel',up,   { passive: false });
  // Mouse fallback so the buttons also work on a desktop testing in DevTools
  el.addEventListener('mousedown',  down);
  el.addEventListener('mouseup',    up);
  el.addEventListener('mouseleave', up);
}
bindTouchHold('touch-left',
  () => { keys['ArrowLeft']  = true;  },
  () => { keys['ArrowLeft']  = false; });
bindTouchHold('touch-right',
  () => { keys['ArrowRight'] = true;  },
  () => { keys['ArrowRight'] = false; });
bindTouchHold('touch-jump',
  () => { keys['Space']      = true;  },
  () => { keys['Space']      = false; });
bindTouchHold('touch-shoot',
  () => { mouseDown = true; if (gameState === 'playing') shoot(); },
  () => { mouseDown = false; });

document.getElementById('start-btn').addEventListener('click', () => {
  initAudioCtx(); // browsers require a user gesture to create/resume AudioContext
  if (gameState === 'menu') {
    startGame(); // music already running from intro/playlist — don't reset it
  } else if (gameState === 'dead' || gameState === 'win') {
    startGame();
    startMusic(); // restart playlist from track 1 after game over / win
  } else if (gameState === 'levelup') {
    nextLevel();
    hideOverlay();
    gameState = 'playing';
  }
});

function startGame() {
  score = 0;
  level = 1;
  frameCount = 0;
  lastShot = 0;
  playerAnim.frame = 0;
  playerAnim.timer = 0;
  player.hp = player.maxHp;
  player.ammo = 30;
  player.weapon = 'pistol';
  player.heavyAmmo = 0;
  player.lives = 3;
  player.deathTimer = 0;
  player.invincible = 0;
  // Reset any lingering banshee state from a previous run.
  pendingZombieSpawn = false;
  try { sfxBanshee.pause(); sfxBanshee.currentTime = 0; } catch (_) {}
  // Level 1 is dog-free so players can get oriented before the dog mechanic shows up.
  const _lp = [2,3,4,5];
  for (let _i = _lp.length-1; _i > 0; _i--) { const _j = Math.floor(Math.random()*(_i+1)); [_lp[_i],_lp[_j]]=[_lp[_j],_lp[_i]]; }
  dogLevels = [_lp[0], _lp[1]];
  dogEventState = 'idle'; dogFogAlpha = 0; pendingDogEvent = false;
  updateHealthUI();
  updateAmmoUI();
  updateScoreUI();
  updateLevelUI();
  updateLivesUI();
  generatePlatforms();
  resetPlayerPos();
  bullets = [];
  grenadeList = [];
  explosions = [];
  particles = [];
  bloodSplatters = [];
  ammoPickups = [];
  weaponPickups = [];
  slimeProjectiles = [];
  lightningBolts = [];
  spawnQueue = [];
  spawnTimer = 0;
  spawnZombies();
  hideOverlay();
  gameState = 'playing';
  triggerSpawnLightning(player.x + player.w / 2, player.y + player.h);
}

// ── Update ───────────────────────────────────────────────────
function update() {
  // Death animation: let the die anim play out, then respawn or game over.
  if (gameState === 'dying') {
    frameCount++;
    player.deathTimer--;
    // Body falls to the ground if the player died mid-air — apply gravity & ground collision,
    // and dampen horizontal momentum so the corpse settles instead of sliding.
    player.vx *= 0.82;
    applyGravity(player);
    resolveGroundCollision(player);
    // Keep particles and slime fading naturally during the dying beat
    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i];
      p.x += p.vx; p.y += p.vy; p.vy += 0.2; p.life--;
      if (p.life <= 0) particles.splice(i, 1);
    }
    for (let i = bloodSplatters.length - 1; i >= 0; i--) {
      bloodSplatters[i].life--;
      if (bloodSplatters[i].life <= 0) bloodSplatters.splice(i, 1);
    }
    if (player.deathTimer <= 0) respawnOrGameOver();
    return;
  }
  if (gameState !== 'playing') return;
  frameCount++;
  if (bossAnnounceTimer > 0) bossAnnounceTimer--;

  // Player movement — locked while shooting or meleeing so the player has to commit to either firing or moving.
  player.isMoving = false;
  const actionLocked = player.isShooting || player.isMelee;
  if (actionLocked) {
    player.vx *= 0.4; // brake hard so existing momentum stops quickly
  } else if (keys['ArrowLeft'] || keys['KeyA']) {
    player.vx = -4.5;
    player.facing = -1;
    player.isMoving = true;
  } else if (keys['ArrowRight'] || keys['KeyD']) {
    player.vx = 4.5;
    player.facing = 1;
    player.isMoving = true;
  } else {
    player.vx *= 0.7;
  }

  // Full-auto weapons fire while the mouse is held; semi-auto (pistol) fires only on click.
  if (mouseDown && WEAPONS[player.weapon] && WEAPONS[player.weapon].auto) shoot();

  if ((keys['Space'] || keys['ArrowUp'] || keys['KeyW']) && player.onGround) {
    player.vy = -11;
    sfxJump.currentTime = 0;
    sfxJump.play().catch(() => {});
  }

  applyGravity(player);
  resolveGroundCollision(player);

  if (player.invincible > 0) player.invincible--;

  // Shoot timer
  if (player.shootTimer > 0) player.shootTimer--;
  else { player.isShooting = false; player.isMelee = false; }
  // Stop the looping MG-fire sample as soon as the player stops firing or switches off a full-auto.
  if (!player.isShooting || (player.weapon !== 'm16' && player.weapon !== 'm60')) {
    stopMGLoop();
  }

  // Animation
  player.animTimer++;
  if (player.animTimer > 8) {
    player.animTimer = 0;
    if (player.isMoving) player.anim = (player.anim + 1) % 4;
    else player.anim = 0;
  }

  // Camera
  const targetCameraX = player.x - canvas.width / 2 + player.w / 2;
  cameraX += (targetCameraX - cameraX) * 0.1;
  cameraX = Math.max(0, Math.min(WORLD_WIDTH - canvas.width, cameraX));

  // Portal: animate + collision (active during playing, between level 3 and 4)
  if (portal && portal.active) {
    portal.anim = (portal.anim + 0.04) % (Math.PI * 2);
    portalSearchTimer++;
    // Auto-skip to level 4 after ~20 seconds if player ignores the portal
    if (portalSearchTimer > 1200) {
      portal = null;
      level = 3;
      nextLevel();
    } else if (
      player.x < portal.x + portal.w && player.x + player.w > portal.x &&
      player.y < portal.y + portal.h && player.y + player.h > portal.y
    ) {
      enterHiddenLevel();
    }
  }

  // Animate health orbs
  for (const a of ammoPickups) { if (a.isHealth) a.anim = (a.anim + 0.05) % (Math.PI * 2); }

  // Bullets
  for (let i = bullets.length - 1; i >= 0; i--) {
    const b = bullets[i];
    b.x += b.vx;
    b.y += b.vy;
    b.life--;
    if (b.life <= 0) {
      if (b.isRocket) createExplosion(b.x, b.y, 200);
      bullets.splice(i, 1); continue;
    }

    // Enemy bullets hurt the player
    if (!b.fromPlayer) {
      if (
        b.x > player.x && b.x < player.x + player.w &&
        b.y > player.y && b.y < player.y + player.h
      ) {
        hurtPlayer(b.damage || 10);
        particles.push(...createSparks(b.x, b.y, '#22ff44', 4));
        bullets.splice(i, 1);
        continue;
      }
    }

    if (b.fromPlayer) {
      let hit = false;
      for (const z of zombies) {
        if (z.dead) continue;
        if (b.x > z.x && b.x < z.x + z.w && b.y > z.y && b.y < z.y + z.h) {
          if (b.isRocket) { createExplosion(b.x, b.y, 200); }
          else { damageZombie(z, b.damage != null ? b.damage : 20 + level * 2, b.vx > 0 ? 2 : -2); }
          hit = true;
          break;
        }
      }
      if (hit) { bullets.splice(i, 1); continue; }
    }

    // platform collision
    for (const p of basePlatforms) {
      if (b.x > p.x && b.x < p.x + p.w && b.y > p.y && b.y < p.y + p.h) {
        if (b.isRocket) createExplosion(b.x, b.y, 200);
        else particles.push(...createSparks(b.x, b.y, '#888', 3));
        bullets.splice(i, 1);
        break;
      }
    }
  }

  // Grenades
  for (let i = grenadeList.length - 1; i >= 0; i--) {
    const g = grenadeList[i];
    g.x += g.vx;
    g.vy += 0.4;
    g.y += g.vy;
    g.fuse--;
    g.life--;

    // bounce off ground
    if (g.y + 8 >= GROUND_Y) {
      g.y = GROUND_Y - 8;
      g.vy *= -0.5;
      g.vx *= 0.8;
    }

    if (g.fuse <= 0) {
      createExplosion(g.x, g.y, 120);
      grenadeList.splice(i, 1);
    }
  }

  // Slime projectiles (boss spit)
  for (let i = slimeProjectiles.length - 1; i >= 0; i--) {
    const s = slimeProjectiles[i];
    s.vy += 0.45;
    s.x += s.vx;
    s.y += s.vy;
    s.life--;

    // Player hit — circle vs. AABB so any contact (not just center-overlap) triggers it
    const nearestX = Math.max(player.x, Math.min(s.x, player.x + player.w));
    const nearestY = Math.max(player.y, Math.min(s.y, player.y + player.h));
    const ddx = s.x - nearestX;
    const ddy = s.y - nearestY;
    if (ddx * ddx + ddy * ddy <= s.r * s.r) {
      hurtPlayer(12);
      // Green splatter on impact
      for (let p = 0; p < 8; p++) {
        particles.push({
          x: s.x, y: s.y,
          vx: (Math.random() - 0.5) * 7,
          vy: (Math.random() - 0.5) * 6 - 1,
          life: 22 + Math.random() * 15,
          color: p % 2 ? '#5dff5d' : '#aaff88',
          size: 2 + Math.random() * 2.5,
        });
      }
      slimeProjectiles.splice(i, 1);
      continue;
    }

    // Ground splash
    if (s.y + s.r >= GROUND_Y) {
      for (let p = 0; p < 8; p++) {
        particles.push({
          x: s.x, y: GROUND_Y - 2,
          vx: (Math.random() - 0.5) * 5,
          vy: -1 - Math.random() * 3,
          life: 22 + Math.random() * 18,
          color: '#3aff5c',
          size: 2 + Math.random() * 2,
        });
      }
      slimeProjectiles.splice(i, 1);
      continue;
    }

    if (s.life <= 0) slimeProjectiles.splice(i, 1);
  }

  // Explosions
  for (let i = explosions.length - 1; i >= 0; i--) {
    explosions[i].life--;
    if (explosions[i].life <= 0) explosions.splice(i, 1);
  }

  // Trickle queued zombies in one at a time
  if (spawnQueue.length > 0) {
    spawnTimer++;
    if (spawnTimer >= SPAWN_INTERVAL) {
      spawnTimer = 0;
      const e = spawnQueue.shift();
      const nz = inHiddenLevel ? createZombieEx(e.x, e.speed, e.hpMult) : createZombie(e.x, e.speed);
      zombies.push(nz);
      // Dirt burst at spawn point
      for (let d = 0; d < 10; d++) {
        particles.push({
          x: nz.x + nz.w / 2 + (Math.random() - 0.5) * nz.w,
          y: GROUND_Y,
          vx: (Math.random() - 0.5) * 5,
          vy: -(Math.random() * 4 + 1),
          life: 25 + Math.random() * 20,
          color: '#5a3a10',
          size: 3 + Math.random() * 3,
        });
      }
    }
  }

  // ── Dog event state machine ────────────────────────────────
  if (dogLevels.includes(level) && !inHiddenLevel) {
    if (dogEventState === 'idle' && spawnQueue.length === 0 && !bossSpawnedThisLevel) {
      dogEventState = 'freeze';
      dogEventTimer = 200;
      pendingDogEvent = true;
      for (const z of zombies) { if (z.type !== 'dog') z.frozen = true; }
      sfxDemonLaugh.currentTime = 0;
      sfxDemonLaugh.play().catch(() => {});
    } else if (dogEventState === 'freeze') {
      dogFogAlpha = Math.min(0.75, dogFogAlpha + 0.01);
      dogEventTimer--;
      if (dogEventTimer <= 0) {
        // Build staggered spawn queue — 10-12 dogs, ~1.5-3 s gaps between each
        let _t = 0;
        dogSpawnQueue = [];
        const _dogCount = 10 + Math.floor(Math.random() * 3); // 10-12
        for (let _d = 0; _d < _dogCount; _d++) {
          dogSpawnQueue.push({ timer: _t });
          _t += 90 + Math.floor(Math.random() * 90); // 1.5-3 s
        }
        for (const z of zombies) z.frozen = false;
        dogEventState = 'active';
        pendingDogEvent = false;
      }
    } else if (dogEventState === 'active') {
      // Tick staggered spawn queue
      for (let _qi = dogSpawnQueue.length - 1; _qi >= 0; _qi--) {
        dogSpawnQueue[_qi].timer--;
        if (dogSpawnQueue[_qi].timer <= 0) {
          dogSpawnQueue.splice(_qi, 1);
          const _dx = randomSpawnX();
          const _dog = createDogZombie(_dx);
          zombies.push(_dog);
          // Electric bolt strike
          const _bx = _dx + _dog.w / 2;
          const SEGS = 14;
          const _pts = [];
          for (let _s = 0; _s <= SEGS; _s++) {
            const _t2 = _s / SEGS;
            const _wo = (_s === 0 || _s === SEGS) ? 0 : (Math.random() - 0.5) * 50;
            _pts.push({ x: _bx + _wo, y: _t2 * GROUND_Y });
          }
          const _brs = [];
          for (let _b = 0; _b < 3; _b++) {
            const _si = 3 + Math.floor(Math.random() * 7);
            const _br = [{ x: _pts[_si].x, y: _pts[_si].y }];
            let _bxb = _pts[_si].x, _byb = _pts[_si].y;
            const _bd = Math.random() < 0.5 ? -1 : 1;
            for (let _j = 0; _j < 4; _j++) {
              _bxb += _bd * (16 + Math.random() * 24); _byb += 16 + Math.random() * 18;
              _br.push({ x: _bxb, y: _byb });
            }
            _brs.push(_br);
          }
          lightningBolts.push({ points: _pts, branches: _brs, impactX: _bx, impactY: GROUND_Y, life: 28, maxLife: 28 });
          particles.push(...createSparks(_bx, GROUND_Y, '#00eeff', 20));
          particles.push(...createSparks(_bx, GROUND_Y, '#ffffff', 12));
          const _se = sfxDogSpawn.cloneNode(); _se.volume = sfxDogSpawn.volume; _se.play().catch(() => {});
        }
      }
      if (dogSpawnQueue.length === 0 && !zombies.some(z => z.type === 'dog' && !z.dead)) dogEventState = 'dissipating';
    } else if (dogEventState === 'dissipating') {
      dogFogAlpha = Math.max(0, dogFogAlpha - 0.007);
      if (dogFogAlpha <= 0) dogEventState = 'done';
    }
  }

  // Rise animation for newly spawned zombies
  for (const z of zombies) {
    if (!z.rising) continue;
    z.y -= z.riseSpeed;
    if (z.y <= GROUND_Y - z.h) {
      z.y = GROUND_Y - z.h;
      z.rising = false;
      if (z.type === 'mega' && z.bossLevel === 5 && !z.demonAnnounced) {
        z.demonAnnounced = true;
        sfxDemonLaugh.currentTime = 0;
        sfxDemonLaugh.play().catch(() => {});
      }
    }
  }

  // Zombies AI
  for (let i = zombies.length - 1; i >= 0; i--) {
    const z = zombies[i];
    if (z.dead) {
      z.state = 'die';
      z.vx *= 0.82;
      applyGravity(z);
      resolveGroundCollision(z);
      // Dogs and sprite bosses are pinned to the ground when dead
      if (z.type === 'dog' || (z.type === 'mega' && z.bossLevel >= 2)) {
        z.y = GROUND_Y - z.h; z.vy = 0;
      }
      z.stateTimer++;
      const dieCfg = ZS.anim.die;
      if (z.stateTimer >= dieCfg.speed) {
        z.stateTimer = 0;
        z.stateFrame = Math.min(z.stateFrame + 1, dieCfg.frames - 1);
      }
      z.deathTimer--;
      if (z.deathTimer <= 0) zombies.splice(i, 1);
      continue;
    }

    // Frozen while emerging — skip all physics and AI until fully above ground
    if (z.rising) continue;

    // Frozen during dog event intro — stop but stay physical
    if (z.frozen) { applyGravity(z); resolveGroundCollision(z); continue; }

    const dx = player.x + 14 - (z.x + z.w / 2);
    const dxAbs = Math.abs(dx);
    const dir = dx > 0 ? 1 : -1;

    if (z.type === 'gunner') {
      // Gunner keeps a preferred distance: back off if too close, creep in if too far
      const PREF_MIN = 180, PREF_MAX = 420;
      if (dxAbs < PREF_MIN)       z.vx = -dir * z.speed;   // too close — retreat
      else if (dxAbs > PREF_MAX)  z.vx =  dir * z.speed;   // too far  — approach
      else                         z.vx = 0;                 // sweet spot — stand still

      z.shootCooldown--;
      if (dxAbs > 80 && dxAbs < 500 && Math.abs(player.y - z.y) < 120 && z.shootCooldown <= 0) {
        bullets.push({
          x: z.x + z.w / 2 + dir * 14,
          y: z.y + z.h * 0.3,
          vx: dir * 7,
          vy: (player.y - z.y) / Math.max(1, dxAbs) * 7,
          life: 90,
          fromPlayer: false,
          damage: 8 + level * 2,
          color: '#22ff44',
          isRocket: false,
        });
        z.shootCooldown = 90 + Math.floor(Math.random() * 80);
        z.state = 'gunshoot';
        z.stateFrame = 0;
        z.stateTimer = 0;
      }

      // State: hold gunshoot until anim finishes, then walk/idle
      if (z.state === 'gunshoot') {
        z.stateTimer++;
        if (z.stateTimer >= ZS.anim.gunshoot.speed) {
          z.stateTimer = 0;
          z.stateFrame++;
          if (z.stateFrame >= ZS.anim.gunshoot.frames) {
            z.state = 'walk';
            z.stateFrame = 0;
          }
        }
      } else {
        z.state = dxAbs < 200 ? 'run' : 'walk';
        z.stateTimer++;
        const aCfg = ZS.anim[z.state] || ZS.anim.walk;
        if (z.stateTimer >= aCfg.speed) { z.stateTimer = 0; z.stateFrame = (z.stateFrame + 1) % aCfg.frames; }
      }
    } else if (z.type === 'charBoss') {
      if (z.megaState === 'evade') {
        if (dxAbs < z.prefMin)       z.vx = -dir * z.speed * 1.5;
        else if (dxAbs > z.prefMax)  z.vx =  dir * z.speed * 0.8;
        else                          z.vx *= 0.82;
        z.hopTimer--;
        if (z.hopTimer <= 0 && z.onGround) { z.vy = z.hopVy; z.hopTimer = 60 + Math.floor(Math.random() * 90); }
        z.attackDelay--;
        if (z.attackDelay <= 0 && z.onGround && dxAbs < 560) {
          z.megaState = 'lunge'; z.attackDir = dir;
          z.vx = dir * z.pounceVx; z.vy = z.pounceVy;
          z.hasHitOnLunge = false; z.lungeTimer = z.lungeStart;
        }
        z.shootCooldown--;
        if (z.shootCooldown <= 0 && dxAbs > 50 && dxAbs < 550 && Math.abs(player.y - z.y) < 90) {
          // Rapid burst: fires 3 shots with tight cooldown, then longer pause
          const spread = (z.burstCount % 3) * 0.15 - 0.15;
          bullets.push({ x: z.x + z.w / 2 + dir * 14, y: z.y + z.h * 0.3,
            vx: dir * 10 + spread, vy: (player.y - z.y) / Math.max(1, dxAbs) * 9 + spread,
            life: 100, fromPlayer: false, damage: 15, color: '#ff44ff', isRocket: false });
          z.burstCount = (z.burstCount || 0) + 1;
          z.shootCooldown = z.burstCount % 3 === 0 ? 55 + Math.floor(Math.random() * 30) : 10;
        }
        if (z.state !== 'attack') z.state = dxAbs < z.prefMin ? 'run' : 'walk';
      } else if (z.megaState === 'lunge') {
        z.lungeTimer--;
        z.vx = z.attackDir * (z.onGround ? z.pounceVx * 0.65 : z.pounceVx);
        z.state = 'run';
        if (!z.hasHitOnLunge && dxAbs < 50 && Math.abs(player.y - z.y) < 80) {
          hurtPlayer(z.meleeDmg); z.hasHitOnLunge = true;
          z.state = 'attack'; z.stateFrame = 0; z.stateTimer = 0;
        }
        if ((z.onGround && z.lungeTimer < z.lungeStart - 15) || z.lungeTimer <= 0) {
          z.megaState = 'retreat'; z.vx = -z.attackDir * z.retreatVx;
          z.vy = z.onGround ? z.pounceVy * 0.85 : 0; z.retreatTimer = 65;
        }
      } else if (z.megaState === 'retreat') {
        z.retreatTimer--;
        z.vx = -z.attackDir * (z.onGround ? z.retreatVx * 0.5 : z.retreatVx);
        if (z.state !== 'attack') z.state = 'walk';
        if ((z.onGround && z.retreatTimer < 50) || z.retreatTimer <= 0) {
          z.megaState = 'evade';
          z.attackDelay = z.attackDelayMin + Math.floor(Math.random() * z.attackDelayRand);
          z.vx = 0;
        }
      }
      if (z.contactCooldown > 0) z.contactCooldown--;
      if (z.contactCooldown <= 0 &&
          player.x < z.x + z.w && player.x + player.w > z.x &&
          player.y < z.y + z.h && player.y + player.h > z.y) {
        hurtPlayer(Math.ceil(z.meleeDmg * 0.5));
        z.contactCooldown = 50;
      }
      z.stateTimer++;
      const cbCfg = ZS.anim[z.state] || ZS.anim.walk;
      if (z.stateTimer >= cbCfg.speed) {
        z.stateTimer = 0; z.stateFrame++;
        if (z.state === 'attack' && z.stateFrame >= cbCfg.frames) { z.state = 'walk'; z.stateFrame = 0; }
        else z.stateFrame %= cbCfg.frames;
      }

    } else if (z.type === 'mega') {
      if (z.megaState === 'evade') {
        if (dxAbs < z.prefMin) {
          z.vx = -dir * z.speed * 1.6;
        } else if (dxAbs > z.prefMax) {
          z.vx = dir * z.speed * 0.7;
        } else {
          z.vx *= 0.82;
        }
        z.hopTimer--;
        if (z.hopTimer <= 0 && z.onGround) {
          z.vy = z.hopVy;
          z.hopTimer = 85 + Math.floor(Math.random() * 100);
        }
        z.attackDelay--;
        if (z.attackDelay <= 0 && z.onGround && dxAbs < 640) {
          z.megaState = 'lunge';
          z.attackDir = dir;
          z.vx = dir * z.pounceVx;
          z.vy = z.pounceVy;
          z.hasHitOnLunge = false;
          z.lungeTimer = z.lungeStart;
        }
        if (z.state !== 'attack') z.state = dxAbs < z.prefMin ? 'run' : 'walk';

      } else if (z.megaState === 'lunge') {
        z.lungeTimer--;
        z.vx = z.attackDir * (z.onGround ? z.pounceVx * 0.65 : z.pounceVx);
        z.state = 'run';
        if (!z.hasHitOnLunge && dxAbs < 72 && Math.abs(player.y - z.y) < 100) {
          hurtPlayer(z.meleeDmg);
          z.hasHitOnLunge = true;
          z.state = 'attack';
          z.stateFrame = 0;
          z.stateTimer = 0;
        }
        if ((z.onGround && z.lungeTimer < z.lungeStart - 15) || z.lungeTimer <= 0) {
          z.megaState = 'retreat';
          z.vx = -z.attackDir * z.retreatVx;
          z.vy = z.onGround ? z.pounceVy * 0.9 : 0;
          z.retreatTimer = 70;
        }

      } else if (z.megaState === 'retreat') {
        z.retreatTimer--;
        z.vx = -z.attackDir * (z.onGround ? z.retreatVx * 0.55 : z.retreatVx);
        if (z.state !== 'attack') z.state = 'walk';
        if ((z.onGround && z.retreatTimer < 55) || z.retreatTimer <= 0) {
          z.megaState = 'evade';
          z.attackDelay = z.attackDelayMin + Math.floor(Math.random() * z.attackDelayRand);
          z.vx = 0;
        }
      }

      // Contact damage — fires any time the player overlaps the boss hitbox
      if (z.contactCooldown > 0) z.contactCooldown--;
      if (z.contactCooldown <= 0 &&
          player.x < z.x + z.w && player.x + player.w > z.x &&
          player.y < z.y + z.h && player.y + player.h > z.y) {
        hurtPlayer(Math.ceil(z.meleeDmg * 0.6));
        z.contactCooldown = 50;
      }

      // Animate
      z.stateTimer++;
      const mCfg = ZS.anim[z.state] || ZS.anim.walk;
      if (z.stateTimer >= mCfg.speed) {
        z.stateTimer = 0;
        z.stateFrame++;
        if (z.state === 'attack' && z.stateFrame >= mCfg.frames) {
          z.state = 'walk';
          z.stateFrame = 0;
        } else {
          z.stateFrame %= mCfg.frames;
        }
      }

    } else if (z.type === 'dog') {
      if (z.dogState === 'evade') {
        // Orbit player at safe distance — back off if too close, creep in if too far
        if (dxAbs < 200)      z.vx = -dir * z.speed * 1.5;
        else if (dxAbs > 380) z.vx =  dir * z.speed * 0.7;
        else                   z.vx *= 0.78;
        // Occasional jittery hop while waiting
        if (z.jumpTimer > 0) z.jumpTimer--;
        if (z.jumpTimer <= 0 && z.onGround) {
          z.vy = -(5 + Math.random() * 3);
          z.jumpTimer = 90 + Math.floor(Math.random() * 120);
        }
        z.dogAttackDelay--;
        if (z.dogAttackDelay <= 0 && z.onGround && dxAbs < 480) {
          z.dogState = 'lunge';
          z.vx = dir * 10; z.vy = -7;
          z.dogHasHit = false; z.dogLungeTimer = 35;
        }
        z.state = 'walk';
      } else if (z.dogState === 'lunge') {
        z.dogLungeTimer--;
        z.vx = dir * 10;
        if (!z.dogHasHit && dxAbs < 52 && Math.abs(player.y - z.y) < 58) {
          hurtPlayer(14); z.dogHasHit = true;
          z.state = 'attack'; z.stateFrame = 0; z.stateTimer = 0;
          const _sfx = sfxDogAttack.cloneNode(); _sfx.volume = sfxDogAttack.volume; _sfx.play().catch(()=>{});
        }
        // After landing or timer out — spring back hard
        if ((z.onGround && z.dogLungeTimer < 22) || z.dogLungeTimer <= 0) {
          z.dogState = 'retreat';
          z.vx = -dir * 8; z.vy = -9;
          z.dogRetreatTimer = 65;
        }
      } else if (z.dogState === 'retreat') {
        z.dogRetreatTimer--;
        z.vx = -dir * (z.onGround ? 5.5 : 8);
        if (z.dogRetreatTimer <= 0 || (z.onGround && z.dogRetreatTimer < 45)) {
          z.dogState = 'evade';
          z.dogAttackDelay = 70 + Math.floor(Math.random() * 90);
          z.vx = 0;
        }
        z.state = 'walk';
      }
      // Walk animation
      z.dogWalkFrameTimer++;
      if (z.dogWalkFrameTimer >= 7) { z.dogWalkFrameTimer = 0; z.dogWalkFrame = (z.dogWalkFrame+1)%3; }
      // Bark sounds — only while evading, not mid-lunge
      z.dogWalkSfxTimer--;
      if (z.dogWalkSfxTimer <= 0 && z.dogState === 'evade') {
        const _sw = sfxDogWalk[z.dogWalkSfxAlt%2].cloneNode(); _sw.volume = sfxDogWalk[0].volume; _sw.play().catch(()=>{});
        if (!z.barkAudios) z.barkAudios = [];
        z.barkAudios.push(_sw);
        if (z.barkAudios.length > 4) z.barkAudios.shift();
        z.dogWalkSfxAlt++; z.dogWalkSfxTimer = 110 + Math.floor(Math.random()*80);
      }

    } else {
      // Post-attack retreat — jump backward away from the player
      if (z.retreatTimer > 0) {
        z.retreatTimer--;
        z.vx = -dir * (z.type === 'big' ? 4.5 : 3.5);
        if (z.state !== 'attack') z.state = 'walk';
      } else {
        // Separation: don't bunch up. If another zombie is within personal space,
        // push horizontally away.
        let separation = 0;
        const PERSONAL_SPACE = 46;
        const myCx = z.x + z.w / 2;
        for (const other of zombies) {
          if (other === z || other.dead) continue;
          const ddx = myCx - (other.x + other.w / 2);
          const ddy = Math.abs((z.y + z.h / 2) - (other.y + other.h / 2));
          if (ddy > 70) continue;       // ignore zombies on different platforms
          const dist = Math.abs(ddx);
          if (dist > 0 && dist < PERSONAL_SPACE) {
            // Stronger push when closer; sign keeps you moving away from the other zombie
            separation += Math.sign(ddx || (Math.random() - 0.5)) * (1 - dist / PERSONAL_SPACE) * 2.6;
          }
        }
        z.vx = dir * z.speed + separation;

        // Random hops — staggered timers prevent synchronized jumping
        if (z.jumpTimer > 0) z.jumpTimer--;
        if (z.jumpTimer <= 0 && z.onGround) {
          z.vy = z.type === 'big' ? -(8 + Math.random() * 3) : -(5 + Math.random() * 3);
          z.jumpTimer = 80 + Math.floor(Math.random() * 140);
        }

        // If the separation force is overcoming forward intent, the zombie is being
        // pushed back — show walk anim instead of run so the back-up reads visually.
        const beingPushedBack = Math.sign(separation) === -Math.sign(dir) && Math.abs(separation) > z.speed * 0.8;

        // Sprite state machine (non-gunner)
        if (z.state !== 'attack') {
          z.state = beingPushedBack ? 'walk' : (dxAbs < 200 ? 'run' : 'walk');
        }
        z.stateTimer++;
        const animCfg = ZS.anim[z.state] || ZS.anim.walk;
        if (z.stateTimer >= animCfg.speed) {
          z.stateTimer = 0;
          z.stateFrame++;
          if (z.state === 'attack' && z.stateFrame >= animCfg.frames) {
            z.state = 'walk';
            z.stateFrame = 0;
          } else {
            z.stateFrame %= animCfg.frames;
          }
        }

        z.attackCooldown--;
        if (dxAbs < 30 && Math.abs(player.y - z.y) < 60 && z.attackCooldown <= 0) {
          hurtPlayer(z.type === 'big' ? 15 : 8);
          z.attackCooldown = 60;
          z.state = 'attack';
          z.stateFrame = 0;
          z.stateTimer = 0;
          // Jump backward after striking
          z.vy = z.type === 'big' ? -(8 + Math.random() * 3) : -(6 + Math.random() * 3);
          z.retreatTimer = 55;
        }
      }
    }

    applyGravity(z);
    resolveGroundCollision(z);

    // Boss-only ranged spit
    if (z.type === 'big') {
      z.spitCooldown--;
      if (z.spitCooldown <= 0 && dxAbs > 90 && dxAbs < 560) {
        // Aim a parabolic arc at the player's current position.
        const sx = z.x + z.w / 2;
        const sy = z.y + z.h * 0.22;
        const px = player.x + player.w / 2;
        const py = player.y + player.h / 2;
        const ddx = px - sx;
        const g = 0.45; // matches the gravity applied to slime each tick
        // Flight time scales with horizontal distance — keeps the arc readable up close and far away.
        const T = Math.max(30, Math.min(80, Math.abs(ddx) / 6 + 28));
        const vx = ddx / T + (Math.random() - 0.5) * 0.6;
        const vy = (py - sy) / T - 0.5 * g * T;
        slimeProjectiles.push({
          x: sx, y: sy,
          vx, vy,
          r: 9,
          life: 240,
        });
        z.spitCooldown = 95 + Math.floor(Math.random() * 80);
      }
    }

    // Demon Boss: periodic walking growl
    if (z.type === 'mega' && z.bossLevel === 5 && !z.dead) {
      z.demonWalkTimer--;
      if (z.demonWalkTimer <= 0 && z.megaState === 'evade') {
        sfxDemonGrowl.currentTime = 0;
        sfxDemonGrowl.play().catch(() => {});
        z.demonWalkTimer = 280 + Math.floor(Math.random() * 180);
      }
      // Walk frame cycling for 3-frame walk animation
      z.demonWalkFrameTimer++;
      if (z.demonWalkFrameTimer >= 10) {
        z.demonWalkFrameTimer = 0;
        z.demonWalkFrame = (z.demonWalkFrame + 1) % 3;
      }
    }

    // Mega boss spit spread (disabled on L1; orb count and rate scale per level)
    if (z.type === 'mega' && z.spitEnabled) {
      z.spitCooldown--;
      if (z.spitCooldown <= 0 && dxAbs < 680 && z.megaState === 'evade') {
        const sx = z.x + z.w / 2;
        const sy = z.y + z.h * 0.2;
        const n = z.spitOrbs;
        for (let i = 0; i < n; i++) {
          // Spread the orbs evenly: centre orb goes straight, outer ones fan left/right
          const k = n > 1 ? (i / (n - 1) - 0.5) * 2 : 0; // range -1..1
          slimeProjectiles.push({
            x: sx, y: sy,
            vx: dir * (3.5 + Math.abs(k) * 1.6) + k * 2.2,
            vy: -(4 + Math.random() * 3),
            r: 11 + Math.floor(n / 2),
            life: 300,
            isDemon: z.bossLevel === 5,
          });
        }
        z.spitCooldown = z.spitCooldownBase + Math.floor(Math.random() * 60);
      }
    }

    // Per-zombie groan — only living zombies reach this point (dead ones early-continue above).
    // Level-5 demon boss has its own roar; skip the generic zombie groans for it.
    const isLevel5Demon = z.type === 'mega' && z.bossLevel === 5;
    if (!isLevel5Demon && frameCount >= z.nextGroan) {
      const distAbs = Math.abs(dx);
      if (distAbs < 1100) {
        // Closer zombies are louder; per-clip cap is enforced inside playZombieGroan.
        const vol = 0.28 * (1 - distAbs / 1100) + 0.05;
        playZombieGroan(vol);
      }
      // Even out-of-range zombies reschedule, so they don't fire instantly when you approach.
      z.nextGroan = frameCount + 240 + Math.floor(Math.random() * 360);
    }
  }

  // Ammo pickups
  for (let i = ammoPickups.length - 1; i >= 0; i--) {
    const a = ammoPickups[i];
    a.anim = (a.anim + 0.05) % (Math.PI * 2);
    if (
      player.x < a.x + a.w && player.x + player.w > a.x &&
      player.y < a.y + a.h && player.y + player.h > a.y
    ) {
      if (a.isHealth) {
        player.hp = Math.min(player.maxHp, player.hp + 30);
        updateHealthUI();
      } else {
        player.ammo = Math.min(player.ammo + 15, 99);
        updateAmmoUI();
      }
      ammoPickups.splice(i, 1);
      continue;
    }
  }

  // Weapon pickups
  for (let i = weaponPickups.length - 1; i >= 0; i--) {
    const wp = weaponPickups[i];
    wp.anim = (wp.anim + 0.06) % (Math.PI * 2);
    if (
      player.x < wp.x + wp.w && player.x + player.w > wp.x &&
      player.y < wp.y + wp.h && player.y + player.h > wp.y
    ) {
      const add = HEAVY_AMMO_ON_PICKUP[wp.weapon] || 60;
      // Stacking the same weapon adds ammo; a different weapon replaces it.
      if (player.weapon === wp.weapon) {
        player.heavyAmmo = Math.min(player.heavyAmmo + add, HEAVY_AMMO_MAX);
      } else {
        player.weapon = wp.weapon;
        player.heavyAmmo = add;
      }
      updateAmmoUI();
      weaponPickups.splice(i, 1);
      continue;
    }
  }

  // Particles
  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i];
    p.x += p.vx;
    p.y += p.vy;
    p.vy += 0.2;
    p.life--;
    if (p.life <= 0) particles.splice(i, 1);
  }

  // Blood splatters
  for (let i = bloodSplatters.length - 1; i >= 0; i--) {
    bloodSplatters[i].life--;
    if (bloodSplatters[i].life <= 0) bloodSplatters.splice(i, 1);
  }

  // Check level clear (only during active play — not while player is searching for portal)
  if (gameState === 'playing' && !pendingZombieSpawn && !pendingDogEvent && spawnQueue.length === 0 && zombies.length === 0) {
    if (inHiddenLevel) {
      if (!bossSpawnedThisLevel) {
        bossSpawnedThisLevel = true;
        spawnCharBoss();
      } else {
        inHiddenLevel = false;
        // CONTINUE → nextLevel() which does level++; we want level 4 next, so set level to 3 here.
        level = 3;
        gameState = 'levelup';
        startMusic();
        showOverlay('SECRET LEVEL CLEAR!', 'Score: ' + score + ' — Returning to level 4...', 'CONTINUE');
      }
    } else if (!bossSpawnedThisLevel) {
      bossSpawnedThisLevel = true;
      spawnMegaBoss();
    } else {
      if (level >= LEVELS.length) {
        gameState = 'win';
        showOverlay('YOU WIN!', 'Final Score: ' + score, 'PLAY AGAIN');
      } else if (level === 3 && neverDied && !portalSpawned) {
        spawnPortalScene();
      } else if (!(portal && portal.active)) {
        gameState = 'levelup';
        showOverlay('LEVEL ' + level + ' CLEAR!', 'Score: ' + score + ' — Get ready!', 'NEXT LEVEL');
      }
    }
  }
}

// ── Draw helpers ─────────────────────────────────────────────
// ── Deterministic hash for background variation ───────────────
function bh(n) { return ((n * 2654435761) >>> 0) / 4294967295; }

// Parallax tile helper: draws N elements tiled across the world
function pxItems(count, spacing, parallax, drawFn) {
  const total = count * spacing;
  for (let i = 0; i < count; i++) {
    let sx = i * spacing - cameraX * parallax;
    sx = ((sx % total) + total) % total - spacing;
    if (sx > canvas.width + spacing) continue;
    drawFn(sx, i);
  }
}

function drawBackground() {
  const W = canvas.width, GY = GROUND_Y;

  if (inHiddenLevel) { drawBgSkyCity(W, GY); drawPlatforms(); return; }

  // Dark fallback fill
  const fallbacks = ['#0a0000','#04020e','#020600','#080700','#080000'];
  ctx.fillStyle = fallbacks[level - 1] || '#000000';
  ctx.fillRect(0, 0, W, canvas.height);

  // Background image — scale to fill GROUND_Y height, parallax scroll
  const bgImg = BG_IMAGES[String(level)];
  if (bgImg && bgImg.complete && bgImg.naturalWidth) {
    // Images are pre-scaled to exact display height — draw 1:1, no browser interpolation
    ctx.imageSmoothingEnabled = false;
    const dw = bgImg.naturalWidth;   // already the right width at GY height
    const parallax = (dw - W) / (WORLD_WIDTH - W);
    const offsetX  = -(cameraX * parallax);
    let x = ((offsetX % dw) - dw) % dw;
    while (x < W) { ctx.drawImage(bgImg, x, 0, dw, GY); x += dw; }
    ctx.imageSmoothingEnabled = true;
  }

  drawPlatforms();

  // Organic atmosphere layered over the static sprite background
  drawAtmosphere(W, GY, frameCount);

  // Cinematic vignette
  const vg = ctx.createRadialGradient(W/2,canvas.height*0.52,W*0.18,W/2,canvas.height*0.52,W*0.8);
  vg.addColorStop(0,'rgba(0,0,0,0)'); vg.addColorStop(0.55,'rgba(0,0,0,0.08)'); vg.addColorStop(1,'rgba(0,0,0,0.72)');
  ctx.fillStyle=vg; ctx.fillRect(0,0,W,canvas.height);
}

// ── Per-level atmospheric overlays ────────────────────────────
function drawAtmosphere(W, GY, t) {
  switch (level) {
    case 1: drawAtmCity(t, W, GY); break;
    case 2: drawAtmDungeon(t, W, GY); break;
    case 3: drawAtmJungle(t, W, GY); break;
    case 4: drawAtmSpace(t, W, GY); break;
    case 5: drawAtmHell(t, W, GY); break;
  }
}

// World-anchored atmosphere particle x — fixed world position, just drift/sway added on top
function atmX(seed, parallax, drift, t, W) {
  const base = bh(seed) * W * 2 - cameraX + drift;
  return ((base % W) + W) % W;
}

// Level 1 — Destroyed city: smoke, embers, drifting ash
function drawAtmCity(t, W, GY) {
  ctx.save();
  for (let i = 0; i < 7; i++) {
    const sx = (((i * 230 + t * 0.32 - cameraX * 0.05) % (W + 320)) + (W + 320)) % (W + 320) - 160;
    const sy = 70 + i * 22 + Math.sin(t * 0.012 + i) * 10;
    const r = 70 + bh(i + 600) * 50;
    const g = ctx.createRadialGradient(sx, sy, 0, sx, sy, r);
    g.addColorStop(0, 'rgba(40, 22, 14, 0.45)');
    g.addColorStop(1, 'rgba(40, 22, 14, 0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(sx, sy, r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();

  // Falling fire-orbs — each orb gets its own speed, lateral sway and start offset
  // so the rain looks chaotic rather than a single sheet of particles.
  ctx.save();
  for (let i = 0; i < 32; i++) {
    const swayAmp = 8 + bh(i + 505) * 22;
    const swayFreq = 0.02 + bh(i + 506) * 0.04;
    const ex = atmX(i + 500, 0.25, Math.sin(t * swayFreq + bh(i + 507) * 6.28) * swayAmp, t, W);
    const speed = 0.5 + bh(i + 502) * 1.8;
    const ey = ((t * speed + bh(i + 503) * GY * 2) % (GY + 40)) - 20;
    if (ey < -10) continue;
    const flicker = 0.5 + Math.sin(t * 0.18 + bh(i + 508) * 12) * 0.5;
    ctx.shadowColor = '#ff6a00';
    ctx.shadowBlur = 5;
    ctx.fillStyle = `rgba(255, ${110 + (flicker * 120) | 0}, 30, ${0.45 + flicker * 0.45})`;
    ctx.beginPath();
    ctx.arc(ex, ey, 1 + bh(i + 504) * 1.6, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();

  for (let i = 0; i < 45; i++) {
    const ax = atmX(i + 700, 0.1, Math.sin(t * 0.02 + i * 0.7) * 4, t, W);
    const ay = ((t * (0.5 + bh(i + 702) * 0.9) + bh(i + 701) * GY) % GY);
    ctx.fillStyle = `rgba(170, 145, 120, ${0.25 + bh(i + 703) * 0.35})`;
    ctx.fillRect(ax | 0, ay | 0, 1, 1);
  }
}

// Level 2 — Dungeon: dust motes, low fog, water droplets
function drawAtmDungeon(t, W, GY) {
  ctx.save();
  const mg = ctx.createLinearGradient(0, GY - 110, 0, GY);
  mg.addColorStop(0, 'rgba(110, 110, 140, 0)');
  mg.addColorStop(1, 'rgba(110, 110, 140, 0.32)');
  ctx.fillStyle = mg;
  ctx.fillRect(0, GY - 110, W, 110);
  ctx.restore();

  for (let i = 0; i < 50; i++) {
    const swayAmp = 6 + bh(i + 803) * 18;
    const swayFreq = 0.012 + bh(i + 804) * 0.025;
    const dx = atmX(i + 800, 0.07, Math.sin(t * swayFreq + bh(i + 805) * 6.28) * swayAmp, t, W);
    const speed = 0.08 + bh(i + 806) * 0.35;
    const dy = ((bh(i + 801) * GY * 2 + t * speed) % GY);
    const tw = 0.5 + Math.sin(t * 0.055 + bh(i + 807) * 12) * 0.5;
    ctx.fillStyle = `rgba(190, 180, 220, ${0.18 + tw * 0.32})`;
    ctx.beginPath();
    ctx.arc(dx, dy, 0.7 + bh(i + 802) * 0.9, 0, Math.PI * 2);
    ctx.fill();
  }

  for (let i = 0; i < 6; i++) {
    const dx = ((bh(i + 850) * W * 1.3 - cameraX * 0.4) % W + W) % W;
    const phase = (t * 0.6 + i * 47) % 200;
    if (phase < 120) {
      const dy = phase * 1.5;
      ctx.fillStyle = `rgba(140, 170, 200, ${0.35 * (1 - phase / 120)})`;
      ctx.fillRect(dx | 0, dy | 0, 1, 5);
    }
  }
}

// Level 3 — Jungle: mist, fireflies, tumbling leaves
function drawAtmJungle(t, W, GY) {
  ctx.save();
  ctx.globalAlpha = 0.13;
  for (let i = 0; i < 5; i++) {
    const mx = (((i * 300 + t * 0.4 - cameraX * 0.04) % (W + 360)) + (W + 360)) % (W + 360) - 180;
    const my = GY * 0.48 + i * 28;
    const g = ctx.createRadialGradient(mx, my, 0, mx, my, 150);
    g.addColorStop(0, 'rgba(170, 220, 170, 0.55)');
    g.addColorStop(1, 'rgba(170, 220, 170, 0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(mx, my, 150, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();

  for (let i = 0; i < 28; i++) {
    const swayAmp = 10 + bh(i + 903) * 28;
    const swayFreq = 0.02 + bh(i + 904) * 0.05;
    const px = atmX(i + 900, 0.12, Math.sin(t * swayFreq + bh(i + 905) * 6.28) * swayAmp, t, W);
    const speed = 0.08 + bh(i + 906) * 0.4;
    const bobAmp = 18 + bh(i + 907) * 20;
    const py = ((bh(i + 901) * GY * 2 + Math.sin(t * 0.022 + bh(i + 908) * 12) * bobAmp + t * speed) % (GY * 0.95));
    const tw = 0.5 + Math.sin(t * 0.1 + bh(i + 909) * 12) * 0.5;
    ctx.shadowColor = '#bdff8a';
    ctx.shadowBlur = 6;
    ctx.fillStyle = `rgba(190, 255, 140, ${0.45 + tw * 0.4})`;
    ctx.beginPath();
    ctx.arc(px, py, 1.1 + bh(i + 902) * 1.3, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;
  }

  for (let i = 0; i < 14; i++) {
    const lx = atmX(i + 1000, 0.22, Math.sin(t * 0.045 + i) * 32, t, W);
    const ly = ((bh(i + 1001) * GY + t * (0.45 + bh(i + 1002) * 0.7)) % GY);
    const angle = t * 0.04 + i;
    ctx.save();
    ctx.translate(lx, ly);
    ctx.rotate(angle);
    ctx.fillStyle = `rgba(${60 + (bh(i + 1003) * 80) | 0}, ${110 + (bh(i + 1004) * 60) | 0}, 30, 0.7)`;
    ctx.beginPath();
    ctx.ellipse(0, 0, 4, 2, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
}

// Level 4 — Space station: stars, debris, electric sparks
function drawAtmSpace(t, W, GY) {
  for (let i = 0; i < 70; i++) {
    const sx = atmX(i + 1100, 0.01, 0, t, W);
    const sy = bh(i + 1101) * GY * 0.62;
    const tw = 0.5 + Math.sin(t * 0.08 + i * 3.1) * 0.5;
    ctx.fillStyle = `rgba(220, 240, 255, ${0.28 + tw * 0.55})`;
    ctx.fillRect(sx | 0, sy | 0, 1, 1);
  }

  for (let i = 0; i < 16; i++) {
    const dx = (((bh(i + 1300) * W * 1.4 + t * 0.32 - cameraX * 0.15) % (W + 60)) + (W + 60)) % (W + 60) - 30;
    const dy = bh(i + 1301) * GY * 0.72 + Math.sin(t * 0.02 + i) * 6;
    ctx.save();
    ctx.translate(dx, dy);
    ctx.rotate(t * 0.012 + i);
    ctx.fillStyle = `rgba(${110 + (bh(i + 1302) * 80) | 0}, ${110 + (bh(i + 1303) * 80) | 0}, ${140 + (bh(i + 1304) * 60) | 0}, 0.55)`;
    ctx.fillRect(-3, -1, 6, 2);
    ctx.restore();
  }

  for (let i = 0; i < 22; i++) {
    const sx = atmX(i + 1200, 0.4, 0, t, W);
    const sy = bh(i + 1201) * GY * 0.85 + GY * 0.08;
    const flicker = Math.sin(t * 0.4 + i * 5.7);
    if (flicker > 0.85) {
      const a = (flicker - 0.85) * 5;
      ctx.save();
      ctx.shadowColor = '#33ddff';
      ctx.shadowBlur = 12;
      ctx.fillStyle = `rgba(150, 230, 255, ${a})`;
      ctx.beginPath();
      ctx.arc(sx, sy, 2, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = `rgba(180, 240, 255, ${a * 0.9})`;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(sx, sy);
      ctx.lineTo(sx + (bh(i + 1202) - 0.5) * 14, sy + 7);
      ctx.lineTo(sx + (bh(i + 1203) - 0.5) * 10, sy + 16);
      ctx.stroke();
      ctx.restore();
    }
  }
}

// Level 5 — Hell: lava glow, rising embers, heat haze
function drawAtmHell(t, W, GY) {
  ctx.save();
  const lg = ctx.createLinearGradient(0, GY - 80, 0, GY);
  lg.addColorStop(0, 'rgba(255, 60, 0, 0)');
  lg.addColorStop(1, 'rgba(255, 110, 0, 0.42)');
  ctx.fillStyle = lg;
  ctx.fillRect(0, GY - 80, W, 80);
  ctx.restore();

  ctx.save();
  ctx.globalAlpha = 0.09;
  for (let i = 0; i < 7; i++) {
    const hx = (((i * 200 + t * 0.55 - cameraX * 0.08) % (W + 240)) + (W + 240)) % (W + 240) - 120;
    const hy = GY * 0.38 + i * 28 + Math.sin(t * 0.018 + i) * 6;
    const g = ctx.createRadialGradient(hx, hy, 0, hx, hy, 120);
    g.addColorStop(0, 'rgba(255, 90, 0, 0.7)');
    g.addColorStop(1, 'rgba(255, 60, 0, 0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(hx, hy, 120, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();

  // Falling hellfire orbs — random speeds, sway amplitudes and start offsets per orb
  for (let i = 0; i < 65; i++) {
    const swayAmp = 6 + bh(i + 1404) * 26;
    const swayFreq = 0.025 + bh(i + 1405) * 0.05;
    const ex = atmX(i + 1400, 0.28, Math.sin(t * swayFreq + bh(i + 1406) * 6.28) * swayAmp, t, W);
    const speed = 0.7 + bh(i + 1401) * 2.6;
    const ey = ((t * speed + bh(i + 1402) * GY * 2) % (GY + 50)) - 25;
    if (ey < -6) continue;
    const flicker = 0.5 + Math.sin(t * 0.22 + bh(i + 1407) * 12) * 0.5;
    ctx.shadowColor = '#ff3300';
    ctx.shadowBlur = 6;
    ctx.fillStyle = `rgba(255, ${70 + (flicker * 140) | 0}, 0, ${0.55 + flicker * 0.4})`;
    ctx.beginPath();
    ctx.arc(ex, ey, 1 + bh(i + 1403) * 2.1, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;
  }
}

function drawShadow(worldX, baseY, w) {
  const sx = worldX - cameraX;
  const sg = ctx.createRadialGradient(sx, baseY, 0, sx, baseY, w);
  sg.addColorStop(0, 'rgba(0,0,0,0.4)');
  sg.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.save();
  ctx.fillStyle = sg;
  ctx.beginPath();
  ctx.ellipse(sx, baseY, w, w * 0.22, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

// ── helpers ───────────────────────────────────────────────────
function flame(cx, cy, w, h, fl, alpha) {
  ctx.beginPath();
  ctx.moveTo(cx-w,cy+2);
  ctx.quadraticCurveTo(cx-w*.55,cy-h*.52,cx+fl*3-1,cy-h);
  ctx.quadraticCurveTo(cx+w*.55,cy-h*.48,cx+w,cy+2);
  ctx.globalAlpha=alpha; ctx.fill(); ctx.globalAlpha=1;
}

// ── Level 1: Burned City ──────────────────────────────────────
function bgCity(t, W, GY) {
  // Ambient fire glow across horizon
  const hg=ctx.createLinearGradient(0,GY*0.5,0,GY);
  hg.addColorStop(0,'rgba(0,0,0,0)'); hg.addColorStop(1,'rgba(70,12,0,0.35)');
  ctx.fillStyle=hg; ctx.fillRect(0,0,W,GY);

  // Faint stars through smoke
  for (let i=0;i<28;i++) {
    const sx=(bh(i+1000)*W*2-cameraX*0.004+W*4)%W;
    ctx.fillStyle=`rgba(255,170,100,${0.05+bh(i+1001)*0.1})`;
    ctx.fillRect(sx|0,(bh(i+1002)*GY*0.38)|0,1,1);
  }

  // Blood moon — craters, heat rings
  const mx=W*0.76-cameraX*0.009, my=50;
  for (let r=6;r>0;r--) {
    const rg2=ctx.createRadialGradient(mx,my,32,mx,my,32+r*20);
    rg2.addColorStop(0,`rgba(210,18,0,${0.02*(7-r)})`); rg2.addColorStop(1,'rgba(160,8,0,0)');
    ctx.fillStyle=rg2; ctx.beginPath(); ctx.arc(mx,my,32+r*20,0,Math.PI*2); ctx.fill();
  }
  ctx.save(); ctx.shadowColor='#ff1500'; ctx.shadowBlur=65;
  const mg=ctx.createRadialGradient(mx-9,my-7,3,mx,my,33);
  mg.addColorStop(0,'#d81200'); mg.addColorStop(0.5,'#aa0d00'); mg.addColorStop(1,'#7a0700');
  ctx.fillStyle=mg; ctx.beginPath(); ctx.arc(mx,my,33,0,Math.PI*2); ctx.fill();
  ctx.globalAlpha=0.38;
  [[9,-6,11],[-11,8,8],[-4,-12,7],[14,10,6],[-14,-7,8]].forEach(([ox,oy,cr])=>{
    ctx.fillStyle='rgba(55,0,0,0.8)'; ctx.beginPath(); ctx.arc(mx+ox,my+oy,cr,0,Math.PI*2); ctx.fill();
  });
  ctx.restore();

  // Distant haze layer
  pxItems(40,110,0.02,(sx,i)=>{
    const h=20+bh(i+1100)*55, w=18+bh(i+1101)*32;
    ctx.fillStyle=`rgba(14,2,0,${0.35+bh(i+1102)*0.3})`; ctx.fillRect(sx,GY-h,w,h);
  });

  // Far skyscrapers — multi-detail (parallax 0.055)
  pxItems(32,142,0.055,(sx,i)=>{
    const bh2=95+bh(i)*190, bw=28+bh(i+1)*68;
    const bg=ctx.createLinearGradient(sx,GY-bh2,sx+bw,GY);
    bg.addColorStop(0,'#0a0000'); bg.addColorStop(0.35,'#0f0100'); bg.addColorStop(1,'#190300');
    ctx.fillStyle=bg; ctx.fillRect(sx,GY-bh2,bw,bh2);
    // Floor ledges
    for (let f=0;f<Math.floor(bh2/32);f++) { ctx.fillStyle='rgba(28,3,0,0.45)'; ctx.fillRect(sx-1,GY-f*32-32,bw+2,2); }
    // Setback top
    if (bh(i+2)>0.42) { ctx.fillStyle='#080000'; ctx.fillRect(sx+bw*.1,GY-bh2-15,bw*.8,15); if (bh(i+3)>0.55) ctx.fillRect(sx+bw*.2,GY-bh2-28,bw*.6,13); }
    // Water tower
    if (bh(i+4)>0.52) {
      const wtx=sx+bw*.62,wty=GY-bh2-40; ctx.fillStyle='#070000';
      ctx.fillRect(wtx-9,wty+10,18,24); ctx.beginPath(); ctx.arc(wtx,wty+10,13,Math.PI,0); ctx.fill();
      ctx.strokeStyle='#050000'; ctx.lineWidth=2; ctx.beginPath(); ctx.moveTo(wtx,wty); ctx.lineTo(wtx,wty+10); ctx.stroke();
    }
    // Billboard
    if (bh(i+5)>0.58) { ctx.fillStyle='#070000'; ctx.fillRect(sx+bw*.08,GY-bh2*0.52,bw*.74,24); ctx.fillRect(sx+bw*.34,GY-bh2*0.52+24,7,20); }
    // Antenna with crossbar
    if (bh(i+6)>0.38) {
      ctx.strokeStyle='#060000'; ctx.lineWidth=1.5;
      ctx.beginPath(); ctx.moveTo(sx+bw*.58,GY-bh2); ctx.lineTo(sx+bw*.58,GY-bh2-38); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(sx+bw*.58-9,GY-bh2-22); ctx.lineTo(sx+bw*.58+9,GY-bh2-22); ctx.stroke();
    }
    // Fire escape
    if (bh(i+7)>0.45) {
      ctx.strokeStyle='rgba(9,1,0,0.9)'; ctx.lineWidth=1.5;
      for (let fe=0;fe<7;fe++) {
        const fy=GY-bh2*0.18-fe*28; ctx.beginPath(); ctx.moveTo(sx+bw-9,fy); ctx.lineTo(sx+bw+7,fy); ctx.stroke();
        if (fe<6) { ctx.beginPath(); ctx.moveTo(sx+bw-1,fy); ctx.lineTo(sx+bw-1,fy+28); ctx.stroke(); }
      }
    }
    // Windows — per-pane flicker, blown/intact
    for (let wy=0;wy<Math.floor(bh2/17);wy++) {
      for (let wx=0;wx<Math.floor(bw/10);wx++) {
        if (bh(i*21+wy*10+wx)>0.3) {
          const fl=Math.sin(t*0.08+i*1.7+wy*0.4+wx*0.95)*0.5+0.5;
          const blown=bh(i*21+wy*10+wx+90)>0.76;
          ctx.fillStyle=blown ? `rgba(255,${30+fl*80|0},0,${0.65+fl*0.3})`
                              : `rgba(255,${60+fl*115|0},8,${0.09+fl*0.2})`;
          ctx.fillRect(sx+2+wx*10,GY-bh2+7+wy*17,7,11);
        }
      }
    }
    // Structural blast hole
    if (bh(i+8)>0.66) { ctx.fillStyle='#040000'; ctx.beginPath(); ctx.arc(sx+bw*0.38,GY-bh2*(0.28+bh(i+9)*0.42),11+bh(i+10)*14,0,Math.PI*2); ctx.fill(); }
  });

  // Crumbled street-level debris & lamp posts (parallax 0.36)
  pxItems(16,275,0.36,(sx,i)=>{
    // Lamp post (broken)
    ctx.strokeStyle='rgba(22,6,0,0.9)'; ctx.lineWidth=4;
    ctx.beginPath(); ctx.moveTo(sx,GY); ctx.lineTo(sx,GY-50+bh(i+300)*18); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(sx,GY-50+bh(i+300)*18); ctx.quadraticCurveTo(sx+10,GY-60,sx+26,GY-55); ctx.stroke();
    ctx.fillStyle='rgba(22,6,0,0.8)'; ctx.beginPath(); ctx.arc(sx+26,GY-55,5,0,Math.PI*2); ctx.fill();
    // Wall chunks
    ctx.fillStyle='#1c0600'; ctx.fillRect(sx+45,GY-28,bh(i+301)*58+22,28);
    // Rubble heap
    ctx.fillStyle='#130300'; ctx.beginPath();
    ctx.moveTo(sx+85,GY); ctx.lineTo(sx+85,GY-14); ctx.lineTo(sx+100,GY-9); ctx.lineTo(sx+114,GY-20); ctx.lineTo(sx+128,GY-8); ctx.lineTo(sx+136,GY); ctx.fill();
  });

  // Smoke plumes — volumetric billows (parallax 0.5)
  pxItems(11,315,0.5,(sx,i)=>{
    for (let s=0;s<9;s++) {
      const drift=Math.sin(t*0.011+i+s*0.85)*(s*18);
      const r=18+s*22, alpha=(0.24-s*0.022)*(0.5+Math.sin(t*0.014+i*0.8)*0.5);
      const sg2=ctx.createRadialGradient(sx+drift,GY-20-s*52,0,sx+drift,GY-20-s*52,r);
      sg2.addColorStop(0,`rgba(22,4,0,${alpha*1.5})`); sg2.addColorStop(0.5,`rgba(15,3,0,${alpha})`); sg2.addColorStop(1,'rgba(6,1,0,0)');
      ctx.fillStyle=sg2; ctx.beginPath(); ctx.arc(sx+drift,GY-20-s*52,r,0,Math.PI*2); ctx.fill();
    }
  });


  // Falling embers & sparks
  for (let i=0;i<60;i++) {
    const ex=(bh(i+400)*W + bh(i+407)*W*0.73 + Math.sin(t*0.02+i*2.11)*15) % W;
    const ey=(t*(0.6+bh(i+402)*2.3) + bh(i+403)*GY + bh(i+406)*GY*1.4) % GY;
    const alpha=Math.sin(t*0.13+i)*0.38+0.52;
    ctx.fillStyle=`rgba(255,${70+bh(i+404)*150|0},0,${alpha})`;
    ctx.beginPath(); ctx.arc(ex,ey,0.8+bh(i+405)*2.2,0,Math.PI*2); ctx.fill();
  }

  // Ground fire reflections — wet asphalt puddles
  pxItems(7,410,0.92,(sx,i)=>{
    const fl=Math.sin(t*0.09+i)*0.5+0.5;
    const pg=ctx.createRadialGradient(sx,GY+3,0,sx,GY+3,38+fl*16);
    pg.addColorStop(0,`rgba(255,${45+fl*55|0},0,${0.22+fl*0.14})`); pg.addColorStop(1,'rgba(180,15,0,0)');
    ctx.fillStyle=pg; ctx.beginPath(); ctx.ellipse(sx,GY+3,38+fl*16,7,0,0,Math.PI*2); ctx.fill();
  });

  // Rubble foreground mounds (parallax 0.28)
  pxItems(16,242,0.28,(sx,i)=>{
    const rh=32+bh(i+50)*80, rw=58+bh(i+51)*90;
    const rg=ctx.createLinearGradient(sx,GY-rh,sx,GY);
    rg.addColorStop(0,'#1a0400'); rg.addColorStop(1,'#0c0100');
    ctx.fillStyle=rg; ctx.beginPath();
    ctx.moveTo(sx,GY); ctx.lineTo(sx,GY-rh*.32); ctx.lineTo(sx+rw*.1,GY-rh*.62); ctx.lineTo(sx+rw*.22,GY-rh*.38);
    ctx.lineTo(sx+rw*.36,GY-rh*.92); ctx.lineTo(sx+rw*.5,GY-rh*.54); ctx.lineTo(sx+rw*.64,GY-rh*.82);
    ctx.lineTo(sx+rw*.79,GY-rh*.36); ctx.lineTo(sx+rw,GY); ctx.fill();
    if (bh(i+52)>0.46) {
      ctx.strokeStyle='#2a0700'; ctx.lineWidth=2;
      ctx.beginPath(); ctx.moveTo(sx+rw*.34,GY-rh*.9); ctx.lineTo(sx+rw*.32,GY-rh*1.22); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(sx+rw*.61,GY-rh*.8); ctx.lineTo(sx+rw*.64,GY-rh*1.16); ctx.stroke();
    }
  });
}

// ── Level 2: Cemetery ────────────────────────────────────────
function bgCemetery(t, W, GY) {
  // Dense star field
  for (let i=0;i<80;i++) {
    const sx2=(bh(i+700)*W*2.2-cameraX*0.004+W*5)%W;
    const tw=Math.sin(t*0.032+i)*0.38+0.62;
    ctx.fillStyle=`rgba(${180+bh(i+701)*60|0},${180+bh(i+702)*60|0},255,${tw*0.55})`;
    ctx.fillRect(sx2|0,(bh(i+703)*GY*0.58)|0,1+bh(i+704)|0,1+bh(i+704)|0);
  }

  // Milky way streak
  ctx.save(); ctx.globalAlpha=0.06;
  const mwg=ctx.createLinearGradient(0,GY*0.1,W,GY*0.45);
  mwg.addColorStop(0,'rgba(150,140,220,0)'); mwg.addColorStop(0.5,'rgba(160,150,230,1)'); mwg.addColorStop(1,'rgba(140,130,200,0)');
  ctx.fillStyle=mwg; ctx.fillRect(0,0,W,GY*0.5); ctx.restore();

  // Occasional lightning flash
  if (Math.sin(t*0.041+1.2)>0.97) {
    const lf=(Math.sin(t*0.041+1.2)-0.97)*33;
    ctx.fillStyle=`rgba(200,200,255,${lf*0.18})`; ctx.fillRect(0,0,W,GY);
  }

  // Full moon — craters, halo rings, moonbeam column
  const mmx=W*0.22-cameraX*0.003, mmy=56;
  // Moonbeam column
  const mbg=ctx.createLinearGradient(mmx,mmy+32,mmx,GY);
  mbg.addColorStop(0,'rgba(160,150,230,0.12)'); mbg.addColorStop(1,'rgba(100,90,180,0)');
  ctx.fillStyle=mbg; ctx.fillRect(mmx-35,mmy+32,70,GY-mmy-32);
  // Atmospheric halos
  for (let r=5;r>0;r--) {
    const hg2=ctx.createRadialGradient(mmx,mmy,30,mmx,mmy,30+r*22);
    hg2.addColorStop(0,`rgba(120,110,210,${0.028*(6-r)})`); hg2.addColorStop(1,'rgba(80,70,160,0)');
    ctx.fillStyle=hg2; ctx.beginPath(); ctx.arc(mmx,mmy,30+r*22,0,Math.PI*2); ctx.fill();
  }
  ctx.save(); ctx.shadowColor='#aaaaff'; ctx.shadowBlur=60;
  const mng=ctx.createRadialGradient(mmx-6,mmy-5,2,mmx,mmy,31);
  mng.addColorStop(0,'#e8e8ff'); mng.addColorStop(0.5,'#d0d0f0'); mng.addColorStop(1,'#a8a8cc');
  ctx.fillStyle=mng; ctx.beginPath(); ctx.arc(mmx,mmy,31,0,Math.PI*2); ctx.fill();
  // Craters
  ctx.globalAlpha=0.3;
  [[7,-5,10],[-9,7,8],[-3,-11,6],[13,9,5],[-13,-6,7],[4,14,5]].forEach(([ox,oy,cr])=>{
    ctx.fillStyle='rgba(80,75,120,0.7)'; ctx.beginPath(); ctx.arc(mmx+ox,mmy+oy,cr,0,Math.PI*2); ctx.fill();
    ctx.fillStyle='rgba(220,220,255,0.25)'; ctx.beginPath(); ctx.arc(mmx+ox-1,mmy+oy-1,cr*.55,0,Math.PI*2); ctx.fill();
  });
  ctx.restore();

  // Storm clouds drifting across moon
  for (let i=0;i<8;i++) {
    const cx2=((i*185-t*0.52-cameraX*0.022)%(W+300)+W+300)%(W+300)-150;
    const cg=ctx.createRadialGradient(cx2,48+i*11,0,cx2,48+i*11,100+i*18);
    cg.addColorStop(0,`rgba(4,2,16,${0.72+bh(i+750)*0.2})`); cg.addColorStop(1,'rgba(2,1,10,0)');
    ctx.fillStyle=cg; ctx.beginPath(); ctx.ellipse(cx2,48+i*11,100+i*18,22+i*3,0,0,Math.PI*2); ctx.fill();
  }

  // Distant gothic church (parallax 0.035)
  pxItems(3,1500,0.035,(sx,i)=>{
    ctx.fillStyle='#050312';
    ctx.fillRect(sx+90,GY-115,130,115); // nave
    ctx.fillRect(sx+50,GY-75,210,75);   // transept
    ctx.fillRect(sx+72,GY-210,55,210);  // bell tower
    ctx.beginPath(); ctx.moveTo(sx+72,GY-210); ctx.lineTo(sx+99,GY-275); ctx.lineTo(sx+127,GY-210); ctx.fill(); // spire
    // Buttresses
    ctx.fillRect(sx+50,GY-75,18,75); ctx.fillRect(sx+242,GY-75,18,75);
    // Stained glass glow — amber/violet
    const wgl=ctx.createRadialGradient(sx+156,GY-162,0,sx+156,GY-162,16);
    wgl.addColorStop(0,`rgba(120,60,200,${0.3+Math.sin(t*0.022)*0.08})`); wgl.addColorStop(1,'rgba(60,20,120,0)');
    ctx.fillStyle=wgl; ctx.beginPath(); ctx.arc(sx+156,GY-162,16,0,Math.PI*2); ctx.fill();
    // Cross top
    ctx.strokeStyle='#030210'; ctx.lineWidth=3;
    ctx.beginPath(); ctx.moveTo(sx+99,GY-275); ctx.lineTo(sx+99,GY-295); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(sx+91,GY-288); ctx.lineTo(sx+107,GY-288); ctx.stroke();
  });

  // Distant dead trees — recursive branching (parallax 0.09)
  pxItems(24,172,0.09,(sx,i)=>{
    const treeBranch=(x,y,len,ang,dep)=>{
      if (dep<0||len<4) return;
      const ex=x+Math.cos(ang)*len, ey=y+Math.sin(ang)*len;
      ctx.strokeStyle=`rgba(4,0,15,${0.65+dep*0.07})`; ctx.lineWidth=dep*1.8+0.4;
      ctx.beginPath(); ctx.moveTo(x,y); ctx.lineTo(ex,ey); ctx.stroke();
      const sp=0.3+bh(i*4+dep)*0.28;
      treeBranch(ex,ey,len*.66,ang-sp,dep-1);
      treeBranch(ex,ey,len*.62,ang+sp*.85,dep-1);
      if (bh(i*6+dep)>0.52) treeBranch(ex,ey,len*.44,ang+sp*.15,dep-2);
    };
    treeBranch(sx,GY,(88+bh(i+10)*125)*.5,-Math.PI/2+bh(i+11)*0.28-0.14,4);
  });

  // Willow tree silhouettes (parallax 0.18)
  pxItems(8,480,0.18,(sx,i)=>{
    const th=100+bh(i+770)*80;
    ctx.strokeStyle='rgba(5,0,18,0.88)'; ctx.lineWidth=5+bh(i+771)*3;
    ctx.beginPath(); ctx.moveTo(sx,GY); ctx.lineTo(sx-4,GY-th); ctx.stroke();
    // Drooping branches
    for (let wb=0;wb<8;wb++) {
      const bx=sx+(bh(i*8+wb)-0.5)*40, by=GY-th*(0.3+bh(i*8+wb+1)*0.5);
      const droop=60+bh(i*8+wb+2)*80, sway=Math.sin(t*0.008+i+wb)*8;
      ctx.lineWidth=2; ctx.strokeStyle='rgba(4,0,14,0.75)';
      ctx.beginPath(); ctx.moveTo(bx,by); ctx.quadraticCurveTo(bx+sway,by+droop*.5,bx+sway*1.5,by+droop); ctx.stroke();
    }
  });

  // Mausoleum/crypt (parallax 0.22)
  pxItems(5,760,0.22,(sx,i)=>{
    ctx.fillStyle='#0c0a1e';
    ctx.fillRect(sx,GY-55,65,55); // body
    ctx.fillRect(sx-8,GY-60,81,8); // cornice
    ctx.fillRect(sx+6,GY-68,53,8); // upper cornice
    // Triangular pediment
    ctx.beginPath(); ctx.moveTo(sx-8,GY-60); ctx.lineTo(sx+32,GY-88); ctx.lineTo(sx+73,GY-60); ctx.fill();
    // Door
    ctx.fillStyle='rgba(4,3,12,0.9)'; ctx.fillRect(sx+22,GY-32,20,32);
    ctx.beginPath(); ctx.arc(sx+32,GY-32,10,Math.PI,0); ctx.fill();
    // Columns
    ctx.fillStyle='rgba(10,8,22,0.9)';
    ctx.fillRect(sx+2,GY-55,8,55); ctx.fillRect(sx+55,GY-55,8,55);
    // Glowing crack between doors
    const dcg=ctx.createLinearGradient(sx+31,GY-32,sx+33,GY);
    dcg.addColorStop(0,`rgba(80,60,180,${0.15+Math.sin(t*0.03)*0.08})`); dcg.addColorStop(1,'rgba(40,20,100,0)');
    ctx.fillStyle=dcg; ctx.fillRect(sx+31,GY-32,2,32);
  });

  // Iron fence (parallax 0.32)
  pxItems(32,128,0.32,(sx,i)=>{
    ctx.strokeStyle='rgba(10,8,22,0.95)'; ctx.lineWidth=3;
    ctx.beginPath(); ctx.moveTo(sx,GY-48); ctx.lineTo(sx,GY); ctx.stroke();
    ctx.lineWidth=1.8; ctx.beginPath(); ctx.moveTo(sx-9,GY-30); ctx.lineTo(sx+9,GY-30); ctx.stroke();
    ctx.fillStyle='rgba(14,11,28,0.95)';
    ctx.beginPath(); ctx.moveTo(sx,GY-48); ctx.lineTo(sx-3.5,GY-40); ctx.lineTo(sx+3.5,GY-40); ctx.fill();
    // Horizontal rails
    if (i%4===0) { ctx.strokeStyle='rgba(8,6,18,0.8)'; ctx.lineWidth=2; ctx.beginPath(); ctx.moveTo(sx,GY-48); ctx.lineTo(sx+128*4,GY-48); ctx.stroke(); }
  });

  // Tombstones — 4 types, moss, cracks (parallax 0.4)
  pxItems(28,148,0.4,(sx,i)=>{
    const type=Math.floor(bh(i+30)*4);
    ctx.fillStyle='#0e0c1e';
    if (type===0) {
      const sw=17+bh(i+31)*11, sh=30+bh(i+32)*24;
      ctx.fillRect(sx,GY-sh,sw,sh);
      ctx.beginPath(); ctx.arc(sx+sw/2,GY-sh,sw/2,Math.PI,0); ctx.fill();
      ctx.fillStyle='#080612'; ctx.fillRect(sx+sw/2-1,GY-sh+7,2,15); ctx.fillRect(sx+sw/2-7,GY-sh+12,14,2);
    } else if (type===1) {
      const oh=48+bh(i+33)*35;
      ctx.beginPath(); ctx.moveTo(sx,GY); ctx.lineTo(sx+13,GY); ctx.lineTo(sx+11,GY-oh*.78); ctx.lineTo(sx+6.5,GY-oh); ctx.lineTo(sx+2,GY-oh*.78); ctx.fill();
    } else if (type===2) {
      const fw=28+bh(i+34)*22, fh=20+bh(i+35)*16;
      ctx.fillRect(sx,GY-fh,fw,fh); ctx.fillStyle='#080612'; ctx.fillRect(sx+3,GY-fh+5,fw-6,3);
    } else {
      const aw=22+bh(i+36)*16, ah=38+bh(i+37)*22;
      ctx.fillRect(sx,GY-ah,aw,ah);
      ctx.fillRect(sx-4,GY-ah,aw+8,8); // crossbar
      ctx.fillRect(sx+aw*.35,GY-ah-14,aw*.3,14); // upright
    }
    // Moss patches
    ctx.fillStyle='rgba(12,22,8,0.55)'; for (let m=0;m<3;m++) ctx.fillRect(sx+m*6+bh(i+38)*4,GY-6-m*4,5+bh(i+39)*5,3);
    // Crack
    ctx.strokeStyle='rgba(20,16,38,0.55)'; ctx.lineWidth=1;
    ctx.beginPath(); ctx.moveTo(sx+3,GY-10); ctx.lineTo(sx+3+bh(i+40)*12,GY-25+bh(i+41)*8); ctx.stroke();
  });

  // Bats — more (parallax 0.58)
  for (let i=0;i<7;i++) {
    const bx=((bh(i+800)*W*2.8+t*(1.4+bh(i+801)*0.9))%(W+120)+W+120)%(W+120)-60;
    const by=GY*.12+bh(i+802)*GY*.42;
    const flap=Math.sin(t*0.2+i*2.3)*0.5+0.5;
    ctx.fillStyle=`rgba(4,0,14,${0.82+bh(i+803)*0.14})`;
    ctx.beginPath();
    ctx.moveTo(bx,by); ctx.quadraticCurveTo(bx-14,by-9-flap*10,bx-24,by-1+flap*5);
    ctx.quadraticCurveTo(bx-11,by+5,bx,by);
    ctx.quadraticCurveTo(bx+11,by+5,bx+24,by-1+flap*5);
    ctx.quadraticCurveTo(bx+14,by-9-flap*10,bx,by); ctx.fill();
  }

  // Will-o'-wisps floating
  for (let i=0;i<5;i++) {
    const wx=((bh(i+820)*W+t*(0.3+bh(i+821)*0.4)+Math.sin(t*0.025+i)*25)%(W+60)+W+60)%(W+60)-30;
    const wy=GY-30-bh(i+822)*120+Math.sin(t*0.035+i*1.4)*12;
    const walpha=Math.sin(t*0.04+i*1.6)*0.4+0.55;
    ctx.save(); ctx.shadowColor='rgba(80,200,120,0.9)'; ctx.shadowBlur=16;
    ctx.fillStyle=`rgba(60,200,100,${walpha*0.5})`;
    ctx.beginPath(); ctx.arc(wx,wy,4+Math.sin(t*0.06+i)*1.5,0,Math.PI*2); ctx.fill();
    ctx.fillStyle=`rgba(180,255,200,${walpha*0.7})`;
    ctx.beginPath(); ctx.arc(wx,wy,2,0,Math.PI*2); ctx.fill();
    ctx.restore();
  }

  // Ground fog — 4 thick layers
  for (let layer=0;layer<4;layer++) {
    for (let i=0;i<12;i++) {
      const fx=((i*138+(layer*85)+t*(0.28+layer*0.12))%(W+300)+W+300)%(W+300)-150;
      const alpha=0.09+Math.sin(t*0.013+i+layer)*0.035;
      ctx.fillStyle=`rgba(${90+layer*18},${82+layer*16},${175+layer*12},${alpha})`;
      ctx.beginPath(); ctx.ellipse(fx,GY-2-layer*9,130+layer*25,20+layer*8,0,0,Math.PI*2); ctx.fill();
    }
  }

  // Swaying dead grass near ground
  pxItems(30,110,0.88,(sx,i)=>{
    const sway=Math.sin(t*0.015+i*0.9)*4;
    ctx.strokeStyle=`rgba(8,6,18,${0.6+bh(i+840)*0.3})`; ctx.lineWidth=1.2;
    ctx.beginPath(); ctx.moveTo(sx,GY); ctx.quadraticCurveTo(sx+sway,GY-10,sx+sway*1.4,GY-18); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(sx+4,GY); ctx.quadraticCurveTo(sx+4+sway*.8,GY-7,sx+4+sway*1.2,GY-14); ctx.stroke();
  });
}

// ── Level 3: Jungle Night ─────────────────────────────────────
function bgJungle(t, W, GY) {
  // Sky stars visible through gaps
  for (let i=0;i<60;i++) {
    const sx2=(bh(i+900)*W*2.5-cameraX*0.012+W*3)%W;
    const tw2=Math.sin(t*0.04+i)*0.3+0.7;
    ctx.fillStyle=`rgba(180,240,170,${tw2*0.45})`;
    ctx.fillRect(sx2, bh(i+901)*GY*0.6, 1.5, 1.5);
  }

  // Distant waterfall glow (parallax 0.03)
  pxItems(2, 1800, 0.03, (sx, i) => {
    const wg=ctx.createLinearGradient(sx+60,GY*0.15,sx+60,GY*0.75);
    wg.addColorStop(0,'rgba(40,80,40,0.0)'); wg.addColorStop(0.5,'rgba(30,70,35,0.25)');
    wg.addColorStop(1,'rgba(0,30,10,0)');
    ctx.fillStyle=wg; ctx.fillRect(sx+40,GY*0.15,40,GY*0.6);
    // Mist pool at base
    ctx.fillStyle='rgba(30,60,30,0.15)';
    ctx.beginPath(); ctx.ellipse(sx+60,GY*0.76,70,15,0,0,Math.PI*2); ctx.fill();
  });

  // Massive far canopy trees (parallax 0.06)
  pxItems(14, 260, 0.06, (sx, i) => {
    const tw3=30+bh(i+5)*42, th2=GY*0.9;
    const tg=ctx.createLinearGradient(sx,0,sx+tw3,0);
    tg.addColorStop(0,'#010500'); tg.addColorStop(0.4,'#021000'); tg.addColorStop(1,'#010500');
    ctx.fillStyle=tg; ctx.fillRect(sx-tw3/2,GY-th2,tw3,th2);
    // Canopy blobs — multiple overlapping
    for (let c=0;c<4;c++) {
      ctx.fillStyle=`rgba(0,${6+c*2},0,0.9)`;
      ctx.beginPath(); ctx.arc(sx+(bh(i*4+c)-0.5)*50, GY-th2+(bh(i*4+c+1)*30), 50+bh(i*4+c+2)*50, 0, Math.PI*2); ctx.fill();
    }
    // Root buttresses
    ctx.fillStyle='#010400';
    ctx.beginPath(); ctx.moveTo(sx-tw3/2,GY); ctx.lineTo(sx-tw3/2-18,GY); ctx.lineTo(sx-tw3/2,GY-40); ctx.fill();
    ctx.beginPath(); ctx.moveTo(sx+tw3/2,GY); ctx.lineTo(sx+tw3/2+18,GY); ctx.lineTo(sx+tw3/2,GY-40); ctx.fill();
  });

  // Mid canopy layer (parallax 0.22)
  pxItems(24, 180, 0.22, (sx, i) => {
    const sway=Math.sin(t*0.012+i*0.7)*4;
    ctx.fillStyle=`rgba(0,${8+bh(i+20)*8|0},0,0.92)`;
    ctx.beginPath();
    ctx.arc(sx+sway,GY-50-bh(i+21)*85,38+bh(i+22)*40,0,Math.PI*2); ctx.fill();
    ctx.beginPath();
    ctx.arc(sx+sway+25,GY-30-bh(i+23)*50,28+bh(i+24)*30,0,Math.PI*2); ctx.fill();
  });

  // Hanging vines with leaves (parallax 0.48)
  pxItems(18, 215, 0.48, (sx, i) => {
    const vl=80+bh(i+40)*130, sway=Math.sin(t*0.016+i)*8;
    ctx.strokeStyle=`rgba(2,${12+bh(i+41)*8|0},0,0.9)`; ctx.lineWidth=2;
    ctx.beginPath(); ctx.moveTo(sx,0);
    ctx.quadraticCurveTo(sx+sway,vl*0.5,sx+sway*2,vl); ctx.stroke();
    // Leaf blobs along vine
    for (let lv=0;lv<4;lv++) {
      const lx=sx+sway*(lv/4), ly=vl*(lv+1)*0.22;
      ctx.fillStyle=`rgba(1,${10+bh(i*4+lv)*10|0},0,0.8)`;
      ctx.beginPath(); ctx.ellipse(lx+6,ly,8+bh(i*4+lv+1)*6,5,bh(i*4+lv+2)*1.2,0,Math.PI*2); ctx.fill();
    }
  });

  // Bioluminescent mushrooms near ground (parallax 0.75)
  pxItems(12, 300, 0.75, (sx, i) => {
    const glow=0.4+Math.sin(t*0.04+i*1.5)*0.25;
    ctx.save(); ctx.shadowColor=`rgba(0,220,100,${glow})`; ctx.shadowBlur=12;
    ctx.fillStyle=`rgba(0,${130+glow*80|0},60,0.8)`;
    const mh=10+bh(i+60)*16;
    ctx.beginPath(); ctx.arc(sx,GY-mh,8+bh(i+61)*8,Math.PI,0); ctx.fill();
    ctx.fillStyle=`rgba(1,${60+glow*50|0},20,0.7)`;
    ctx.fillRect(sx-2,GY-mh,4,mh); ctx.restore();
  });

  // Glowing predator eyes in deep shadow
  pxItems(8, 510, 0.5, (sx, i) => {
    if (Math.sin(t*0.022+i*3.1)>0.9) return;
    const ey=GY-40-bh(i+70)*120;
    ctx.save(); ctx.fillStyle='#cc1000'; ctx.shadowColor='#ff2200'; ctx.shadowBlur=12;
    ctx.beginPath(); ctx.arc(sx,ey,3.5,0,Math.PI*2); ctx.fill();
    ctx.beginPath(); ctx.arc(sx+10,ey,3.5,0,Math.PI*2); ctx.fill(); ctx.restore();
  });

  // Foreground dark canopy fringe
  ctx.fillStyle='rgba(0,3,0,0.72)'; ctx.fillRect(0,0,W,52);

  // Fireflies — bobbing, glowing
  for (let i=0;i<28;i++) {
    const fx=((bh(i+950)*W+t*(.38+bh(i+951)*.65))%(W+50)+W+50)%(W+50)-25;
    const fy=GY*.28+Math.sin(t*.055+i*1.4)*32+bh(i+952)*GY*.52;
    const alpha=Math.sin(t*.13+i*2.1)*.45+0.52;
    ctx.save(); ctx.shadowColor='rgba(190,255,80,0.9)'; ctx.shadowBlur=10;
    ctx.fillStyle=`rgba(210,255,110,${alpha*.58})`; ctx.beginPath(); ctx.arc(fx,fy,2.2,0,Math.PI*2); ctx.fill();
    ctx.restore();
  }

  // Rain streaks
  ctx.save(); ctx.strokeStyle='rgba(20,50,15,0.2)'; ctx.lineWidth=1;
  for (let i=0;i<60;i++) {
    const rx=((bh(i+960)*W+t*2.5)%(W+20)+W+20)%(W+20)-10;
    const ry=(t*4+bh(i+961)*GY)%GY;
    ctx.beginPath(); ctx.moveTo(rx,ry); ctx.lineTo(rx-2,ry+12); ctx.stroke();
  }
  ctx.restore();

  // Ancient moss-covered ruins (parallax 0.045)
  pxItems(5,900,0.045,(sx,i)=>{
    ctx.fillStyle='rgba(4,10,2,0.88)';
    ctx.fillRect(sx,GY-80,18,80);
    ctx.beginPath(); ctx.arc(sx+9,GY-80,12,Math.PI,0); ctx.fill();
    ctx.fillRect(sx+55,GY-55,48,55);
    ctx.fillStyle='rgba(2,14,1,0.6)';
    for (let m=0;m<5;m++) ctx.fillRect(sx+55+m*9,GY-55+bh(i*5+m)*20,7,4);
  });

  // Bioluminescent ground plants
  pxItems(18,240,0.82,(sx,i)=>{
    const glow2=0.3+Math.sin(t*.045+i*2)*.25;
    ctx.save(); ctx.shadowColor='rgba(0,180,200,0.6)'; ctx.shadowBlur=8;
    ctx.strokeStyle=`rgba(0,${100+glow2*80|0},${120+glow2*80|0},0.7)`; ctx.lineWidth=1.5;
    for (let p=0;p<3;p++) {
      ctx.beginPath(); ctx.moveTo(sx+p*6,GY); ctx.quadraticCurveTo(sx+p*6+Math.sin(t*.02+p)*3,GY-8,sx+p*6+1,GY-14); ctx.stroke();
    }
    ctx.restore();
  });

  // Ground mist
  for (let i=0;i<10;i++) {
    const gfx=((i*130+t*.22)%(W+200)+W+200)%(W+200)-100;
    ctx.fillStyle=`rgba(10,30,8,${0.08+bh(i+980)*.05})`;
    ctx.beginPath(); ctx.ellipse(gfx,GY-4,100,16,0,0,Math.PI*2); ctx.fill();
  }
}

// ── Level 4: Warzone ─────────────────────────────────────────
function bgWarzone(t, W, GY) {
  // Dust haze / amber dawn-smoke overlay
  const haze=ctx.createLinearGradient(0,GY*.25,0,GY);
  haze.addColorStop(0,'rgba(0,0,0,0)'); haze.addColorStop(0.6,'rgba(24,18,4,0.3)'); haze.addColorStop(1,'rgba(42,32,8,0.65)');
  ctx.fillStyle=haze; ctx.fillRect(0,0,W,GY);

  // Distant explosion flashes with mushroom clouds
  for (let i=0;i<6;i++) {
    const ph=(t*0.019+i*2.1)%(Math.PI*2), s=Math.sin(ph);
    if (s>0.85) {
      const fx=W*(.05+bh(i+100)*.9), fa=(s-.85)*7;
      ctx.save(); ctx.shadowColor='#ffbb00'; ctx.shadowBlur=70;
      const sf=ctx.createRadialGradient(fx,GY*.18,0,fx,GY*.18,130);
      sf.addColorStop(0,`rgba(255,210,60,${fa*.45})`); sf.addColorStop(0.5,`rgba(255,120,0,${fa*.25})`); sf.addColorStop(1,'rgba(255,60,0,0)');
      ctx.fillStyle=sf; ctx.fillRect(0,0,W,GY*.55);
      // Fireball
      ctx.fillStyle=`rgba(255,${150+fa*15|0},0,${fa*.6})`;
      ctx.beginPath(); ctx.arc(fx,GY*.38,28*fa,0,Math.PI*2); ctx.fill();
      // Stalk
      ctx.fillStyle=`rgba(18,10,0,${fa*.75})`;
      ctx.fillRect(fx-5*fa,GY*.4,10*fa,GY*.25);
      // Mushroom cap
      ctx.beginPath(); ctx.arc(fx,GY*.4,36*fa,Math.PI,0); ctx.fill();
      ctx.restore();
    }
  }

  // Far ruined military base (parallax 0.08)
  pxItems(20,205,0.08,(sx,i)=>{
    const bh2=48+bh(i+110)*95, bw=33+bh(i+111)*48;
    const sg2=ctx.createLinearGradient(sx,GY-bh2,sx,GY);
    sg2.addColorStop(0,'#0d0b02'); sg2.addColorStop(1,'#181404');
    ctx.fillStyle=sg2; ctx.fillRect(sx,GY-bh2,bw,bh2);
    // Guard tower
    if (bh(i+112)>.52) { ctx.fillStyle='#0a0901'; ctx.fillRect(sx+5,GY-bh2-22,22,22); ctx.fillRect(sx+3,GY-bh2-26,26,4); }
    // Blast damage
    if (bh(i+113)>.58) { ctx.fillStyle='#000000'; ctx.beginPath(); ctx.arc(sx+bw*.55,GY-bh2*.32,11+bh(i+114)*10,0,Math.PI*2); ctx.fill(); }
    // Smoke from damage
    const smk=Math.sin(t*.012+i)*.5+.5;
    ctx.fillStyle=`rgba(22,16,4,${0.15+smk*.1})`;
    ctx.beginPath(); ctx.arc(sx+bw*.55,GY-bh2*.35-smk*20,12+smk*14,0,Math.PI*2); ctx.fill();
  });

  // Helicopter wreckage on the ground (parallax 0.18)
  pxItems(4,750,0.18,(sx,i)=>{
    ctx.fillStyle='#1c1808';
    // Fuselage
    ctx.beginPath(); ctx.ellipse(sx+40,GY-18,38,10,0.15,0,Math.PI*2); ctx.fill();
    // Tail boom
    ctx.fillRect(sx+70,GY-20,40,5);
    // Rotor blade (broken)
    ctx.strokeStyle='rgba(20,16,4,0.9)'; ctx.lineWidth=4;
    ctx.beginPath(); ctx.moveTo(sx+35,GY-28); ctx.lineTo(sx+5,GY-38); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(sx+35,GY-28); ctx.lineTo(sx+55,GY-20); ctx.stroke();
    // Fire
    const fl2=Math.sin(t*.12+i*1.7)*.5+.5;
    ctx.save(); ctx.shadowColor='#ff6600'; ctx.shadowBlur=14+fl2*10;
    ctx.fillStyle=`rgba(255,${80+fl2*80|0},0,${.7+fl2*.25})`;
    flame(sx+30,GY-28,10,18+fl2*12,fl2,0.9); ctx.restore();
  });

  // Burning tank wrecks (parallax 0.28)
  pxItems(6,575,0.28,(sx,i)=>{
    const fl=Math.sin(t*.1+i*1.7)*.5+.5;
    ctx.fillStyle='#181606'; ctx.fillRect(sx,GY-27,68,20); ctx.fillRect(sx+10,GY-40,40,14);
    ctx.fillStyle='#0e0c04'; ctx.fillRect(sx-2,GY-12,74,10);
    if (bh(i+120)>.5) { ctx.fillStyle='#141002'; ctx.fillRect(sx+44,GY-38,30,5); }
    ctx.save(); ctx.shadowColor='#ff5500'; ctx.shadowBlur=16+fl*12;
    ctx.fillStyle=`rgba(255,${60+fl*80|0},0,.85)`;
    flame(sx+28,GY-38,12,20+fl*18,fl,.92); ctx.restore();
  });

  // Sandbag walls with barbed wire (parallax 0.44)
  pxItems(14,330,0.44,(sx,i)=>{
    ctx.fillStyle='#28220a';
    for (let b=0;b<5;b++) { ctx.beginPath(); ctx.ellipse(sx+b*15,GY-11,8,7,0,0,Math.PI*2); ctx.fill(); }
    for (let b=0;b<4;b++) { ctx.beginPath(); ctx.ellipse(sx+7+b*15,GY-22,8,7,0,0,Math.PI*2); ctx.fill(); }
    for (let b=0;b<3;b++) { ctx.beginPath(); ctx.ellipse(sx+14+b*15,GY-32,8,7,0,0,Math.PI*2); ctx.fill(); }
    // Barbed wire
    ctx.strokeStyle='rgba(55,45,12,.85)'; ctx.lineWidth=1.5;
    ctx.beginPath(); ctx.moveTo(sx-4,GY-35);
    for (let w=0;w<10;w++) ctx.lineTo(sx+w*8,GY-35+(w%2?-5:5));
    ctx.stroke();
    // Post
    ctx.strokeStyle='rgba(48,36,8,.85)'; ctx.lineWidth=4;
    ctx.beginPath(); ctx.moveTo(sx+30,GY-35); ctx.lineTo(sx+30,GY); ctx.stroke();
  });

  // Dual sweeping searchlights
  for (let sl=0;sl<2;sl++) {
    const la=Math.sin(t*.01+sl*1.8)*.65;
    const lx2=W*(0.3+sl*.45)-(cameraX*.08)%(W*.5);
    ctx.save();
    const bg2=ctx.createLinearGradient(lx2,0,lx2+Math.sin(la)*GY,GY);
    bg2.addColorStop(0,'rgba(255,255,190,0.14)'); bg2.addColorStop(1,'rgba(255,255,140,0.01)');
    ctx.fillStyle=bg2;
    ctx.beginPath(); ctx.moveTo(lx2,0); ctx.lineTo(lx2+Math.sin(la)*GY,GY); ctx.lineTo(lx2+Math.sin(la)*GY+70,GY); ctx.lineTo(lx2+14,0); ctx.closePath(); ctx.fill();
    ctx.shadowColor='#ffffbb'; ctx.shadowBlur=18; ctx.fillStyle='rgba(255,255,180,.75)';
    ctx.beginPath(); ctx.arc(lx2+7,5,5,0,Math.PI*2); ctx.fill(); ctx.restore();
  }

  // Ground craters
  pxItems(12,310,0.86,(sx,i)=>{
    ctx.fillStyle='rgba(0,0,0,0.38)'; ctx.beginPath(); ctx.ellipse(sx,GY+3,20+bh(i+140)*16,7,0,0,Math.PI*2); ctx.fill();
    ctx.strokeStyle='rgba(28,22,5,.5)'; ctx.lineWidth=1.5; ctx.beginPath(); ctx.arc(sx,GY,18+bh(i+140)*14,Math.PI,0); ctx.stroke();
  });

  // Smoke drifting along ground
  for (let i=0;i<10;i++) {
    const sx2=((i*165-t*.55)%(W+250)+W+250)%(W+250)-125;
    const sg3=ctx.createRadialGradient(sx2,GY-8,0,sx2,GY-8,72+bh(i+145)*45);
    sg3.addColorStop(0,`rgba(35,28,6,${0.12+bh(i+146)*.08})`); sg3.addColorStop(1,'rgba(20,14,3,0)');
    ctx.fillStyle=sg3; ctx.beginPath(); ctx.ellipse(sx2,GY-8,72+bh(i+145)*45,14,0,0,Math.PI*2); ctx.fill();
  }

  // Tracer rounds in distance
  for (let i=0;i<4;i++) {
    const tx=((bh(i+150)*W+t*(6+bh(i+151)*8))%(W+40)+W+40)%(W+40)-20;
    const ty=GY*.2+bh(i+152)*GY*.5;
    ctx.save(); ctx.shadowColor='rgba(255,200,0,.8)'; ctx.shadowBlur=6;
    ctx.fillStyle=`rgba(255,220,60,${.3+bh(i+153)*.5})`;
    ctx.fillRect(tx,ty,14,2); ctx.restore();
  }
}

// ── Level 5: Hell ─────────────────────────────────────────────
function bgHell(t, W, GY) {
  // Pulsing lava horizon glow
  const lp=Math.sin(t*.028)*.1+.75;
  const lg=ctx.createLinearGradient(0,GY*.3,0,GY);
  lg.addColorStop(0,'rgba(0,0,0,0)'); lg.addColorStop(0.5,`rgba(110,0,0,${lp*.52})`); lg.addColorStop(1,`rgba(200,35,0,${lp*.9})`);
  ctx.fillStyle=lg; ctx.fillRect(0,0,W,GY);

  // Dark roiling hellclouds at top
  for (let i=0;i<7;i++) {
    const cx2=((i*165-t*.4-cameraX*.02)%(W+300)+W+300)%(W+300)-150;
    const cg2=ctx.createRadialGradient(cx2,30+i*10,0,cx2,30+i*10,110+i*15);
    cg2.addColorStop(0,`rgba(8,0,0,${0.55+bh(i+860)*.2})`); cg2.addColorStop(1,'rgba(5,0,0,0)');
    ctx.fillStyle=cg2; ctx.beginPath(); ctx.ellipse(cx2,30+i*10,110+i*15,28+i*4,0,0,Math.PI*2); ctx.fill();
  }

  // Distant lava lake
  ctx.save();
  const lavag=ctx.createLinearGradient(0,GY*.68,0,GY*.78);
  lavag.addColorStop(0,`rgba(255,${55+Math.sin(t*.045)*22|0},0,.65)`); lavag.addColorStop(1,`rgba(210,35,0,.42)`);
  ctx.fillStyle=lavag; ctx.fillRect(-cameraX*.04,GY*.68,W*1.15,GY*.1);
  // Lava bubbles/shimmer
  for (let i=0;i<12;i++) {
    const lsx=((i*110+t*.9)%(W+90)+W+90)%(W+90)-45;
    const pulse=Math.sin(t*.1+i)*.5+.5;
    ctx.fillStyle=`rgba(255,${90+pulse*50|0},0,${.28+pulse*.15})`;
    ctx.beginPath(); ctx.ellipse(lsx,GY*.73,25+pulse*8,5+pulse*3,0,0,Math.PI*2); ctx.fill();
  }
  ctx.restore();

  // Giant skull formations in far background (parallax 0.05)
  pxItems(6,640,0.05,(sx,i)=>{
    const sc=0.8+bh(i+870)*.6;
    ctx.fillStyle='#0a0000';
    // Cranium
    ctx.beginPath(); ctx.arc(sx,GY-80*sc,40*sc,Math.PI,0); ctx.fill();
    ctx.fillRect(sx-40*sc,GY-80*sc,80*sc,50*sc);
    // Eye sockets
    const eyeG=(hole,ex,ey,er)=>{ ctx.fillStyle=hole; ctx.beginPath(); ctx.ellipse(ex,ey,er,er*.7,0,0,Math.PI*2); ctx.fill(); };
    eyeG('#000000',sx-16*sc,GY-75*sc,10*sc); eyeG('#000000',sx+16*sc,GY-75*sc,10*sc);
    // Lava glow in sockets
    const sg2=ctx.createRadialGradient(sx-16*sc,GY-75*sc,0,sx-16*sc,GY-75*sc,10*sc);
    sg2.addColorStop(0,`rgba(255,60,0,${.3+Math.sin(t*.05+i)*.15})`); sg2.addColorStop(1,'rgba(200,20,0,0)');
    ctx.fillStyle=sg2; ctx.beginPath(); ctx.ellipse(sx-16*sc,GY-75*sc,10*sc,7*sc,0,0,Math.PI*2); ctx.fill();
    const sg3=ctx.createRadialGradient(sx+16*sc,GY-75*sc,0,sx+16*sc,GY-75*sc,10*sc);
    sg3.addColorStop(0,`rgba(255,60,0,${.3+Math.sin(t*.05+i+1)*.15})`); sg3.addColorStop(1,'rgba(200,20,0,0)');
    ctx.fillStyle=sg3; ctx.beginPath(); ctx.ellipse(sx+16*sc,GY-75*sc,10*sc,7*sc,0,0,Math.PI*2); ctx.fill();
    // Teeth
    ctx.fillStyle='#0a0000';
    for (let t2=0;t2<5;t2++) ctx.fillRect(sx-34*sc+t2*16*sc,GY-30*sc,10*sc,18*sc);
  });

  // Far demonic spires (parallax 0.06)
  pxItems(22,190,0.06,(sx,i)=>{
    const sh=85+bh(i+160)*185, sw=11+bh(i+161)*22;
    ctx.fillStyle='#080000';
    ctx.beginPath(); ctx.moveTo(sx+sw/2,GY-sh); ctx.lineTo(sx+sw,GY); ctx.lineTo(sx,GY); ctx.fill();
    if (bh(i+162)>.48) { ctx.beginPath(); ctx.moveTo(sx+sw*.28,GY-sh*.52); ctx.lineTo(sx+sw*.52,GY); ctx.lineTo(sx+sw*.04,GY); ctx.fill(); }
    const spg=ctx.createRadialGradient(sx+sw/2,GY,0,sx+sw/2,GY,38);
    spg.addColorStop(0,'rgba(230,55,0,.58)'); spg.addColorStop(1,'rgba(190,22,0,0)');
    ctx.fillStyle=spg; ctx.beginPath(); ctx.arc(sx+sw/2,GY,38,Math.PI,0); ctx.fill();
  });

  // Bone piles near ground (parallax 0.55)
  pxItems(12,320,0.55,(sx,i)=>{
    ctx.fillStyle='rgba(12,2,0,.85)';
    // Skull
    ctx.beginPath(); ctx.arc(sx,GY-14,8,Math.PI,0); ctx.fill();
    ctx.fillRect(sx-8,GY-14,16,10);
    ctx.fillStyle='rgba(6,0,0,.9)'; ctx.beginPath(); ctx.ellipse(sx-3,GY-11,3,2.5,0,0,Math.PI*2); ctx.fill();
    ctx.beginPath(); ctx.ellipse(sx+3,GY-11,3,2.5,0,0,Math.PI*2); ctx.fill();
    // Scattered bones
    ctx.strokeStyle='rgba(14,3,0,.8)'; ctx.lineWidth=3;
    ctx.beginPath(); ctx.moveTo(sx-18,GY-4); ctx.lineTo(sx+5,GY-8); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(sx+12,GY-3); ctx.lineTo(sx+28,GY-9); ctx.stroke();
  });

  // Chains swaying from sky (parallax 0.14)
  pxItems(12,345,0.14,(sx,i)=>{
    const cl=55+bh(i+170)*110, sway=Math.sin(t*.013+i)*6;
    ctx.strokeStyle=`rgba(38,4,0,.88)`; ctx.lineWidth=2.5;
    for (let c=0;c<Math.floor(cl/11);c++) {
      ctx.beginPath(); ctx.ellipse(sx+sway*(c/6),c*11,3.5,4.5,c%2*1.57,0,Math.PI*2); ctx.stroke();
    }
  });

  // Fire pillars — layered flames (parallax 0.3)
  pxItems(13,345,0.3,(sx,i)=>{
    const fl=Math.sin(t*.13+i*2)*.5+.5, fh=60+fl*115;
    ctx.save(); ctx.shadowColor='#ff4400'; ctx.shadowBlur=30+fl*14;
    ctx.fillStyle=`rgba(180,15,0,${.58+fl*.28})`; flame(sx,GY,20,fh,fl,1);
    ctx.fillStyle=`rgba(255,60,0,${.72+fl*.22})`; flame(sx,GY,14,fh*.76,fl,1);
    ctx.fillStyle=`rgba(255,160,0,${.82+fl*.15})`; flame(sx,GY,8,fh*.48,fl,1);
    const fc=ctx.createRadialGradient(sx,GY-14,0,sx,GY-14,15+fl*7);
    fc.addColorStop(0,'rgba(255,255,170,.95)'); fc.addColorStop(1,'rgba(255,180,0,0)');
    ctx.fillStyle=fc; ctx.beginPath(); ctx.arc(sx,GY-14,15+fl*7,0,Math.PI*2); ctx.fill();
    ctx.restore();
  });

  // Demon swarm flying
  for (let i=0;i<5;i++) {
    const dx=((bh(i+850)*W*2.2+t*(1.1+bh(i+851)*.9))%(W+160)+W+160)%(W+160)-80;
    const dy=GY*.08+bh(i+852)*GY*.38;
    const wing=Math.sin(t*.15+i*1.9)*.62+.5;
    ctx.fillStyle='rgba(10,0,0,.92)';
    ctx.beginPath(); ctx.ellipse(dx,dy,13,8,0,0,Math.PI*2); ctx.fill();
    ctx.beginPath();
    ctx.moveTo(dx,dy-2); ctx.quadraticCurveTo(dx-30,dy-20-wing*16,dx-48,dy-3+wing*9);
    ctx.quadraticCurveTo(dx-24,dy+9,dx,dy+2); ctx.fill();
    ctx.beginPath();
    ctx.moveTo(dx,dy-2); ctx.quadraticCurveTo(dx+30,dy-20-wing*16,dx+48,dy-3+wing*9);
    ctx.quadraticCurveTo(dx+24,dy+9,dx,dy+2); ctx.fill();
    ctx.strokeStyle='rgba(8,0,0,.92)'; ctx.lineWidth=2;
    ctx.beginPath(); ctx.moveTo(dx-6,dy-8); ctx.lineTo(dx-10,dy-21); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(dx+6,dy-8); ctx.lineTo(dx+10,dy-21); ctx.stroke();
    // Eye glow
    ctx.save(); ctx.fillStyle='rgba(255,60,0,.7)'; ctx.shadowColor='#ff2200'; ctx.shadowBlur=6;
    ctx.beginPath(); ctx.arc(dx-4,dy-1,2,0,Math.PI*2); ctx.fill();
    ctx.beginPath(); ctx.arc(dx+4,dy-1,2,0,Math.PI*2); ctx.fill(); ctx.restore();
  }

  // Brimstone meteors falling
  for (let i=0;i<8;i++) {
    const mx2=((bh(i+880)*W+t*(1.8+bh(i+881)))%(W+40)+W+40)%(W+40)-20;
    const my2=(t*(2.2+bh(i+882)*1.5)+bh(i+883)*GY)%GY;
    ctx.save(); ctx.shadowColor='#ff5500'; ctx.shadowBlur=10;
    ctx.fillStyle=`rgba(255,${50+bh(i+884)*80|0},0,.75)`;
    ctx.beginPath(); ctx.arc(mx2,my2,2.5+bh(i+885)*2,0,Math.PI*2); ctx.fill();
    ctx.strokeStyle=`rgba(255,${80+bh(i+884)*60|0},0,.3)`; ctx.lineWidth=1.5;
    ctx.beginPath(); ctx.moveTo(mx2,my2); ctx.lineTo(mx2+4,my2-12); ctx.stroke();
    ctx.restore();
  }

  // Lava cracks + glowing network near ground (parallax 0.87)
  pxItems(18,242,0.87,(sx,i)=>{
    const glow=.44+Math.sin(t*.07+i)*.3;
    ctx.save(); ctx.shadowColor='#ff4400'; ctx.shadowBlur=9;
    ctx.strokeStyle=`rgba(255,${48+glow*78|0},0,${glow})`; ctx.lineWidth=2;
    ctx.beginPath();
    ctx.moveTo(sx,GY-2); ctx.lineTo(sx+11,GY-14); ctx.lineTo(sx+22,GY-7); ctx.lineTo(sx+35,GY-18); ctx.lineTo(sx+50,GY-6); ctx.lineTo(sx+63,GY-14); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(sx+22,GY-7); ctx.lineTo(sx+16,GY-20); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(sx+35,GY-18); ctx.lineTo(sx+42,GY-28); ctx.stroke();
    ctx.restore();
  });

  // Floating embers
  for (let i=0;i<40;i++) {
    const ex=((bh(i+200)*W*2+t*(.45+bh(i+201)*1.9))%(W+55)+W+55)%(W+55)-28;
    const ey=GY-((t*(.32+bh(i+202)*.95)+bh(i+203)*GY)%GY);
    const alpha=.38+Math.sin(t*.11+i)*.42;
    ctx.fillStyle=`rgba(255,${50+bh(i+204)*125|0},0,${alpha})`;
    ctx.beginPath(); ctx.arc(ex,ey,1.2+bh(i+205)*2.8,0,Math.PI*2); ctx.fill();
  }
}

// ── Platforms (level-styled, realistic) ──────────────────────
// ── Platform tile cache ──────────────────────────────────────
// Mobile-friendly flat colors per level for the ground floor and elevated platforms.
function drawPlatforms() {
  for (const p of basePlatforms) {
    const sx = p.x - cameraX;
    if (sx + p.w < 0 || sx > canvas.width) continue;

    if (p.y === GROUND_Y) {
      if (inHiddenLevel) continue; // drawBgSkyCity already draws the ground
      // Ground floor — level-specific terrain
      if (level === 1) {
        // Scorched asphalt — dark with orange cracks
        const gg=ctx.createLinearGradient(0,p.y,0,canvas.height);
        gg.addColorStop(0,'#1e0a00'); gg.addColorStop(0.3,'#140500'); gg.addColorStop(1,'#0a0200');
        ctx.fillStyle=gg; ctx.fillRect(sx,p.y,p.w,canvas.height-p.y);
        // Glowing asphalt cracks
        ctx.save(); ctx.shadowColor='#ff4400'; ctx.shadowBlur=4;
        ctx.strokeStyle='rgba(200,60,0,0.35)'; ctx.lineWidth=1.5;
        for (let c=0;c<Math.floor(p.w/80);c++) {
          const cx=sx+c*80+20;
          ctx.beginPath(); ctx.moveTo(cx,p.y); ctx.lineTo(cx+18,p.y+12); ctx.lineTo(cx+8,p.y+24); ctx.stroke();
          ctx.beginPath(); ctx.moveTo(cx+35,p.y+4); ctx.lineTo(cx+22,p.y+18); ctx.stroke();
        }
        ctx.restore();
        ctx.fillStyle='rgba(180,70,0,0.28)'; ctx.fillRect(sx,p.y,p.w,3);
      } else if (level === 2) {
        // Cemetery earth — dark soil, exposed roots
        const gg=ctx.createLinearGradient(0,p.y,0,canvas.height);
        gg.addColorStop(0,'#0e0c1c'); gg.addColorStop(0.4,'#080618'); gg.addColorStop(1,'#04030e');
        ctx.fillStyle=gg; ctx.fillRect(sx,p.y,p.w,canvas.height-p.y);
        // Exposed root lines
        ctx.strokeStyle='rgba(18,14,30,0.8)'; ctx.lineWidth=2;
        for (let r=0;r<Math.floor(p.w/60);r++) {
          const rx=sx+r*60;
          ctx.beginPath(); ctx.moveTo(rx,p.y+2); ctx.quadraticCurveTo(rx+15,p.y+8,rx+28,p.y+4); ctx.stroke();
          ctx.beginPath(); ctx.moveTo(rx+30,p.y+2); ctx.quadraticCurveTo(rx+44,p.y+10,rx+55,p.y+3); ctx.stroke();
        }
        ctx.fillStyle='rgba(80,70,160,0.2)'; ctx.fillRect(sx,p.y,p.w,3);
      } else if (level === 3) {
        // Jungle floor — dark earth, dense undergrowth
        const gg=ctx.createLinearGradient(0,p.y,0,canvas.height);
        gg.addColorStop(0,'#060d02'); gg.addColorStop(0.4,'#030800'); gg.addColorStop(1,'#010400');
        ctx.fillStyle=gg; ctx.fillRect(sx,p.y,p.w,canvas.height-p.y);
        // Grass tufts
        ctx.strokeStyle='rgba(4,20,1,0.9)'; ctx.lineWidth=1.5;
        for (let g=0;g<Math.floor(p.w/18);g++) {
          const gx=sx+g*18+bh(g+400)*6;
          ctx.beginPath(); ctx.moveTo(gx,p.y); ctx.quadraticCurveTo(gx-3,p.y-8,gx-1,p.y-14); ctx.stroke();
          ctx.beginPath(); ctx.moveTo(gx+4,p.y); ctx.quadraticCurveTo(gx+6,p.y-6,gx+3,p.y-12); ctx.stroke();
        }
        ctx.fillStyle='rgba(30,80,0,0.22)'; ctx.fillRect(sx,p.y,p.w,3);
      } else if (level === 4) {
        // Warzone — cracked dirt, shell craters
        const gg=ctx.createLinearGradient(0,p.y,0,canvas.height);
        gg.addColorStop(0,'#14120a'); gg.addColorStop(0.4,'#0e0c06'); gg.addColorStop(1,'#080604');
        ctx.fillStyle=gg; ctx.fillRect(sx,p.y,p.w,canvas.height-p.y);
        // Tire tracks
        ctx.strokeStyle='rgba(10,8,2,0.7)'; ctx.lineWidth=5;
        for (let tr=0;tr<2;tr++) {
          ctx.beginPath(); ctx.moveTo(sx,p.y+8+tr*10); ctx.lineTo(sx+p.w,p.y+8+tr*10); ctx.stroke();
        }
        // Dirt cracks
        ctx.strokeStyle='rgba(8,6,2,0.6)'; ctx.lineWidth=1;
        for (let c=0;c<Math.floor(p.w/55);c++) {
          const cx=sx+c*55+10;
          ctx.beginPath(); ctx.moveTo(cx,p.y); ctx.lineTo(cx+22,p.y+16); ctx.lineTo(cx+14,p.y+26); ctx.stroke();
        }
        ctx.fillStyle='rgba(120,100,20,0.22)'; ctx.fillRect(sx,p.y,p.w,3);
      } else {
        // Hell — black rock with lava seams
        const gg=ctx.createLinearGradient(0,p.y,0,canvas.height);
        gg.addColorStop(0,'#1a0000'); gg.addColorStop(0.3,'#110000'); gg.addColorStop(1,'#0a0000');
        ctx.fillStyle=gg; ctx.fillRect(sx,p.y,p.w,canvas.height-p.y);
        // Lava seams
        const lp2=Math.sin(frameCount*0.05)*0.1+0.25;
        ctx.save(); ctx.shadowColor='#ff3300'; ctx.shadowBlur=6;
        ctx.strokeStyle=`rgba(255,60,0,${lp2})`; ctx.lineWidth=2;
        for (let c=0;c<Math.floor(p.w/70);c++) {
          const cx=sx+c*70+15;
          ctx.beginPath(); ctx.moveTo(cx,p.y); ctx.lineTo(cx+20,p.y+10); ctx.lineTo(cx+10,p.y+22); ctx.stroke();
          ctx.beginPath(); ctx.moveTo(cx+35,p.y+5); ctx.lineTo(cx+48,p.y+18); ctx.stroke();
        }
        ctx.restore();
        ctx.fillStyle=`rgba(255,55,0,${lp2})`; ctx.fillRect(sx,p.y,p.w,3);
      }

    } else {
      // Elevated platforms — level-specific construction
      if (inHiddenLevel) {
        // Floating neon panel — cyberpunk sky city
        const pg = ctx.createLinearGradient(sx, p.y, sx, p.y + p.h);
        pg.addColorStop(0, '#0c0830'); pg.addColorStop(1, '#060420');
        ctx.fillStyle = pg; ctx.fillRect(sx, p.y, p.w, p.h);
        // Neon border glow
        ctx.save();
        ctx.shadowColor = '#00ffcc'; ctx.shadowBlur = 12;
        ctx.strokeStyle = 'rgba(0,255,200,0.85)'; ctx.lineWidth = 1.5;
        ctx.strokeRect(sx + 1, p.y + 1, p.w - 2, p.h - 2);
        ctx.restore();
        // Top surface glow
        ctx.save();
        ctx.shadowColor = '#00eeff'; ctx.shadowBlur = 16;
        ctx.fillStyle = 'rgba(0,230,255,0.55)'; ctx.fillRect(sx, p.y, p.w, 3);
        ctx.restore();
        // Subtle grid lines
        ctx.strokeStyle = 'rgba(0,200,255,0.18)'; ctx.lineWidth = 1;
        for (let g = 0; g < Math.floor(p.w / 20); g++) {
          ctx.beginPath(); ctx.moveTo(sx + g * 20, p.y); ctx.lineTo(sx + g * 20, p.y + p.h); ctx.stroke();
        }
      } else if (level === 1) {
        // Cracked concrete ledge with rebar
        const pg=ctx.createLinearGradient(sx,p.y,sx,p.y+p.h);
        pg.addColorStop(0,'#4a2a0a'); pg.addColorStop(1,'#281400');
        ctx.fillStyle=pg; ctx.fillRect(sx,p.y,p.w,p.h);
        // Top surface — worn
        ctx.fillStyle='#7a4e18'; ctx.fillRect(sx,p.y,p.w,3);
        ctx.fillStyle='#200e00'; ctx.fillRect(sx,p.y+p.h-2,p.w,2);
        // Crack lines
        ctx.strokeStyle='rgba(10,4,0,0.7)'; ctx.lineWidth=1.5;
        for (let c=0;c<Math.floor(p.w/28);c++) {
          const cx=sx+c*28+8;
          ctx.beginPath(); ctx.moveTo(cx,p.y+1); ctx.lineTo(cx+10,p.y+p.h); ctx.stroke();
        }
        // Rebar ends
        ctx.strokeStyle='#3a1a00'; ctx.lineWidth=2;
        for (let r=0;r<Math.floor(p.w/40);r++) {
          ctx.beginPath(); ctx.moveTo(sx+r*40+15,p.y); ctx.lineTo(sx+r*40+18,p.y-8); ctx.stroke();
        }
      } else if (level === 2) {
        // Mossy stone slab
        const pg=ctx.createLinearGradient(sx,p.y,sx,p.y+p.h);
        pg.addColorStop(0,'#1c1a2e'); pg.addColorStop(1,'#0e0c1a');
        ctx.fillStyle=pg; ctx.fillRect(sx,p.y,p.w,p.h);
        // Stone block joints
        ctx.strokeStyle='rgba(8,6,16,0.8)'; ctx.lineWidth=2;
        for (let b=0;b<Math.floor(p.w/32);b++) ctx.strokeRect(sx+b*32,p.y,32,p.h);
        // Moss patches
        ctx.fillStyle='rgba(18,32,12,0.55)';
        for (let m=0;m<Math.floor(p.w/20);m++)
          ctx.fillRect(sx+m*20+4+bh(m+200)*6,p.y,8+bh(m+201)*8,4);
        // Top highlight
        ctx.fillStyle='rgba(40,38,65,0.6)'; ctx.fillRect(sx,p.y,p.w,3);
        ctx.fillStyle='rgba(6,4,14,0.8)'; ctx.fillRect(sx,p.y+p.h-2,p.w,2);
      } else if (level === 3) {
        // Jungle log — thick tree branch
        const pg=ctx.createLinearGradient(sx,p.y,sx,p.y+p.h);
        pg.addColorStop(0,'#3a2808'); pg.addColorStop(0.4,'#2a1c04'); pg.addColorStop(1,'#1a1002');
        ctx.fillStyle=pg; ctx.fillRect(sx,p.y,p.w,p.h);
        // Bark grain lines
        ctx.strokeStyle='rgba(15,8,0,0.6)'; ctx.lineWidth=1;
        for (let b=0;b<Math.floor(p.w/14);b++) {
          ctx.beginPath(); ctx.moveTo(sx+b*14,p.y); ctx.lineTo(sx+b*14+4,p.y+p.h); ctx.stroke();
        }
        // Knot circles
        if (p.w>80) { ctx.strokeStyle='rgba(12,6,0,0.5)'; ctx.lineWidth=2; ctx.beginPath(); ctx.arc(sx+p.w*0.35,p.y+p.h/2,5,0,Math.PI*2); ctx.stroke(); }
        // Moss on top surface
        ctx.fillStyle='rgba(10,28,2,0.5)'; ctx.fillRect(sx,p.y,p.w,4);
        // Hanging vine
        ctx.strokeStyle='rgba(4,18,0,0.8)'; ctx.lineWidth=2;
        ctx.beginPath(); ctx.moveTo(sx+p.w*0.25,p.y); ctx.lineTo(sx+p.w*0.22,p.y+22); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(sx+p.w*0.7,p.y); ctx.lineTo(sx+p.w*0.73,p.y+18); ctx.stroke();
      } else if (level === 4) {
        // Metal scaffolding / grating
        const pg=ctx.createLinearGradient(sx,p.y,sx,p.y+p.h);
        pg.addColorStop(0,'#2e2810'); pg.addColorStop(1,'#181406');
        ctx.fillStyle=pg; ctx.fillRect(sx,p.y,p.w,p.h);
        // Grating pattern
        ctx.fillStyle='rgba(0,0,0,0.4)';
        for (let g=0;g<Math.floor(p.w/12);g++)
          ctx.fillRect(sx+g*12+3,p.y+3,6,p.h-6);
        // Rivets / bolts
        ctx.fillStyle='rgba(60,50,16,0.8)';
        for (let b=0;b<Math.floor(p.w/20);b++) {
          ctx.beginPath(); ctx.arc(sx+b*20+4,p.y+2,2.5,0,Math.PI*2); ctx.fill();
          ctx.beginPath(); ctx.arc(sx+b*20+4,p.y+p.h-2,2.5,0,Math.PI*2); ctx.fill();
        }
        // Rust streaks
        ctx.fillStyle='rgba(80,30,0,0.25)';
        for (let r=0;r<3;r++) ctx.fillRect(sx+bh(r+300)*p.w,p.y,3,p.h);
        // Top edge highlight
        ctx.fillStyle='rgba(80,70,22,0.5)'; ctx.fillRect(sx,p.y,p.w,3);
      } else {
        // Hellstone — obsidian with glowing cracks
        const pg=ctx.createLinearGradient(sx,p.y,sx,p.y+p.h);
        pg.addColorStop(0,'#2a0800'); pg.addColorStop(1,'#160000');
        ctx.fillStyle=pg; ctx.fillRect(sx,p.y,p.w,p.h);
        // Glowing lava cracks
        const lp3=Math.sin(frameCount*0.05)*0.1+0.3;
        ctx.save(); ctx.shadowColor='#ff3300'; ctx.shadowBlur=6;
        ctx.strokeStyle=`rgba(255,60,0,${lp3})`; ctx.lineWidth=1.5;
        for (let c=0;c<Math.floor(p.w/22);c++) {
          ctx.beginPath(); ctx.moveTo(sx+c*22,p.y+p.h/2);
          ctx.lineTo(sx+c*22+10,p.y+3); ctx.lineTo(sx+c*22+18,p.y+p.h-3); ctx.stroke();
        }
        ctx.restore();
        // Top surface glow
        const topg=ctx.createLinearGradient(0,p.y,0,p.y+4);
        topg.addColorStop(0,`rgba(255,50,0,${lp3+0.1})`); topg.addColorStop(1,'rgba(255,0,0,0)');
        ctx.fillStyle=topg; ctx.fillRect(sx,p.y,p.w,5);
      }
    }
  }
}


function drawPlayer() {
  // Draw during 'dying' too so the death animation is visible. Skip on dead/menu/win/levelup.
  if (gameState !== 'playing' && gameState !== 'dying') return;
  if (!activePlayerLoaded()) return;
  if (player.invincible > 0 && Math.floor(player.invincible / 6) % 2 === 0) return;

  drawShadow(player.x + player.w / 2, player.y + player.h + 2, player.w * 1.6);

  const drawX = player.x - cameraX + player.w / 2;
  const drawY = player.y + player.h;

  if (selectedChar === 'viper') {
    drawPlayerViper(drawX, drawY);
  } else {
    drawPlayerZiggy(drawX, drawY);
  }
}

function drawPlayerViper(drawX, drawY) {
  const dh = 208 * VIPER_SCALE;
  const footY = dh * 0.88;

  // Rocket shooting — single static sprite
  if (player.weapon === 'rocket' && player.isShooting && viperRocketImg.complete && viperRocketImg.naturalWidth) {
    const dw = viperRocketImg.naturalWidth * (dh / viperRocketImg.naturalHeight);
    ctx.save();
    ctx.translate(drawX, drawY);
    if (player.facing === -1) ctx.scale(-1, 1);
    ctx.drawImage(viperRocketImg, -dw / 2, -footY, dw, dh);
    ctx.restore();
    return;
  }

  // Pick animation
  let animName;
  if (player.hp <= 0)          animName = 'die';
  else if (player.isShooting)  animName = player.weapon === 'm60' ? 'm60shoot' : 'shoot';
  else if (!player.onGround)   animName = 'jump';
  else if (player.isMoving)    animName = 'walk';
  else                         animName = 'idle';

  const animCfg = VIPER_ANIMS[animName];
  const frames   = viperSprites[animName];

  if (playerAnim.state !== animName) {
    playerAnim.state = animName;
    playerAnim.frame = 0;
    playerAnim.timer = 0;
  }

  playerAnim.timer++;
  if (playerAnim.timer >= animCfg.speed) {
    playerAnim.timer = 0;
    playerAnim.frame = animName === 'die'
      ? Math.min(playerAnim.frame + 1, animCfg.frames - 1)
      : (playerAnim.frame + 1) % animCfg.frames;
  }
  playerAnim.frame = Math.min(playerAnim.frame, animCfg.frames - 1);

  const img = frames[playerAnim.frame];
  if (!img || !img.complete || !img.naturalWidth) return;

  // Lock display height so the character doesn't grow/shrink between anims;
  // width follows each frame's natural aspect so the M60 reaches forward correctly.
  const dw = img.naturalWidth * (dh / img.naturalHeight);
  ctx.save();
  ctx.translate(drawX, drawY);
  if (player.facing === -1) ctx.scale(-1, 1);
  ctx.drawImage(img, -dw / 2, -footY, dw, dh);
  ctx.restore();
}

function drawPlayerZiggy(drawX, drawY) {
  let animName;
  if (player.hp <= 0)         animName = 'die';
  else if (player.isMelee)    animName = 'melee';
  else if (player.isShooting) animName = player.weapon === 'm16' ? 'm16' : 'shoot';
  else if (!player.onGround)  animName = 'jump';
  else if (player.isMoving)   animName = 'walk';
  else                        animName = 'idle';

  // Rocket shooting — single static sprite, bypass normal anim system
  if (player.weapon === 'rocket' && player.isShooting && ziggyRocketImg.complete && ziggyRocketImg.naturalWidth) {
    const scale = ZIGGY_HEIGHT / ziggyRocketImg.naturalHeight;
    const dw = ziggyRocketImg.naturalWidth * scale;
    const dh = ZIGGY_HEIGHT;
    ctx.save();
    ctx.translate(drawX, drawY);
    if (player.facing === -1) ctx.scale(-1, 1);
    ctx.drawImage(ziggyRocketImg, -dw / 2, -dh * ZIGGY_FOOT_FRAC, dw, dh);
    ctx.restore();
    return;
  }

  const animCfg = ZIGGY_ANIMS[animName];
  const frames  = ziggySprites[animName];

  // Reset frame when animation state changes to avoid out-of-bounds index
  if (playerAnim.state !== animName) {
    playerAnim.state = animName;
    playerAnim.frame = 0;
    playerAnim.timer = 0;
  }

  const total = frames.length;
  playerAnim.timer++;
  if (playerAnim.timer >= animCfg.speed) {
    playerAnim.timer = 0;
    playerAnim.frame = animName === 'die'
      ? Math.min(playerAnim.frame + 1, total - 1)
      : (playerAnim.frame + 1) % total;
  }

  // Clamp just in case, then get image
  playerAnim.frame = Math.min(playerAnim.frame, total - 1);
  const img = frames[playerAnim.frame];
  if (!img || !img.complete || !img.naturalWidth) return;

  const scale = ZIGGY_HEIGHT / img.naturalHeight;
  const dw = img.naturalWidth * scale;
  const dh = ZIGGY_HEIGHT;

  ctx.save();
  ctx.translate(drawX, drawY);
  if (player.facing === -1) ctx.scale(-1, 1);
  ctx.drawImage(img, -dw / 2, -dh * ZIGGY_FOOT_FRAC, dw, dh);
  ctx.restore();
}

function drawZombie(z) {
  const screenX = z.x - cameraX;
  if (screenX + 140 < 0 || screenX - 140 > canvas.width) return;

  // align feet with hitbox bottom, center horizontally
  const drawX = z.x - cameraX + z.w / 2;
  // Dead dogs always render on the main ground regardless of physics position
  const drawY = (z.dead && z.type === 'dog') ? GROUND_Y : z.y + z.h;

  // Moving: face the direction of travel. Standing still (gunner sweet spot): face the player.
  const dir = z.vx !== 0 ? (z.vx > 0 ? 1 : -1) : (player.x >= z.x ? 1 : -1);

  const _noShadow = z.type === 'dog' || (z.type === 'mega' && z.bossLevel >= 2);
  if (!z.dead && !_noShadow) drawShadow(z.x + z.w / 2, z.y + z.h + 2, z.w * 1.8);

  ctx.save();

  // While rising, clip so only the part above GROUND_Y is visible
  if (z.rising) {
    ctx.beginPath();
    ctx.rect(screenX - 80, 0, 160, GROUND_Y);
    ctx.clip();
  }

  // Hold full opacity through the death anim, fade only in the final stretch
  if (z.dead) ctx.globalAlpha = Math.min(1, Math.max(0, z.deathTimer / 25));

  ctx.translate(drawX, drawY);
  if (dir === -1) ctx.scale(-1, 1);

  if (z.type === 'charBoss') {
    const skin = z.charSkin;
    const anims   = skin === 'viper' ? VIPER_ANIMS   : ZIGGY_ANIMS;
    const sprites = skin === 'viper' ? viperSprites   : ziggySprites;
    const aMap = { run: 'walk', attack: 'shoot', die: 'die', walk: 'walk' };
    const animName = aMap[z.state] || 'idle';
    const aCfg = anims[animName];
    const animFrames = sprites[animName];
    if (aCfg && animFrames && animFrames.length > 0) {
      const fi = Math.min(z.stateFrame % animFrames.length, animFrames.length - 1);
      const charImg = animFrames[fi];
      if (charImg && charImg.complete && charImg.naturalWidth) {
        const refH = skin === 'viper' ? (208 * 0.55) : 85;
        const scale = z.h / refH;
        const dw = charImg.naturalWidth * scale;
        const dh = charImg.naturalHeight * scale;
        ctx.drawImage(charImg, -dw / 2, -dh * (skin === 'viper' ? 0.88 : 1.0), dw, dh);
      }
    }
    ctx.restore();
    return;
  }

  // Demon Boss sprite (level 5)
  if (z.type === 'mega' && z.bossLevel === 5) {
    let bImg;
    if (z.dead)                                     bImg = demonBossSprites.dead;
    else if (!z.onGround || z.megaState === 'lunge') bImg = demonBossSprites.attack;
    else if (z.state === 'walk' || z.state === 'run') bImg = demonBossSprites.walk[z.demonWalkFrame || 0];
    else                                              bImg = demonBossSprites.idle;
    if (bImg && bImg.complete && bImg.naturalWidth) {
      const scale = z.h / bImg.naturalHeight;
      const dw = bImg.naturalWidth * scale;
      ctx.drawImage(bImg, -dw / 2, -z.h, dw, z.h);
    }
    ctx.restore();
    return;
  }

  // Dog zombie
  if (z.type === 'dog') {
    let _di;
    if (z.dead)              _di = dogZombieSprites.dead;
    else if (z.state === 'attack') _di = dogZombieSprites.attack;
    else                     _di = dogZombieSprites.walk[z.dogWalkFrame||0];
    if (_di && _di.complete && _di.naturalWidth) {
      const _sc = z.h / _di.naturalHeight;
      const _dw = _di.naturalWidth * _sc;
      // Anchor each sprite so its lowest visible pixel sits at ground level
      const _yFrac = z.dead ? 0.811 : z.state === 'attack' ? 0.873 : 0.828;
      ctx.drawImage(_di, -_dw/2, -z.h * _yFrac, _dw, z.h);
    }
    ctx.restore(); return;
  }

  // Big Boss Zombie sprite (levels 2+)
  if (z.type === 'mega' && z.bossLevel >= 2) {
    let bImg;
    if (z.dead)              bImg = bigBossSprites.dead;
    else if (!z.onGround)    bImg = bigBossSprites.jump;
    else if (z.state === 'attack') bImg = bigBossSprites.appear;
    else                     bImg = bigBossSprites.walk;
    if (bImg && bImg.complete && bImg.naturalWidth) {
      const scale = z.h / bImg.naturalHeight;
      const dw = bImg.naturalWidth * scale;
      ctx.drawImage(bImg, -dw / 2, -z.h, dw, z.h);
    }
    ctx.restore();
    return;
  }

  const frames = zombieSprites[z.state] || zombieSprites.walk;
  const img = frames && frames[Math.min(z.stateFrame, frames.length - 1)];
  if (img && img.complete && img.naturalWidth) {
    // Scale every frame against the canonical standing height so the
    // lying-down death frame stays flat on the ground instead of stretched upright.
    const scale = z.h / ZOMBIE_REF_H;
    const dw = img.naturalWidth * scale;
    const dh = img.naturalHeight * scale;
    // Death frames 2–7 have ~6 natural-px of transparent padding below the body.
    // Shift the draw down by that padding so the body rests on the ground.
    const padBias = (z.state === 'die' && z.stateFrame > 0) ? 6 * scale : 0;
    ctx.drawImage(img, -dw / 2, -dh + padBias, dw, dh);
  }

  // HP bar (drawn in screen space, unaffected by flip)
  if (!z.dead && z.hp < z.maxHp) {
    ctx.restore();
    ctx.save();
    const barW = 40;
    const bx = z.x - cameraX + z.w / 2 - barW / 2;
    const by = z.y - 12;
    const ratio = z.hp / z.maxHp;
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.fillRect(bx - 1, by - 1, barW + 2, 7);
    ctx.fillStyle = '#2a0000';
    ctx.fillRect(bx, by, barW, 5);
    const hg = ctx.createLinearGradient(bx, by, bx + barW, by);
    hg.addColorStop(0, ratio > 0.4 ? '#00cc44' : '#ff4400');
    hg.addColorStop(1, ratio > 0.4 ? '#00ff55' : '#cc2200');
    ctx.fillStyle = hg;
    ctx.fillRect(bx, by, barW * ratio, 5);
    ctx.strokeStyle = 'rgba(255,255,255,0.15)';
    ctx.lineWidth = 1;
    ctx.strokeRect(bx, by, barW, 5);
  }

  ctx.restore();
}

function drawBullets() {
  for (const b of bullets) {
    const sx = b.x - cameraX;
    const dir = b.vx > 0 ? 1 : -1;
    ctx.save();
    if (b.isRocket) {
      // Rocket body
      ctx.shadowColor = '#ff6600'; ctx.shadowBlur = 14;
      ctx.fillStyle = '#cc3300';
      ctx.fillRect(sx - dir * 16, b.y - 4, 20, 8);
      // Nose cone
      ctx.fillStyle = '#ff9900';
      ctx.beginPath();
      ctx.moveTo(sx + dir * 4, b.y - 4);
      ctx.lineTo(sx + dir * 12, b.y);
      ctx.lineTo(sx + dir * 4, b.y + 4);
      ctx.fill();
      // Flame trail
      const tg = ctx.createLinearGradient(sx - dir * 16, b.y, sx - dir * 38, b.y);
      tg.addColorStop(0, 'rgba(255,180,40,0.95)');
      tg.addColorStop(0.5, 'rgba(255,80,0,0.6)');
      tg.addColorStop(1, 'rgba(255,40,0,0)');
      ctx.fillStyle = tg;
      ctx.fillRect(sx - dir * 38, b.y - 3, 22, 6);
    } else {
      const heavy = !!b.heavy;
      const thickness = heavy ? 5 : 4;
      const trailLen = heavy ? 28 : 25;
      const x0 = sx - dir * (trailLen - 5), x1 = sx + dir * 5;
      const tg = ctx.createLinearGradient(x0, b.y, x1, b.y);
      tg.addColorStop(0, 'rgba(255,100,0,0)');
      tg.addColorStop(1, heavy ? 'rgba(255,140,40,0.95)' : 'rgba(255,220,60,0.9)');
      ctx.fillStyle = tg;
      ctx.fillRect(Math.min(x0, x1), b.y - thickness / 2, trailLen, thickness);
      ctx.shadowColor = b.color || '#ffff80';
      ctx.shadowBlur = heavy ? 18 : 14;
      ctx.fillStyle = b.color || '#ffffff';
      const coreLen = heavy ? 8 : 6;
      ctx.fillRect(sx - coreLen / 2, b.y - thickness / 2, coreLen, thickness);
    }
    ctx.restore();
  }
}

function drawMuzzleFlash() {
  if (!player.isShooting || player.shootTimer <= 5 || gameState !== 'playing') return;
  // Match the bullet spawn's per-weapon barrel reach so the flash cone aligns with bullets.
  const barrelReach =
    player.weapon === 'm16' ? 34 :
    player.weapon === 'm60' ? 20 :
    player.weapon === 'pistol' && selectedChar !== 'viper' ? 22 :
    12;
  const sx = player.x - cameraX + (player.facing === 1 ? player.w + barrelReach : -barrelReach);
  const sy =
    player.weapon === 'm60' ? player.y - 1 :
    player.weapon === 'm16' ? player.y - 24 :
    player.weapon === 'pistol' && selectedChar !== 'viper' ? player.y - 24 :
    player.y - 18;
  const dir = player.facing;
  ctx.save();
  ctx.shadowColor = '#ffff80';
  ctx.shadowBlur = 28;
  // Directional cone
  const cg = ctx.createLinearGradient(sx, sy, sx + dir * 28, sy);
  cg.addColorStop(0, 'rgba(255,255,200,0.92)');
  cg.addColorStop(0.5, 'rgba(255,180,40,0.65)');
  cg.addColorStop(1, 'rgba(255,80,0,0)');
  ctx.fillStyle = cg;
  ctx.beginPath();
  ctx.moveTo(sx, sy - 8);
  ctx.lineTo(sx + dir * 32, sy);
  ctx.lineTo(sx, sy + 8);
  ctx.closePath();
  ctx.fill();
  // Center burst
  const fg = ctx.createRadialGradient(sx, sy, 0, sx, sy, 10);
  fg.addColorStop(0, 'rgba(255,255,255,0.95)');
  fg.addColorStop(0.4, 'rgba(255,230,80,0.8)');
  fg.addColorStop(1, 'rgba(255,100,0,0)');
  ctx.fillStyle = fg;
  ctx.beginPath();
  ctx.arc(sx, sy, 10, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function drawLightning() {
  for (let i = lightningBolts.length - 1; i >= 0; i--) {
    const b = lightningBolts[i];
    b.life--;
    if (b.life <= 0) { lightningBolts.splice(i, 1); continue; }
    const lifeFrac = b.life / b.maxLife;
    // Subtle flicker so the bolt feels electric
    const flicker = (Math.floor(b.life / 2) % 2 === 0) ? 1 : 0.65;
    const alpha = lifeFrac * flicker;

    ctx.save();
    // Wide soft halo (deepest blue glow)
    ctx.shadowColor = '#aaccff';
    ctx.shadowBlur = 50 * alpha;
    ctx.strokeStyle = `rgba(170, 210, 255, ${alpha * 0.85})`;
    ctx.lineWidth = 16 * alpha + 3;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    const drawPath = (pts) => {
      ctx.beginPath();
      ctx.moveTo(pts[0].x - cameraX, pts[0].y);
      for (let p = 1; p < pts.length; p++) ctx.lineTo(pts[p].x - cameraX, pts[p].y);
      ctx.stroke();
    };
    drawPath(b.points);
    for (const branch of b.branches) drawPath(branch);
    // Mid layer for richer body
    ctx.shadowBlur = 24 * alpha;
    ctx.strokeStyle = `rgba(220, 235, 255, ${alpha * 0.95})`;
    ctx.lineWidth = 7 * alpha + 1.5;
    drawPath(b.points);
    for (const branch of b.branches) drawPath(branch);
    // Hot white core
    ctx.shadowBlur = 12 * alpha;
    ctx.strokeStyle = `rgba(255, 255, 255, ${alpha})`;
    ctx.lineWidth = 3.5 * alpha + 1;
    drawPath(b.points);
    for (const branch of b.branches) drawPath(branch);

    // Bright screen flash on the impact frames
    if (b.life > b.maxLife - 10) {
      const fa = (b.life - (b.maxLife - 10)) / 10;
      ctx.fillStyle = `rgba(255, 255, 255, ${fa * 0.95})`;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }

    // Larger glowing impact disc
    const ix = b.impactX - cameraX;
    const iy = b.impactY;
    const ig = ctx.createRadialGradient(ix, iy, 0, ix, iy, 110 * alpha + 22);
    ig.addColorStop(0, `rgba(255, 255, 255, ${alpha})`);
    ig.addColorStop(0.3, `rgba(220, 235, 255, ${alpha * 0.85})`);
    ig.addColorStop(0.6, `rgba(160, 200, 255, ${alpha * 0.55})`);
    ig.addColorStop(1, 'rgba(140, 180, 255, 0)');
    ctx.fillStyle = ig;
    ctx.beginPath();
    ctx.arc(ix, iy, 110 * alpha + 22, 0, Math.PI * 2);
    ctx.fill();

    ctx.restore();
  }
}

function drawSlime() {
  for (const s of slimeProjectiles) {
    const sx = s.x - cameraX;
    if (sx < -30 || sx > canvas.width + 30) continue;
    ctx.save();

    if (s.isDemon) {
      // ── Molten lava rock / flame orb ───────────────────────────
      // Fire trail
      for (let i = 1; i <= 4; i++) {
        const tx = sx - s.vx * i * 0.5;
        const ty = s.y - s.vy * i * 0.5 + i * 0.4;
        ctx.fillStyle = `rgba(255,${120 - i * 22},0,${0.55 - i * 0.12})`;
        ctx.beginPath();
        ctx.arc(tx, ty, s.r * (0.9 - i * 0.16), 0, Math.PI * 2);
        ctx.fill();
      }
      // Molten rock body
      ctx.shadowColor = '#ff6600';
      ctx.shadowBlur = 18;
      const mg = ctx.createRadialGradient(sx, s.y, 0, sx, s.y, s.r);
      mg.addColorStop(0,   '#fff0a0');
      mg.addColorStop(0.3, '#ff8800');
      mg.addColorStop(0.7, '#cc2200');
      mg.addColorStop(1,   '#660000');
      ctx.fillStyle = mg;
      ctx.beginPath();
      ctx.arc(sx, s.y, s.r, 0, Math.PI * 2);
      ctx.fill();
      // Dark crust cracks
      ctx.shadowBlur = 0;
      ctx.strokeStyle = 'rgba(40,0,0,0.7)';
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(sx - s.r * 0.3, s.y - s.r * 0.2);
      ctx.lineTo(sx + s.r * 0.15, s.y + s.r * 0.3);
      ctx.moveTo(sx + s.r * 0.2, s.y - s.r * 0.35);
      ctx.lineTo(sx - s.r * 0.1, s.y + s.r * 0.1);
      ctx.stroke();
      // Bright highlight ember
      ctx.fillStyle = 'rgba(255,240,180,0.85)';
      ctx.beginPath();
      ctx.arc(sx - s.r * 0.28, s.y - s.r * 0.32, s.r * 0.22, 0, Math.PI * 2);
      ctx.fill();
    } else {
      // ── Green slime (default) ───────────────────────────────────
      // Drip trail
      for (let i = 1; i <= 3; i++) {
        const tx = sx - s.vx * i * 0.55;
        const ty = s.y - s.vy * i * 0.55 - i * 0.3;
        ctx.fillStyle = `rgba(80,220,80,${0.45 - i * 0.12})`;
        ctx.beginPath();
        ctx.arc(tx, ty, s.r * (0.85 - i * 0.18), 0, Math.PI * 2);
        ctx.fill();
      }
      // Body
      ctx.shadowColor = '#5dff5d';
      ctx.shadowBlur = 14;
      const g = ctx.createRadialGradient(sx, s.y, 0, sx, s.y, s.r);
      g.addColorStop(0, '#d4ffb0');
      g.addColorStop(0.45, '#44dd44');
      g.addColorStop(1, '#1a7a22');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(sx, s.y, s.r, 0, Math.PI * 2);
      ctx.fill();
      // Highlight
      ctx.shadowBlur = 0;
      ctx.fillStyle = 'rgba(230,255,200,0.7)';
      ctx.beginPath();
      ctx.arc(sx - s.r * 0.32, s.y - s.r * 0.38, s.r * 0.28, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.restore();
  }
}

function drawGrenades() {
  for (const g of grenadeList) {
    const sx = g.x - cameraX;
    ctx.save();
    ctx.fillStyle = g.fuse < 20 && Math.floor(g.fuse / 4) % 2 === 0 ? '#ff4400' : '#228844';
    ctx.beginPath();
    ctx.arc(sx, g.y, 6, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
}

function drawExplosions() {
  for (const e of explosions) {
    const sx = e.x - cameraX;
    const t = e.life / e.maxLife; // 1=fresh → 0=done
    const coreR = e.maxRadius * (0.4 + t * 0.6);
    ctx.save();
    // Expanding shockwave ring
    ctx.globalAlpha = t * 0.8;
    ctx.strokeStyle = '#ff9900';
    ctx.lineWidth = 4 * t + 1;
    ctx.shadowColor = '#ffdd00';
    ctx.shadowBlur = 18;
    ctx.beginPath();
    ctx.arc(sx, e.y, e.maxRadius * (0.4 + (1 - t) * 1.4), 0, Math.PI * 2);
    ctx.stroke();
    // Core fireball
    ctx.globalAlpha = Math.min(1, t * 1.8);
    ctx.shadowColor = '#ff4400';
    ctx.shadowBlur = coreR * 0.7;
    const grad = ctx.createRadialGradient(sx, e.y, 0, sx, e.y, coreR);
    grad.addColorStop(0, '#ffffff');
    grad.addColorStop(0.15, '#ffff80');
    grad.addColorStop(0.4, '#ff6600');
    grad.addColorStop(0.75, '#cc2200');
    grad.addColorStop(1, 'transparent');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(sx, e.y, coreR, 0, Math.PI * 2);
    ctx.fill();
    // Rising smoke (appears as fire fades)
    ctx.globalAlpha = (1 - t) * 0.45;
    ctx.shadowBlur = 0;
    ctx.fillStyle = 'rgba(14,10,6,0.55)';
    ctx.beginPath();
    ctx.arc(sx, e.y - coreR * 0.7, coreR * 1.4, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
}

function drawParticles() {
  for (const p of particles) {
    const sx = p.x - cameraX;
    ctx.save();
    ctx.globalAlpha = p.life / 40;
    ctx.shadowColor = p.color;
    ctx.shadowBlur = p.size * 1.8;
    ctx.fillStyle = p.color;
    ctx.beginPath();
    ctx.arc(sx, p.y, Math.max(0.5, p.size / 2), 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
}

function drawBlood() {
  for (const b of bloodSplatters) {
    const sx = b.x - cameraX;
    ctx.save();
    ctx.globalAlpha = b.life / 40;
    // Elliptical pool
    ctx.fillStyle = '#5a0000';
    ctx.beginPath();
    ctx.ellipse(sx, b.y, 13, 6, 0, 0, Math.PI * 2);
    ctx.fill();
    // Darker core
    ctx.fillStyle = '#300000';
    ctx.beginPath();
    ctx.ellipse(sx, b.y, 6, 3, 0, 0, Math.PI * 2);
    ctx.fill();
    // Deterministic splatter drops
    ctx.fillStyle = '#8b0000';
    const seed = b.x | 0;
    for (let d = 0; d < 5; d++) {
      const ang = bh(seed + d * 7) * Math.PI * 2;
      const dist = 10 + bh(seed + d * 7 + 3) * 14;
      ctx.beginPath();
      ctx.arc(sx + Math.cos(ang) * dist, b.y + Math.sin(ang) * dist * 0.45,
              1.5 + bh(seed + d * 7 + 5) * 2.5, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }
}

function drawAmmoPickups() {
  for (const a of ammoPickups) {
    const sx = a.x - cameraX;
    const hover = Math.sin(a.anim) * 3;
    const y = a.y + hover;
    ctx.save();
    // Ground glow
    const gg = ctx.createRadialGradient(sx + a.w / 2, y + a.h + 4, 0, sx + a.w / 2, y + a.h + 4, 16);
    gg.addColorStop(0, 'rgba(255,190,0,0.3)');
    gg.addColorStop(1, 'rgba(255,190,0,0)');
    ctx.fillStyle = gg;
    ctx.beginPath();
    ctx.ellipse(sx + a.w / 2, y + a.h + 4, 16, 5, 0, 0, Math.PI * 2);
    ctx.fill();
    // Box with glow
    ctx.shadowColor = '#ffcc00';
    ctx.shadowBlur = 10;
    const bg = ctx.createLinearGradient(sx, y, sx, y + a.h);
    bg.addColorStop(0, '#9a8520');
    bg.addColorStop(0.5, '#7a6818');
    bg.addColorStop(1, '#4a3e08');
    ctx.fillStyle = bg;
    ctx.fillRect(sx, y, a.w, a.h);
    ctx.shadowBlur = 0;
    // Highlight + shadow edges
    ctx.fillStyle = 'rgba(255,220,60,0.45)';
    ctx.fillRect(sx, y, a.w, 3);
    ctx.fillStyle = 'rgba(0,0,0,0.4)';
    ctx.fillRect(sx, y + a.h - 3, a.w, 3);
    // Yellow band
    ctx.fillStyle = '#d4aa00';
    ctx.fillRect(sx + 2, y + 4, a.w - 4, 3);
    // Label
    ctx.fillStyle = '#000';
    ctx.font = 'bold 7px Courier New';
    ctx.fillText('AMMO', sx + 1, y + 12);
    ctx.restore();
  }
}

function drawWeaponPickups() {
  for (const wp of weaponPickups) {
    const sx = wp.x - cameraX;
    if (sx + wp.w < -20 || sx > canvas.width + 20) continue;
    const hover = Math.sin(wp.anim) * 3;
    const y = wp.y + hover;
    const isM60 = wp.weapon === 'm60';
    const isRocket = wp.weapon === 'rocket';
    const accent = isRocket ? '#ff4400' : isM60 ? '#ff6600' : '#ffd84a';

    ctx.save();
    // Ground glow
    const gg = ctx.createRadialGradient(sx + wp.w / 2, y + wp.h + 4, 0, sx + wp.w / 2, y + wp.h + 4, 24);
    gg.addColorStop(0, isM60 ? 'rgba(255,90,0,0.45)' : 'rgba(255,210,60,0.4)');
    gg.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = gg;
    ctx.beginPath();
    ctx.ellipse(sx + wp.w / 2, y + wp.h + 4, 24, 6, 0, 0, Math.PI * 2);
    ctx.fill();

    // Weapon body — silhouette gun shape
    ctx.shadowColor = accent;
    ctx.shadowBlur = 10;
    ctx.fillStyle = '#1a1a1a';
    if (isRocket) {
      // Rocket launcher tube
      ctx.fillRect(sx + 2, y + 3, wp.w - 4, 10);            // main tube
      ctx.fillStyle = '#cc3300'; ctx.fillRect(sx + wp.w - 6, y + 5, 8, 6); // rocket nose
      ctx.fillStyle = '#1a1a1a'; ctx.fillRect(sx + 6, y + 12, 7, 5);       // grip
      ctx.fillStyle = '#333';    ctx.fillRect(sx + 2, y + 3, wp.w - 4, 3); // top rail
      ctx.fillStyle = 'rgba(255,255,255,0.18)'; ctx.fillRect(sx + 2, y + 3, wp.w - 4, 2);
      ctx.font = 'bold 8px Courier New'; ctx.fillStyle = accent;
      ctx.fillText('RPG', sx + (wp.w - 18) / 2, y - 2);
    } else {
    // Receiver
    ctx.fillRect(sx + 6, y + 4, wp.w - 14, 7);
    // Barrel
    ctx.fillRect(sx + wp.w - 10, y + 6, 10, 3);
    // Stock (rear)
    ctx.fillRect(sx, y + 5, 7, 6);
    // Magazine
    ctx.fillRect(sx + 14, y + 10, 6, 6);
    if (isM60) {
      // Bipod & belt feed bulge for M60
      ctx.fillRect(sx + wp.w - 14, y + 11, 2, 5);
      ctx.fillRect(sx + wp.w - 18, y + 11, 2, 5);
      ctx.fillStyle = '#444';
      ctx.fillRect(sx + 20, y + 9, 10, 4);
    } else {
      // Carry handle / sight for M16
      ctx.fillRect(sx + 18, y + 1, 10, 3);
    }
    ctx.shadowBlur = 0;

    } // end non-rocket
    // Highlight
    if (!isRocket) {
    ctx.fillStyle = 'rgba(255,255,255,0.18)';
    ctx.fillRect(sx + 6, y + 4, wp.w - 14, 2);
    }

    if (!isRocket) {
      // Label tag for M16/M60
      ctx.font = 'bold 8px Courier New';
      ctx.fillStyle = accent;
      ctx.fillText(isM60 ? 'M60' : 'M16', sx + (wp.w - 18) / 2, y - 2);
    }
    ctx.restore();
  }
}


function drawPortal() {
  if (!portal || !portal.active) return;
  const sx = portal.x - cameraX;
  if (sx + 80 < 0 || sx - 80 > canvas.width) return;
  const t = portal.anim;
  const cx = sx + portal.w / 2;
  const cy = portal.y + portal.h / 2;
  const rx = portal.w / 2 + Math.sin(t * 2) * 4;
  const ry = portal.h / 2;
  ctx.save();
  for (let ring = 3; ring >= 1; ring--) {
    ctx.strokeStyle = 'rgba(100,200,255,' + (0.15 * ring) + ')';
    ctx.lineWidth = 5 + ring * 4;
    ctx.beginPath();
    ctx.ellipse(cx, cy, rx + ring * 6, ry + ring * 6, 0, 0, Math.PI * 2);
    ctx.stroke();
  }
  const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, rx);
  grad.addColorStop(0, 'rgba(200,240,255,' + (0.7 + Math.sin(t * 3) * 0.15) + ')');
  grad.addColorStop(0.4, 'rgba(50,150,255,0.65)');
  grad.addColorStop(0.8, 'rgba(0,80,200,0.4)');
  grad.addColorStop(1,   'rgba(0,20,80,0)');
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.shadowColor = '#88eeff';
  ctx.shadowBlur = 22 + Math.sin(t * 4) * 8;
  ctx.strokeStyle = '#ccf8ff';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
  ctx.stroke();
  ctx.shadowColor = '#88eeff';
  ctx.shadowBlur = 14;
  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 11px Courier New';
  ctx.textAlign = 'center';
  ctx.fillText('SECRET PORTAL', cx, portal.y - 14);
  ctx.textAlign = 'left';
  ctx.restore();
}

function drawHealthOrbs() {
  for (const a of ammoPickups) {
    if (!a.isHealth) continue;
    const sx = a.x - cameraX + a.w / 2;
    const hover = Math.sin(a.anim) * 4;
    const y = a.y + hover;
    ctx.save();
    ctx.shadowColor = '#ff4488';
    ctx.shadowBlur = 16;
    const g = ctx.createRadialGradient(sx, y, 0, sx, y, 11);
    g.addColorStop(0, '#ffaacc');
    g.addColorStop(0.5, '#ff2266');
    g.addColorStop(1, '#880033');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(sx, y, 9, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.fillStyle = 'rgba(255,255,255,0.8)';
    ctx.beginPath();
    ctx.arc(sx - 3, y - 3, 3, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
}

function drawBgSkyCity(W, GY) {
  const t = frameCount * 0.012;

  // ── Void sky ──────────────────────────────────────────────
  const sky = ctx.createLinearGradient(0, 0, 0, GY);
  sky.addColorStop(0,   '#000005');
  sky.addColorStop(0.4, '#02000f');
  sky.addColorStop(0.75,'#0a0118');
  sky.addColorStop(1,   '#180030');
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, W, canvas.height);

  // ── Smog haze bands ───────────────────────────────────────
  for (let b = 0; b < 3; b++) {
    const by2 = 160 + b * 70 + Math.sin(t * 0.4 + b) * 8;
    const hg = ctx.createLinearGradient(0, by2, 0, by2 + 30);
    hg.addColorStop(0, 'rgba(0,20,40,0)');
    hg.addColorStop(0.5, 'rgba(0,255,200,' + (0.04 + b * 0.015) + ')');
    hg.addColorStop(1, 'rgba(0,20,40,0)');
    ctx.fillStyle = hg;
    ctx.fillRect(0, by2, W, 30);
  }

  // ── Far megascrapers (parallax 0.04) ──────────────────────
  pxItems(16, 220, 0.04, (sx, i) => {
    const bh2 = 100 + bh(i * 97) * 180;
    const bw  = 35 + bh(i * 113) * 55;
    // Silhouette
    ctx.fillStyle = '#040008';
    ctx.fillRect(sx, GY - bh2 - 40, bw, bh2 + 40);
    // Antenna spire
    ctx.fillStyle = '#060010';
    ctx.fillRect(sx + bw / 2 - 2, GY - bh2 - 40 - 30, 4, 32);
    // Blinking antenna light
    const blink = Math.sin(t * 3.5 + i * 2.3) > 0.6;
    if (blink) {
      ctx.save();
      ctx.shadowColor = '#ff2200'; ctx.shadowBlur = 10;
      ctx.fillStyle = '#ff3300';
      ctx.beginPath(); ctx.arc(sx + bw / 2, GY - bh2 - 68, 3, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
    }
    // Neon edge lines on some buildings
    if (bh(i * 31) > 0.5) {
      const neonH = ['#00ffff','#ff00ff','#00ff88'][i % 3];
      ctx.save();
      ctx.shadowColor = neonH; ctx.shadowBlur = 8;
      ctx.strokeStyle = neonH + '44';
      ctx.lineWidth = 1;
      ctx.strokeRect(sx, GY - bh2 - 40, bw, bh2);
      ctx.restore();
    }
    // Scattered lit windows — cyan tint
    for (let row = 0; row < 7; row++) {
      for (let col = 0; col < 3; col++) {
        if (bh(i * 11 + row * 3 + col) > 0.55) {
          const wx = sx + 4 + col * (bw / 3 - 3);
          const wy = GY - bh2 - 35 + row * (bh2 / 8);
          ctx.fillStyle = 'rgba(140,240,255,' + (0.15 + bh(i + row) * 0.3) + ')';
          ctx.fillRect(wx, wy, 6, 8);
        }
      }
    }
  });

  // ── Mid-city neon towers (parallax 0.18) ─────────────────
  const NEON_COLS = ['#00ffff','#ff00cc','#00ff88','#ff4400','#aa44ff','#ff0066'];
  pxItems(11, 290, 0.18, (sx, i) => {
    const bh2 = 110 + bh(i * 61) * 170;
    const bw  = 55 + bh(i * 79) * 75;
    const nc  = NEON_COLS[i % NEON_COLS.length];
    const nc2 = NEON_COLS[(i + 2) % NEON_COLS.length];
    // Building body
    ctx.fillStyle = '#05000e';
    ctx.fillRect(sx, GY - bh2, bw, bh2);
    // Neon vertical strips on edges
    ctx.save();
    ctx.shadowColor = nc; ctx.shadowBlur = 18;
    ctx.strokeStyle = nc;
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(sx + 2, GY); ctx.lineTo(sx + 2, GY - bh2); ctx.stroke();
    ctx.strokeStyle = nc2;
    ctx.beginPath(); ctx.moveTo(sx + bw - 2, GY); ctx.lineTo(sx + bw - 2, GY - bh2); ctx.stroke();
    ctx.restore();
    // Holographic billboard mid-building
    if (bh(i * 53) > 0.4) {
      const bly = GY - bh2 * 0.55;
      const blw = bw * 0.75, blh = 22;
      const blx = sx + bw / 2 - blw / 2;
      const flash = Math.sin(t * 2 + i * 1.7);
      ctx.save();
      ctx.shadowColor = nc; ctx.shadowBlur = 20 + flash * 8;
      ctx.fillStyle = nc + '22';
      ctx.fillRect(blx, bly, blw, blh);
      ctx.strokeStyle = nc;
      ctx.lineWidth = 1.5;
      ctx.strokeRect(blx, bly, blw, blh);
      // Scanline pattern inside billboard
      for (let sl = 0; sl < 3; sl++) {
        ctx.fillStyle = nc + '55';
        ctx.fillRect(blx + 4, bly + 5 + sl * 5, blw - 8, 2);
      }
      ctx.restore();
    }
    // Windows — warm amber vs cool cyan mix
    for (let row = 0; row < 6; row++) {
      for (let col = 0; col < 4; col++) {
        if (bh(i * 7 + row * 4 + col + 50) > 0.42) {
          const wx = sx + 5 + col * (bw / 4 - 3);
          const wy = GY - bh2 + 10 + row * (bh2 / 7);
          const warm = bh(i + row + col) > 0.5;
          ctx.fillStyle = warm ? 'rgba(255,200,80,0.5)' : 'rgba(80,220,255,0.45)';
          ctx.fillRect(wx, wy, 7, 10);
        }
      }
    }
    // Rooftop glow dome
    ctx.save();
    ctx.shadowColor = nc; ctx.shadowBlur = 22;
    const rg = ctx.createRadialGradient(sx + bw / 2, GY - bh2, 0, sx + bw / 2, GY - bh2, bw * 0.6);
    rg.addColorStop(0, nc + '55');
    rg.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = rg;
    ctx.beginPath(); ctx.arc(sx + bw / 2, GY - bh2, bw * 0.6, Math.PI, Math.PI * 2); ctx.fill();
    ctx.restore();
  });

  // ── Flying vehicles (tiny moving lights across mid-sky) ───
  for (let v = 0; v < 8; v++) {
    const vspeed = 0.3 + bh(v * 41) * 0.9;
    const vx = ((bh(v * 23) * W + frameCount * vspeed * (bh(v * 7) > 0.5 ? 1 : -1) + W * 10) % (W * 2)) - W * 0.5;
    const vy2 = 60 + bh(v * 37) * 160;
    if (vx < -20 || vx > W + 20) continue;
    const vdir = bh(v * 7) > 0.5 ? 1 : -1;
    const vcol = ['#ff4400','#00ccff','#ff00aa','#ffffff'][v % 4];
    ctx.save();
    ctx.shadowColor = vcol; ctx.shadowBlur = 10;
    // Body
    ctx.fillStyle = '#111';
    ctx.fillRect(vx - 10 * vdir, vy2 - 3, 20, 5);
    // Headlights / taillights
    ctx.fillStyle = vcol;
    ctx.fillRect(vx + 8 * vdir, vy2 - 2, 4, 3);
    ctx.fillStyle = 'rgba(255,80,0,0.7)';
    ctx.fillRect(vx - 10 * vdir, vy2 - 1, 3, 2);
    ctx.restore();
  }

  // ── Acid rain (vertical streaks, parallax 0.3) ───────────
  ctx.save();
  ctx.globalAlpha = 0.35;
  for (let r = 0; r < 80; r++) {
    const rx = ((bh(r * 19) * W * 2 - cameraX * 0.3 + frameCount * 2.4 * (0.7 + bh(r * 43) * 0.6) + W * 20) % W);
    const ry = ((bh(r * 29) * GY + frameCount * (3 + bh(r * 57) * 3)) % (GY + 20)) - 10;
    const rl = 6 + bh(r * 71) * 14;
    const rc = bh(r * 83) > 0.6 ? 'rgba(0,255,180,0.6)' : 'rgba(180,80,255,0.5)';
    ctx.strokeStyle = rc;
    ctx.lineWidth = 0.8;
    ctx.beginPath(); ctx.moveTo(rx, ry); ctx.lineTo(rx - 1, ry + rl); ctx.stroke();
  }
  ctx.globalAlpha = 1;
  ctx.restore();

  // ── Ground platform — wet reflective neon surface ─────────
  // Dark base
  ctx.fillStyle = '#060010';
  ctx.fillRect(0, GY - 4, W, PLATFORM_H + 8);
  // Puddle reflections: smeared neon streaks on the ground
  pxItems(18, 180, 0.6, (sx, i) => {
    const rc = NEON_COLS[i % NEON_COLS.length];
    const rw = 30 + bh(i * 43) * 80;
    const ralpha = 0.08 + Math.sin(t + i * 1.3) * 0.04;
    ctx.save();
    ctx.globalAlpha = ralpha;
    const rg = ctx.createLinearGradient(sx, GY, sx + rw, GY);
    rg.addColorStop(0, 'rgba(0,0,0,0)');
    rg.addColorStop(0.5, rc);
    rg.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = rg;
    ctx.fillRect(sx, GY - 2, rw, 6);
    ctx.globalAlpha = 1;
    ctx.restore();
  });
  // Grid lines on floor
  ctx.save();
  ctx.strokeStyle = 'rgba(0,200,255,0.12)';
  ctx.lineWidth = 1;
  for (let g = 0; g < W; g += 60) {
    const gx = (g - (cameraX * 0.9) % 60 + 60) % W;
    ctx.beginPath(); ctx.moveTo(gx, GY - 4); ctx.lineTo(gx, GY + PLATFORM_H); ctx.stroke();
  }
  ctx.restore();
  // Top neon edge
  ctx.save();
  ctx.shadowColor = '#00ffff'; ctx.shadowBlur = 22;
  ctx.fillStyle = 'rgba(0,255,220,0.55)';
  ctx.fillRect(0, GY - 5, W, 3);
  ctx.restore();
  // Secondary pink edge
  ctx.save();
  ctx.shadowColor = '#ff00cc'; ctx.shadowBlur = 12;
  ctx.fillStyle = 'rgba(255,0,180,0.25)';
  ctx.fillRect(0, GY - 3, W, 2);
  ctx.restore();
}

function drawHUD() {}

function drawBossHUD() {
  // Boss incoming announcement
  if (bossAnnounceTimer > 0) {
    const fadeIn  = Math.min(1, (210 - bossAnnounceTimer + 1) / 40);
    const fadeOut = Math.min(1, bossAnnounceTimer / 40);
    const a = Math.min(fadeIn, fadeOut);
    ctx.save();
    ctx.globalAlpha = a;
    ctx.textAlign = 'center';
    ctx.font = 'bold 52px Courier New';
    ctx.shadowColor = '#ff0000';
    ctx.shadowBlur = 30;
    ctx.fillStyle = '#ff3300';
    ctx.fillText('BOSS INCOMING!', canvas.width / 2, canvas.height / 2 - 20);
    ctx.font = 'bold 20px Courier New';
    ctx.fillStyle = '#ffcc00';
    ctx.shadowColor = '#ffcc00';
    ctx.shadowBlur = 16;
    ctx.fillText('DEFEAT THE MEGA BOSS!', canvas.width / 2, canvas.height / 2 + 20);
    ctx.restore();
  }

  // Boss HP bar (only while a live mega boss exists)
  const boss = zombies.find(z => (z.type === 'mega' || z.type === 'charBoss') && !z.dead);
  if (!boss) return;
  const barW = canvas.width - 80;
  const barH = 16;
  const bx = 40;
  const by = 42;
  ctx.save();
  ctx.fillStyle = 'rgba(0,0,0,0.72)';
  ctx.fillRect(bx - 6, by - 18, barW + 12, barH + 26);
  ctx.font = 'bold 11px Courier New';
  ctx.textAlign = 'left';
  ctx.fillStyle = '#ff4400';
  ctx.shadowColor = '#ff4400';
  ctx.shadowBlur = 8;
  ctx.fillText(boss.type === 'charBoss' ? (boss.charSkin === 'viper' ? 'VIPER' : 'ZIGGY KRAMER') : 'MEGA BOSS', bx, by - 4);
  ctx.textAlign = 'right';
  ctx.fillStyle = '#ffcc00';
  ctx.shadowColor = '#ffcc00';
  ctx.fillText(`${boss.hp} / ${boss.maxHp}`, bx + barW, by - 4);
  ctx.shadowBlur = 0;
  ctx.fillStyle = '#300000';
  ctx.fillRect(bx, by, barW, barH);
  const ratio = Math.max(0, boss.hp / boss.maxHp);
  const fg = ctx.createLinearGradient(bx, by, bx + barW, by);
  if (ratio > 0.5) {
    fg.addColorStop(0, '#ff4400'); fg.addColorStop(1, '#ffaa00');
  } else if (ratio > 0.25) {
    fg.addColorStop(0, '#cc0000'); fg.addColorStop(1, '#ff4400');
  } else {
    fg.addColorStop(0, '#880000'); fg.addColorStop(1, '#cc0000');
  }
  ctx.fillStyle = fg;
  ctx.fillRect(bx, by, barW * ratio, barH);
  ctx.strokeStyle = '#ff4400';
  ctx.lineWidth = 1;
  ctx.strokeRect(bx, by, barW, barH);
  ctx.textAlign = 'left';
  ctx.restore();
}

function drawFog() {
  if (dogFogAlpha <= 0) return;
  ctx.save();
  ctx.globalAlpha = dogFogAlpha * 0.62;
  ctx.fillStyle = '#06000f';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.globalAlpha = dogFogAlpha * 0.42;
  for (let _i = 0; _i < 5; _i++) {
    const _y = 55 + _i * 90 + Math.sin(frameCount * 0.007 + _i * 1.3) * 18;
    const _fg = ctx.createLinearGradient(0, _y-38, 0, _y+38);
    _fg.addColorStop(0, 'rgba(45,25,65,0)');
    _fg.addColorStop(0.5, 'rgba(45,25,65,0.75)');
    _fg.addColorStop(1, 'rgba(45,25,65,0)');
    ctx.fillStyle = _fg;
    ctx.fillRect(0, _y-38, canvas.width, 76);
  }
  ctx.restore();
}

// ── Main render ───────────────────────────────────────────────
function draw() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  drawBackground();
  drawFog();
  drawBlood();
  drawAmmoPickups();
  drawWeaponPickups();
  drawBullets();
  for (const z of zombies) drawZombie(z);
  drawPlayer();
  drawMuzzleFlash();
  drawGrenades();
  drawSlime();
  drawExplosions();
  drawParticles();
  drawLightning();
  drawHUD();
  drawBossHUD();
  if (gameState === 'paused') {
    ctx.save();
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.textAlign = 'center';
    ctx.fillStyle = '#ff4400';
    ctx.font = 'bold 52px "Courier New", monospace';
    ctx.fillText('PAUSED', canvas.width / 2, canvas.height / 2 - 12);
    ctx.fillStyle = '#aaa';
    ctx.font = '18px "Courier New", monospace';
    ctx.fillText('Press P or click ⏸ to resume', canvas.width / 2, canvas.height / 2 + 28);
    ctx.restore();
  }
}

// ── Game loop ─────────────────────────────────────────────────
function loop() {
  if (gameState !== 'paused') update();
  draw();
  requestAnimationFrame(loop);
}

// ── Init ──────────────────────────────────────────────────────
setChar('rambo');
showOverlay('ZOMBIE KILLER', 'Survive the zombie horde!', 'START GAME');
loop();
