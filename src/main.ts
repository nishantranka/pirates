import { Game, DIFFICULTIES, type DifficultyName } from './game';
import { Input } from './input';
import { MpSession, MAX_PLAYERS, crewColor, type LeaderboardEntry } from './multiplayer';
import { CODE_LENGTH, type LobbyPlayerInfo, type MpMode } from './net';
import { SAIL_TYPES, SHIP_TYPES, type ShipTypeName } from './ship';
import { createSounds } from './sounds';
import { haptic, requestGameFullscreen, touchActive } from './touchui';
import './style.css';

// Sound on/off, remembered across sessions. OFF by default — audio is opt-in;
// only an explicit unmute ('0') turns it on.
let muted = true;
try {
  muted = localStorage.getItem('pirates-muted') !== '0';
} catch {
  /* localStorage may be unavailable (e.g. private mode) */
}

// All cues are synthesized (see sounds.ts) — the old mp3 clips are gone.
const sounds = createSounds(() => muted);

// ── Canvas setup ──────────────────────────────────────────────────────────────

const canvas = document.getElementById('game') as HTMLCanvasElement;
const ctx = canvas.getContext('2d')!;

function resize() {
  // Render at native resolution (high-DPI aware) so the game is pixel-sharp on
  // scaled displays; capped at 2× to keep fill costs sane. Logic stays in CSS px.
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.round(window.innerWidth * dpr);
  canvas.height = Math.round(window.innerHeight * dpr);
  canvas.style.width = `${window.innerWidth}px`;
  canvas.style.height = `${window.innerHeight}px`;
  game.onResize(window.innerWidth, window.innerHeight);
}

// ── Game instance ─────────────────────────────────────────────────────────────

const input = new Input();
const game = new Game(ctx, input);
game.onCannonFire = sounds.fire;
game.onHit = (youWereHit: boolean) => {
  if (youWereHit) {
    sounds.getHit();
    haptic([30, 40, 30]);
  } else {
    sounds.myHit();
  }
};
game.start();
// Dev-only hook so E2E tests can observe practice mode; stripped in prod.
if (import.meta.env.DEV) (window as unknown as { __game: Game }).__game = game;

window.addEventListener('resize', resize);
resize();

// ── Constants ─────────────────────────────────────────────────────────────────

const SPEED_LABELS: Record<ShipTypeName, string> = {
  small: 'fast',
  medium: 'steady',
  large: 'slow',
  submarine: 'engine',
};

const NEXT_DIFFICULTY: Partial<Record<DifficultyName, DifficultyName>> = {
  easy: 'medium',
  medium: 'hard',
};

const DIFFICULTY_ORDER: DifficultyName[] = ['easy', 'medium', 'hard'];
const SHIP_ORDER: ShipTypeName[] = ['small', 'medium', 'large'];

// ── Selection state ───────────────────────────────────────────────────────────

type MenuPath = 'practice' | 'bots' | 'friends';
type PracticeMode = 'duel' | 'survivor' | 'base';
type RoomChoice = 'create' | 'join';

let selectedPath: MenuPath | null = null;
let selectedPractice: PracticeMode = 'duel';
let selectedShip: ShipTypeName = 'small';
let selectedEnemy: ShipTypeName | 'random' = 'random';
let selectedDifficulty: DifficultyName = 'easy';
let selectedArenaMode: MpMode = 'score';
let selectedBots = 10;
let selectedRoom: RoomChoice = 'create';

// Survivor wave state
let survivorDiffIndex = 0;
let survivorShipIndex = 0;
let survivorKills = 0;

const BOT_COUNTS = [5, 10, 15];

const pickOne = <T>(xs: readonly T[]): T => xs[Math.floor(Math.random() * xs.length)];

// ── Build selection cards ─────────────────────────────────────────────────────

function makeCard(label: string, stat: string, key: string, glyph?: string): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.className = 'card';
  btn.dataset.key = key;
  const body = `<div class="card-name">${label}</div><div class="card-stat">${stat}</div>`;
  btn.innerHTML = glyph ? `<span class="card-glyph">${glyph}</span><div>${body}</div>` : body;
  return btn;
}

function titleCase(s: string): string {
  return s[0].toUpperCase() + s.slice(1);
}

function selectCard(row: Element, key: string) {
  row.querySelectorAll('.card').forEach((c) =>
    c.classList.toggle('selected', (c as HTMLElement).dataset.key === key),
  );
}

const setSailBtn = document.getElementById('set-sail') as HTMLButtonElement;

// ── The muster: one question per screen ───────────────────────────────────────
// Each step owns a panel (#step-<id>) and, when it ends its path, the footer
// button. Picking a card is the "next" — only the launch needs a deliberate tap.

interface Step {
  id: string;
  /** Breadcrumb text for the answer given here. */
  crumb: () => string;
  /** Not asked for the current answers (Survivor picks its own enemies). */
  skip?: () => boolean;
  /** Footer button, when this step ends its path. */
  action?: () => { label: string; run: () => void };
}

const STEPS: Record<string, Step> = {
  ptype: {
    id: 'ptype',
    crumb: () => practiceOptions.find((p) => p.key === selectedPractice)?.label ?? selectedPractice,
  },
  ship: { id: 'ship', crumb: () => titleCase(selectedShip) },
  enemy: {
    id: 'enemy',
    crumb: () => `vs ${titleCase(selectedEnemy)}`,
    skip: () => selectedPractice === 'survivor',
  },
  difficulty: {
    id: 'difficulty',
    crumb: () => DIFFICULTIES[selectedDifficulty].label,
    action: () => ({ label: '⚓ Set Sail', run: setSail }),
  },
  bmode: {
    id: 'bmode',
    crumb: () => mpModeOptions.find((m) => m.key === selectedArenaMode)?.label ?? selectedArenaMode,
  },
  bcount: {
    id: 'bcount',
    crumb: () => `${selectedBots} bots`,
    action: () => ({ label: '⚓ Set Sail', run: startBotsArena }),
  },
  fhow: { id: 'fhow', crumb: () => (selectedRoom === 'create' ? 'Create' : 'Join') },
  fname: {
    id: 'fname',
    crumb: () => shipName(),
    action: () =>
      selectedRoom === 'create'
        ? { label: '🏴 Create Room', run: createRoom }
        : { label: '🧭 Join Room', run: joinRoom },
  },
};

const PATHS: Record<MenuPath, string[]> = {
  practice: ['ptype', 'ship', 'enemy', 'difficulty'],
  bots: ['bmode', 'ship', 'bcount'],
  friends: ['fhow', 'fname'],
};

const PATH_LABELS: Record<MenuPath, string> = {
  practice: 'Practice',
  bots: 'Bots Arena',
  friends: 'Friends',
};

const stepPanels = new Map<string, HTMLElement>(
  [...document.querySelectorAll<HTMLElement>('.step')].map((el) => [el.id.slice(5), el]),
);

const wizardBar = document.getElementById('wizard-bar')!;
const wizCrumbs = document.getElementById('wiz-crumbs')!;
const wizCount = document.getElementById('wiz-count')!;
const menuTitle = document.getElementById('menu-title')!;
const codeField = document.getElementById('code-field')!;
const menuHint = document.getElementById('menu-hint')!;
const CONTROLS_HINT = menuHint.textContent ?? '';

/** -1 is the title screen; otherwise an index into activeSteps(). */
let stepIndex = -1;
let footerAction: (() => void) | null = null;
/** Which panel was on screen last render — a change means we just navigated. */
let shownPanel = '';

function activeSteps(): Step[] {
  if (!selectedPath) return [];
  return PATHS[selectedPath].map((id) => STEPS[id]).filter((s) => !s.skip?.());
}

function renderMenu() {
  const steps = activeSteps();
  // An answer can retire a later step (Survivor drops "Enemy ship"), so the
  // index is clamped rather than trusted.
  if (stepIndex >= steps.length) stepIndex = steps.length - 1;
  const atRoot = !selectedPath || stepIndex < 0;
  const active = atRoot ? 'root' : steps[stepIndex].id;

  stepPanels.forEach((panel, id) => panel.classList.toggle('hidden', id !== active));
  menuTitle.classList.toggle('hidden', !atRoot);

  // Arriving at a step, nothing is highlighted — a card left looking "chosen"
  // reads as done, and you can't tell that tapping it is what moves you on.
  const panel = stepPanels.get(active)!;
  if (active !== shownPanel) {
    panel.querySelectorAll('.card.selected').forEach((c) => c.classList.remove('selected'));
    shownPanel = active;
  }
  wizardBar.classList.toggle('hidden', atRoot);
  wizCount.textContent = atRoot ? '' : `Step ${stepIndex + 1} of ${steps.length}`;
  if (active === 'fname') codeField.classList.toggle('hidden', selectedRoom !== 'join');

  // Breadcrumbs: the path, then every answer already given. Each one jumps back.
  wizCrumbs.replaceChildren();
  if (!atRoot && selectedPath) {
    wizCrumbs.appendChild(makeCrumb(PATH_LABELS[selectedPath], () => openMenu(null)));
    steps.slice(0, stepIndex).forEach((step, i) => {
      wizCrumbs.appendChild(makeCrumb(step.crumb(), () => showStep(i)));
    });
  }

  const action = atRoot ? undefined : steps[stepIndex].action?.();
  footerAction = action?.run ?? null;
  setSailBtn.classList.toggle('hidden', !action);
  if (action) setSailBtn.textContent = action.label;

  // The last step's cards gate its button: pick one, then launch.
  const needsPick = !!panel.querySelector('.card') && !panel.querySelector('.card.selected');
  setSailBtn.disabled = !!action && needsPick;
  menuHint.textContent = action && needsPick ? 'Pick one above to set sail' : CONTROLS_HINT;
}

function makeCrumb(text: string, onClick: () => void): HTMLButtonElement {
  const chip = document.createElement('button');
  chip.type = 'button';
  chip.className = 'crumb';
  chip.textContent = text;
  chip.addEventListener('click', onClick);
  return chip;
}

function showStep(index: number) {
  stepIndex = index;
  renderMenu();
}

/** Show the muster at a given step (no path = the title screen). */
function openMenu(path: MenuPath | null, index = 0) {
  selectedPath = path;
  stepIndex = path ? index : -1;
  menuOverlay.classList.remove('hidden');
  renderMenu();
}

function menuBack() {
  if (stepIndex <= 0) openMenu(null);
  else showStep(stepIndex - 1);
}

/** Record an answer and move on — the pick itself is the "next" button. */
function answer(row: Element, key: string, apply: () => void) {
  apply();
  selectCard(row, key);
  if (stepIndex >= 0 && stepIndex < activeSteps().length - 1) stepIndex++;
  renderMenu();
}

document.getElementById('wiz-back')!.addEventListener('click', menuBack);
setSailBtn.addEventListener('click', () => footerAction?.());

// Title screen: the ways to play, plus the one that skips every question.
const rootRow = document.getElementById('root-cards')!;
const rootOptions: Array<{ key: MenuPath | 'lucky'; glyph: string; label: string; stat: string }> = [
  { key: 'practice', glyph: '⚔️', label: 'Practice', stat: 'one-on-one against a bot' },
  { key: 'bots', glyph: '🤖', label: 'Bots Arena', stat: 'free-for-all against a fleet of bots' },
  { key: 'friends', glyph: '🏴', label: 'Play with Friends', stat: 'create a room or join with a code' },
  { key: 'lucky', glyph: '🎲', label: "I'm Feeling Lucky", stat: 'a random arena — sails at once' },
];
rootOptions.forEach(({ key, glyph, label, stat }) => {
  const card = makeCard(label, stat, key, glyph);
  card.addEventListener('click', () => (key === 'lucky' ? feelingLucky() : openMenu(key)));
  rootRow.appendChild(card);
});

/** Roll a whole Bots Arena — win condition, hull, fleet size — and sail. */
function feelingLucky() {
  selectedPath = 'bots';
  selectedArenaMode = pickOne<MpMode>(['score', 'survival', 'base']);
  selectedShip = pickOne(Object.keys(SHIP_TYPES) as ShipTypeName[]);
  selectedBots = pickOne(BOT_COUNTS);
  startBotsArena();
}

// Practice sub-modes: a single duel, endless survivor waves, or a siege on
// each other's base — all vs bot AI.
const ptypeRow = document.getElementById('ptype-cards')!;
const practiceOptions: Array<{ key: PracticeMode; label: string; stat: string }> = [
  { key: 'duel', label: '1v1', stat: 'one battle · win or lose' },
  { key: 'survivor', label: 'Survivor', stat: 'endless waves · fight until you sink' },
  { key: 'base', label: 'Destroy Base', stat: 'sinking just sends you home — wreck their base' },
];
practiceOptions.forEach(({ key, label, stat }) => {
  const card = makeCard(label, stat, key);
  card.addEventListener('click', () => answer(ptypeRow, key, () => (selectedPractice = key)));
  ptypeRow.appendChild(card);
});

/** Card stat line for a hull (submarine gets its own blurb). */
function shipStat(type: ShipTypeName): string {
  const s = SHIP_TYPES[type];
  return type === 'submarine'
    ? `torpedo · dives · ${s.maxHealth} hp`
    : `${s.guns} guns · ${SPEED_LABELS[type]} · ${s.maxHealth} hp`;
}

// Your ship — all hulls, submarine included. Shared by Practice and Bots Arena.
const shipRow = document.getElementById('ship-cards')!;
(Object.keys(SHIP_TYPES) as ShipTypeName[]).forEach((type) => {
  const card = makeCard(titleCase(type), shipStat(type), type);
  card.addEventListener('click', () => answer(shipRow, type, () => (selectedShip = type)));
  shipRow.appendChild(card);
});

// Enemy ship cards (includes Random; the enemy AI stays on sailing hulls)
const enemyRow = document.getElementById('enemy-cards')!;
SAIL_TYPES.forEach((type) => {
  const card = makeCard(titleCase(type), shipStat(type), type);
  card.addEventListener('click', () => answer(enemyRow, type, () => (selectedEnemy = type)));
  enemyRow.appendChild(card);
});
const randomCard = makeCard('Random', 'any of the three', 'random');
randomCard.addEventListener('click', () => answer(enemyRow, 'random', () => (selectedEnemy = 'random')));
enemyRow.appendChild(randomCard);

// Difficulty cards
const diffRow = document.getElementById('difficulty-cards')!;
(Object.keys(DIFFICULTIES) as DifficultyName[]).forEach((name) => {
  const blurbs: Record<DifficultyName, string> = {
    easy: 'slow reload · aims at you',
    medium: 'faster reload · leads shots',
    hard: 'same reload · leads shots · sails wind',
  };
  const card = makeCard(DIFFICULTIES[name].label, blurbs[name], name);
  card.addEventListener('click', () => answer(diffRow, name, () => (selectedDifficulty = name)));
  diffRow.appendChild(card);
});

// ── Bots Arena cards ──────────────────────────────────────────────────────────

// The win condition — the same three the lobby offers, asked up front instead.
const mpModeOptions: Array<{ key: MpMode; label: string; stat: string }> = [
  { key: 'score', label: 'Leaderboard', stat: '90s deathmatch · respawns' },
  { key: 'survival', label: 'Survivor', stat: 'last one standing wins' },
  { key: 'base', label: 'Destroy Base', stat: "wreck every rival's base" },
];

const bmodeRow = document.getElementById('bmode-cards')!;
mpModeOptions.forEach(({ key, label, stat }) => {
  const card = makeCard(label, stat, key);
  card.addEventListener('click', () => answer(bmodeRow, key, () => (selectedArenaMode = key)));
  bmodeRow.appendChild(card);
});

const bcountRow = document.getElementById('bcount-cards')!;
const botBlurbs = ['a quick skirmish', 'a proper brawl', 'full armada chaos'];
BOT_COUNTS.forEach((n, i) => {
  const card = makeCard(`${n} Bots`, botBlurbs[i], String(n));
  card.addEventListener('click', () => answer(bcountRow, String(n), () => (selectedBots = n)));
  bcountRow.appendChild(card);
});

// ── Play with Friends cards ───────────────────────────────────────────────────

const fhowRow = document.getElementById('fhow-cards')!;
const roomOptions: Array<{ key: RoomChoice; glyph: string; label: string; stat: string }> = [
  { key: 'create', glyph: '🏴', label: 'Create a Room', stat: "you're the host — share a 5-letter code" },
  { key: 'join', glyph: '🧭', label: 'Join a Room', stat: 'got a code from a friend?' },
];
roomOptions.forEach(({ key, glyph, label, stat }) => {
  const card = makeCard(label, stat, key, glyph);
  card.addEventListener('click', () => answer(fhowRow, key, () => (selectedRoom = key)));
  fhowRow.appendChild(card);
});

// ── Overlay refs ──────────────────────────────────────────────────────────────

const menuOverlay = document.getElementById('menu-overlay')!;
const gameoverOverlay = document.getElementById('gameover-overlay')!;
const gameoverTitle = document.getElementById('gameover-title')!;
const btnReplay = document.getElementById('btn-replay')!;
const btnHarder = document.getElementById('btn-harder')!;
const harderLabel = document.getElementById('harder-label')!;
const btnMenu = document.getElementById('btn-menu')!;

// ── Set Sail ──────────────────────────────────────────────────────────────────

function startSurvivor() {
  survivorDiffIndex = DIFFICULTY_ORDER.indexOf(selectedDifficulty);
  survivorShipIndex = 0;
  survivorKills = 0;
  game.survivorKills = 0;
  game.startBattle(selectedShip, SHIP_ORDER[0], DIFFICULTY_ORDER[survivorDiffIndex]);
}

function setSail() {
  menuOverlay.classList.add('hidden');
  if (selectedPractice === 'survivor') {
    startSurvivor();
  } else {
    game.survivorKills = null;
    game.startBattle(selectedShip, selectedEnemy, selectedDifficulty, selectedPractice === 'base');
  }
}

// ── Game-over handling ────────────────────────────────────────────────────────

game.onGameOver = (won: boolean) => {
  if (won) sounds.kill();
  else sounds.sunk();
  if (selectedPractice === 'survivor') {
    if (won) {
      // Enemy sunk — spawn the next wave without showing the game-over overlay.
      survivorKills++;
      survivorShipIndex++;
      if (survivorShipIndex >= SHIP_ORDER.length) {
        survivorShipIndex = 0;
        survivorDiffIndex = Math.min(survivorDiffIndex + 1, DIFFICULTY_ORDER.length - 1);
      }
      const nextType = SHIP_ORDER[survivorShipIndex];
      const nextDiff = DIFFICULTY_ORDER[survivorDiffIndex];
      game.survivorKills = survivorKills;
      game.spawnNextEnemy(nextType, nextDiff);
      return;
    }
    // Player died in survivor mode.
    const n = survivorKills;
    gameoverTitle.textContent = `You sunk ${n} ship${n !== 1 ? 's' : ''} before going down!`;
    btnHarder.classList.add('hidden');
    btnMenu.classList.remove('hidden');
  } else {
    // Normal mode and Destroy Base — a single win/loss ends the duel either way.
    gameoverTitle.textContent =
      selectedPractice === 'base'
        ? won
          ? '🏰 Enemy base destroyed!'
          : '💀 Your base was destroyed!'
        : won
          ? 'Enemy ship destroyed!'
          : 'Your ship was destroyed!';
    const nextDiff = NEXT_DIFFICULTY[selectedDifficulty];
    if (nextDiff) {
      harderLabel.textContent = DIFFICULTIES[nextDiff].label;
      btnHarder.classList.remove('hidden');
    } else {
      btnHarder.classList.add('hidden');
    }
    btnMenu.classList.add('hidden');
  }

  gameoverOverlay.classList.remove('hidden');
};

btnReplay.addEventListener('click', () => {
  gameoverOverlay.classList.add('hidden');
  if (selectedPractice === 'survivor') {
    startSurvivor();
  } else {
    game.startBattle(selectedShip, selectedEnemy, selectedDifficulty, selectedPractice === 'base');
  }
});

btnHarder.addEventListener('click', () => {
  const nextDiff = NEXT_DIFFICULTY[selectedDifficulty];
  if (nextDiff) {
    selectedDifficulty = nextDiff;
    selectCard(diffRow, selectedDifficulty);
  }
  gameoverOverlay.classList.add('hidden');
  game.startBattle(selectedShip, selectedEnemy, selectedDifficulty, selectedPractice === 'base');
});

btnMenu.addEventListener('click', () => {
  gameoverOverlay.classList.add('hidden');
  openMenu(null);
});

// R key: Play Again (works in both modes).
window.addEventListener('keydown', (e) => {
  if (e.code === 'KeyR' && !gameoverOverlay.classList.contains('hidden')) {
    gameoverOverlay.classList.add('hidden');
    if (selectedPractice === 'survivor') {
      startSurvivor();
    } else {
      game.startBattle(selectedShip, selectedEnemy, selectedDifficulty, selectedPractice === 'base');
    }
  }
});

// ── Multiplayer ───────────────────────────────────────────────────────────────

const mpNameInput = document.getElementById('mp-name') as HTMLInputElement;
const mpCodeInput = document.getElementById('mp-code') as HTMLInputElement;
const mpStatus = document.getElementById('mp-status')!;

const lobbyOverlay = document.getElementById('lobby-overlay')!;
const roomCodeEl = document.getElementById('room-code')!;
const roomCodeLabel = document.getElementById('room-code-label')!;
const roomCodeBlock = document.getElementById('room-code-block')!;
const copyLinkBtn = document.getElementById('copy-link') as HTMLButtonElement;
let currentRoomCode = '';
const lobbyPlayersEl = document.getElementById('lobby-players')!;
const lobbyShipRow = document.getElementById('lobby-ship-cards')!;
const btnReady = document.getElementById('btn-ready') as HTMLButtonElement;
const btnAddBot = document.getElementById('btn-addbot') as HTMLButtonElement;
const btnFillBots = document.getElementById('btn-fillbots') as HTMLButtonElement;
const btnMoreBots = document.getElementById('btn-morebots') as HTMLButtonElement;
const btnStart = document.getElementById('btn-start') as HTMLButtonElement;
const btnLeave = document.getElementById('btn-leave')!;

const mpendOverlay = document.getElementById('mpend-overlay')!;
const mpendTitle = document.getElementById('mpend-title')!;
const mpendBoard = document.getElementById('mpend-board')!;
const btnRematch = document.getElementById('btn-rematch')!;
const btnToLobby = document.getElementById('btn-tolobby')!;
const btnMpLeave = document.getElementById('btn-mpleave')!;
const mpendWait = document.getElementById('mpend-wait')!;

let mp: MpSession | null = null;
let myReady = false;
let myShip: ShipTypeName = 'small';
// Bot count while a Bots Arena game is being launched — non-null means "skip
// the lobby entirely", which also relabels the end screen's lobby button.
let arenaBots: number | null = null;

// Battle-mode cards inside the lobby — the host picks the win condition.
const lobbyModeRow = document.getElementById('lobby-mode-cards')!;
mpModeOptions.forEach(({ key, label, stat }) => {
  const card = makeCard(label, stat, key);
  card.addEventListener('click', () => mp?.setMode(key)); // no-op for guests
  lobbyModeRow.appendChild(card);
});

// Ship cards inside the lobby — each captain picks their own boat.
(Object.keys(SHIP_TYPES) as ShipTypeName[]).forEach((type) => {
  const card = makeCard(titleCase(type), shipStat(type), type);
  card.addEventListener('click', () => {
    myShip = type;
    selectCard(lobbyShipRow, type);
    mp?.setShip(type);
  });
  lobbyShipRow.appendChild(card);
});

function renderLobby(players: LobbyPlayerInfo[], you: number, canStart: boolean, mode: MpMode) {
  // A Bots Arena fleet has no room anyone can join, so there's no code to show
  // — and a permanent "connecting…" would just look broken.
  roomCodeBlock.classList.toggle('hidden', arenaBots !== null);
  selectCard(lobbyModeRow, mode);
  lobbyPlayersEl.innerHTML = '';
  players.forEach((p, i) => {
    const row = document.createElement('div');
    row.className = 'lobby-player' + (i === you ? ' you' : '');

    const dot = document.createElement('span');
    dot.className = 'dot';
    dot.style.background = crewColor(i, players);

    const name = document.createElement('span');
    name.className = 'pname';
    name.textContent =
      p.name + (p.bot ? ' 🤖' : '') + (i === you ? ' (you)' : '') + (i === 0 ? ' ⚓' : '');

    const ship = document.createElement('span');
    ship.className = 'pship';
    ship.textContent = `${p.ship === 'submarine' ? '🤿' : '⛵'} ${p.ship}`;

    const ready = document.createElement('span');
    ready.className = 'pready' + (p.ready ? ' is-ready' : '');
    ready.textContent = p.ready ? 'READY' : 'waiting';

    row.append(dot, name, ship, ready);

    // Host can dismiss bots.
    if (p.bot && (mp?.isHost ?? false)) {
      const kick = document.createElement('button');
      kick.className = 'pkick';
      kick.textContent = '✕';
      kick.title = 'Dismiss bot';
      kick.addEventListener('click', () => mp?.removeBot(i));
      row.appendChild(kick);
    }

    lobbyPlayersEl.appendChild(row);
  });

  // Mirror our own state (authoritative from the host).
  const me = players[you];
  if (me) {
    myReady = me.ready;
    myShip = me.ship;
    selectCard(lobbyShipRow, myShip);
  }
  btnReady.textContent = myReady ? 'Not Ready' : "I'm Ready";
  btnReady.classList.toggle('armed', myReady);

  const isHost = mp?.isHost ?? false;
  btnStart.classList.toggle('hidden', !isHost);
  btnStart.disabled = !canStart;
  btnAddBot.classList.toggle('hidden', !isHost);
  btnAddBot.disabled = players.length >= MAX_PLAYERS;
  btnFillBots.classList.toggle('hidden', !isHost);
  btnFillBots.disabled = players.length >= MAX_PLAYERS;
  btnMoreBots.classList.toggle('hidden', !isHost);
  btnMoreBots.disabled = players.length >= MAX_PLAYERS;

  const lobbyStatus = document.getElementById('lobby-status')!;
  const readyCount = players.filter((p) => p.ready).length;
  if (players.length < 2) {
    lobbyStatus.textContent = isHost
      ? 'Waiting for ships — invite friends or add bots…'
      : 'Waiting for at least one more ship…';
  } else if (readyCount < players.length) {
    // Ready is advisory — the host can launch anyway and stragglers sail in as-is.
    lobbyStatus.textContent = isHost
      ? `${readyCount} of ${players.length} ready — start anyway and the rest sail in as-is.`
      : `${readyCount} of ${players.length} ready — the host can start at any time.`;
  } else {
    lobbyStatus.textContent = isHost ? 'All hands ready — start when you like!' : 'All ready — the host can start.';
  }
}

function endMpSession(errorMessage?: string) {
  const wasArena = arenaBots !== null;
  mp?.leave();
  mp = null;
  arenaBots = null;
  myReady = false;
  game.suspended = false;
  lobbyOverlay.classList.add('hidden');
  mpendOverlay.classList.add('hidden');
  setSailBtn.disabled = false;
  // Back to the step that owns this kind of game — with an error to read, land
  // on the name/code screen where it can be acted on.
  if (wasArena) openMenu('bots');
  else openMenu('friends', errorMessage ? 1 : 0);
  mpStatus.textContent = errorMessage ?? '';
}

function mpCallbacks() {
  return {
    onRoomReady(code: string) {
      mpStatus.textContent = '';
      currentRoomCode = code;
      roomCodeEl.textContent = code || 'connecting…';
      roomCodeLabel.textContent = code
        ? 'Room code — share it with your crew'
        : 'Room code';
      copyLinkBtn.classList.toggle('hidden', !code);
      if (arenaBots !== null) {
        // Bots Arena: the lobby has nothing left to ask, so stock it and sail.
        mp?.setMode(selectedArenaMode);
        mp?.setShip(selectedShip);
        mp?.fillBots(arenaBots);
        mp?.startBattle();
        return;
      }
      menuOverlay.classList.add('hidden');
      lobbyOverlay.classList.remove('hidden');
      setSailBtn.disabled = false;
    },
    onRoomCode(code: string | null) {
      currentRoomCode = code ?? '';
      if (arenaBots !== null) return; // no lobby to update, no code to share
      copyLinkBtn.classList.toggle('hidden', !code);
      if (code) {
        roomCodeEl.textContent = code;
        roomCodeLabel.textContent = 'Room code — share it with your crew';
      } else {
        // Broker unreachable — solo/bot play still works, just no remote joiners.
        roomCodeEl.textContent = 'OFFLINE';
        roomCodeLabel.textContent = 'No connection — add bots to play';
      }
    },
    onLobby(players: LobbyPlayerInfo[], you: number, canStart: boolean, mode: MpMode) {
      renderLobby(players, you, canStart, mode);
    },
    onStart() {
      // Hosts reach here inside the Start Battle tap, so the fullscreen +
      // landscape request can succeed; for guests (no gesture) it's a no-op.
      // Gated on actual touch use so a touchscreen laptop played with the
      // keyboard stays windowed like any other desktop.
      if (touchActive()) void requestGameFullscreen();
      // Late joiners drop straight from the menu into a running battle, so
      // clear the menu/status too — not just the lobby overlays.
      menuOverlay.classList.add('hidden');
      lobbyOverlay.classList.add('hidden');
      mpendOverlay.classList.add('hidden');
      mpStatus.textContent = '';
      setSailBtn.disabled = false;
      game.suspended = true;
    },
    onEnd(winnerName: string | null) {
      const gameMode = mp?.gameMode;
      mpendTitle.textContent = winnerName
        ? gameMode === 'survival'
          ? `⏱️ ${winnerName} outlasted them all!`
          : gameMode === 'base'
            ? `🏰 ${winnerName}'s base stands victorious!`
            : `☠️ ${winnerName} rules the seas!`
        : 'Mutual destruction — a draw!';
      // Final standings on the end screen.
      const board = mp?.getLeaderboard() ?? [];
      mpendBoard.replaceChildren(...board.map((e, i) => renderLbRow(e, i + 1, true)));
      const isHost = mp?.isHost ?? false;
      btnRematch.classList.toggle('hidden', !isHost);
      // In an arena the lobby is a screen the player never saw — it's where you
      // go to pick a different hull, so name it that.
      btnToLobby.textContent = arenaBots !== null ? 'Change Ship' : 'Back to Lobby';
      btnToLobby.classList.toggle('hidden', !isHost);
      mpendWait.classList.toggle('hidden', isHost);
      mpendOverlay.classList.remove('hidden');
    },
    onToLobby() {
      mpendOverlay.classList.add('hidden');
      game.suspended = false;
      lobbyOverlay.classList.remove('hidden');
      // "Change Ship" promises the hull picker, so put it on screen rather than
      // leaving it below a long roster.
      if (arenaBots !== null) {
        lobbyShipRow.scrollIntoView({ block: 'center', behavior: 'smooth' });
      }
    },
    onError(message: string) {
      endMpSession(message);
    },
  };
}

// Pre-fill the name box: the remembered name, else a random hull suggestion —
// so blank joins (which used to leave everyone named "Captain") are rare. The
// host still de-dupes clashes into "Name 2", "Name 3", …
const SHIP_NAME_IDEAS = [
  'Sea Wolf',
  'Black Sails',
  'Storm Rider',
  'Wave Dancer',
  'Tide Turner',
  'Coral Queen',
  'Salt Serpent',
  'Iron Gull',
  'Night Tern',
  'Red Kraken',
  'Gale Runner',
  'Bone Lantern',
];
try {
  mpNameInput.value = localStorage.getItem('pirates-name') ?? '';
} catch {
  /* ignore */
}
if (!mpNameInput.value) {
  mpNameInput.value = SHIP_NAME_IDEAS[Math.floor(Math.random() * SHIP_NAME_IDEAS.length)];
}

/** The ship's name, never blank — Bots Arena never asks for one. */
function shipName(): string {
  return mpNameInput.value.trim() || SHIP_NAME_IDEAS[0];
}

/** Remember the ship's name so invite links can auto-join next time. */
function rememberName() {
  const n = mpNameInput.value.trim();
  if (!n) return;
  try {
    localStorage.setItem('pirates-name', n);
  } catch {
    /* ignore */
  }
}

function createRoom() {
  if (mp) return;
  rememberName();
  mpStatus.textContent = 'Opening room…';
  setSailBtn.disabled = true;
  mp = MpSession.host(shipName(), ctx, input, mpCallbacks(), sounds);
  // Dev-only hook so E2E tests can observe the session; stripped in prod.
  if (import.meta.env.DEV) (window as unknown as { __mp: MpSession }).__mp = mp;
}

function joinRoom() {
  if (mp) return;
  const code = mpCodeInput.value.toUpperCase().trim();
  if (code.length !== CODE_LENGTH) {
    mpStatus.textContent = `Room codes are ${CODE_LENGTH} characters.`;
    return;
  }
  rememberName();
  mpStatus.textContent = 'Joining…';
  setSailBtn.disabled = true;
  mp = MpSession.join(code, shipName(), ctx, input, mpCallbacks(), sounds);
}

/** Bots Arena: host a room only we will ever see, stock it, and start. */
function startBotsArena() {
  if (mp) return;
  arenaBots = selectedBots;
  mpStatus.textContent = '';
  setSailBtn.disabled = true;
  mp = MpSession.host(shipName(), ctx, input, mpCallbacks(), sounds);
  if (import.meta.env.DEV) (window as unknown as { __mp: MpSession }).__mp = mp;
}

// Enter in either field is the same as pressing the footer button.
mpCodeInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') setSailBtn.click();
});
mpNameInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') setSailBtn.click();
});

// Copy a clickable invite link — opening it joins this room directly.
copyLinkBtn.addEventListener('click', async () => {
  if (!currentRoomCode) return;
  const url = `${location.origin}${location.pathname}#room=${currentRoomCode}`;
  try {
    await navigator.clipboard.writeText(url);
    copyLinkBtn.textContent = '✅ Link copied!';
  } catch {
    copyLinkBtn.textContent = url; // clipboard blocked — show it for manual copy
  }
  setTimeout(() => {
    copyLinkBtn.textContent = '🔗 Copy invite link';
  }, 2200);
});

btnReady.addEventListener('click', () => {
  myReady = !myReady;
  btnReady.textContent = myReady ? 'Not Ready' : "I'm Ready";
  btnReady.classList.toggle('armed', myReady);
  mp?.setReady(myReady);
});

btnAddBot.addEventListener('click', () => mp?.addBot());
btnFillBots.addEventListener('click', () => mp?.fillBots(9)); // a quick 10-captain brawl
btnMoreBots.addEventListener('click', () => mp?.fillBots(10)); // pile on, up to the 21 cap
btnStart.addEventListener('click', () => mp?.startBattle());
btnLeave.addEventListener('click', () => endMpSession());
btnRematch.addEventListener('click', () => mp?.rematch());
btnToLobby.addEventListener('click', () => mp?.backToLobby());
btnMpLeave.addEventListener('click', () => endMpSession());

// ── Live leaderboard (collapsible) ────────────────────────────────────────────

const leaderboardEl = document.getElementById('leaderboard')!;
const lbToggle = document.getElementById('lb-toggle')!;
const lbToggleText = document.getElementById('lb-toggle-text')!;
const lbBody = document.getElementById('lb-body')!;
let lbExpanded = false;

lbToggle.addEventListener('click', () => {
  lbExpanded = !lbExpanded;
  lbBody.classList.toggle('hidden', !lbExpanded);
  updateLeaderboard();
});

/** `uniform` is the end-of-battle board: a final ranking, where being afloat
 *  at the last tick is not a distinction worth colouring. Crew colours, the
 *  dead fade and the ☠ all belong to the live board, which you read mid-fight
 *  to tell ships apart. */
function renderLbRow(e: LeaderboardEntry, rank: number, uniform = false): HTMLElement {
  const row = document.createElement('div');
  row.className = 'lb-row' + (e.you ? ' you' : '') + (e.alive || uniform ? '' : ' dead');

  const rankEl = document.createElement('span');
  rankEl.className = 'lb-rank';
  rankEl.textContent = String(rank);

  const dot = document.createElement('span');
  dot.className = 'lb-dot';
  if (!uniform) dot.style.background = e.color;

  const name = document.createElement('span');
  name.className = 'lb-name';
  name.textContent = e.name + (e.you ? ' (you)' : '') + (e.alive || uniform ? '' : ' ☠');

  const kills = document.createElement('span');
  kills.className = 'lb-kills';
  kills.textContent = `${e.kills}⚔`;

  const score = document.createElement('span');
  score.className = 'lb-score';
  score.textContent = String(e.score);

  row.append(rankEl, dot, name, kills, score);
  return row;
}

function updateLeaderboard() {
  if (!mp || !mp.inBattle) {
    leaderboardEl.classList.add('hidden');
    return;
  }
  const entries = mp.getLeaderboard();
  if (!entries.length) {
    leaderboardEl.classList.add('hidden');
    return;
  }
  leaderboardEl.classList.remove('hidden');

  const leader = entries[0];
  lbToggleText.textContent = lbExpanded ? '🏆 Standings ▾' : `🏆 ${leader.name} · ${leader.score} ▸`;

  if (lbExpanded) {
    lbBody.replaceChildren(...entries.map((e, i) => renderLbRow(e, i + 1)));
  }
}

// Refresh a few times a second — cheap, and the standings don't need 60 fps.
setInterval(updateLeaderboard, 400);

// ── Mute toggle ───────────────────────────────────────────────────────────────

const muteBtn = document.getElementById('mute-toggle')!;
function updateMuteBtn() {
  muteBtn.textContent = muted ? '🔇' : '🔊';
  muteBtn.title = muted ? 'Unmute (M)' : 'Mute (M)';
}
function toggleMute() {
  muted = !muted;
  try {
    localStorage.setItem('pirates-muted', muted ? '1' : '0');
  } catch {
    /* ignore */
  }
  updateMuteBtn();
}
muteBtn.addEventListener('click', toggleMute);
window.addEventListener('keydown', (e) => {
  if (e.code === 'KeyM' && !(e.target instanceof HTMLInputElement)) toggleMute();
});
updateMuteBtn();

// ── How to play (rules) overlay ───────────────────────────────────────────────

const rulesOverlay = document.getElementById('rules-overlay')!;
const helpBtn = document.getElementById('help-toggle')!;
const rulesClose = document.getElementById('rules-close')!;

helpBtn.addEventListener('click', () => rulesOverlay.classList.toggle('hidden'));
rulesClose.addEventListener('click', () => rulesOverlay.classList.add('hidden'));
// Escape closes the rules if they're up, otherwise it's the muster's Back.
window.addEventListener('keydown', (e) => {
  if (e.code !== 'Escape') return;
  if (!rulesOverlay.classList.contains('hidden')) {
    rulesOverlay.classList.add('hidden');
  } else if (!menuOverlay.classList.contains('hidden')) {
    menuBack();
  }
});

// ── Open the muster ───────────────────────────────────────────────────────────

openMenu(null);

// ── Invite links ──────────────────────────────────────────────────────────────
// Opening .../#room=ABCDE jumps straight into that room: auto-join if we know
// the player's name from a previous session, otherwise prefill the code and
// let them type a name + press Enter.

(function handleInviteLink() {
  const m = /(?:^|[#&?])room=([A-Za-z0-9]+)/i.exec(location.hash || location.search);
  const code = m?.[1]?.toUpperCase() ?? '';
  if (code.length !== CODE_LENGTH) return;

  // Consume the hash so a later refresh doesn't silently re-join.
  history.replaceState(null, '', location.pathname + location.search);

  // Straight to the join step, code already filled in.
  selectedRoom = 'join';
  selectCard(fhowRow, 'join');
  mpCodeInput.value = code;
  openMenu('friends', 1);

  let savedName = '';
  try {
    savedName = localStorage.getItem('pirates-name') ?? '';
  } catch {
    /* ignore */
  }
  if (savedName) {
    mpNameInput.value = savedName;
    joinRoom(); // straight into the lobby
  } else {
    mpStatus.textContent = `You're invited to room ${code} — name your ship to join!`;
    mpNameInput.focus();
  }
})();
