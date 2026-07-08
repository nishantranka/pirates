import { Game, DIFFICULTIES, type DifficultyName } from './game';
import { Input } from './input';
import { MpSession } from './multiplayer';
import { CODE_LENGTH, type LobbyPlayerInfo } from './net';
import { SHIP_TYPES, type ShipTypeName } from './ship';
import './style.css';

// Preload a sound and return a function that plays a fresh clone each call
// (cloning lets multiple instances overlap, e.g. several explosions at once).
function makeSound(url: string): () => void {
  const audio = new Audio(url);
  audio.preload = 'auto';
  return () => {
    const clone = audio.cloneNode() as HTMLAudioElement;
    clone.play().catch(() => {});
  };
}

const playCannonFire = makeSound('./cannon.mp3');
const playExplosion = makeSound('./explosion.mp3');

// ── Canvas setup ──────────────────────────────────────────────────────────────

const canvas = document.getElementById('game') as HTMLCanvasElement;
const ctx = canvas.getContext('2d')!;

function resize() {
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
  game.onResize(canvas.width, canvas.height);
}

// ── Game instance ─────────────────────────────────────────────────────────────

const input = new Input();
const game = new Game(ctx, input);
game.onCannonFire = playCannonFire;
game.onHit = playExplosion;
game.start();

window.addEventListener('resize', resize);
resize();

// ── Constants ─────────────────────────────────────────────────────────────────

const SPEED_LABELS: Record<ShipTypeName, string> = {
  small: 'fast',
  medium: 'steady',
  large: 'slow',
};

const NEXT_DIFFICULTY: Partial<Record<DifficultyName, DifficultyName>> = {
  easy: 'medium',
  medium: 'hard',
};

const DIFFICULTY_ORDER: DifficultyName[] = ['easy', 'medium', 'hard'];
const SHIP_ORDER: ShipTypeName[] = ['small', 'medium', 'large'];

// ── Selection state ───────────────────────────────────────────────────────────

type GameMode = 'normal' | 'survivor' | 'multiplayer';
let selectedMode: GameMode = 'normal';
let selectedPlayer: ShipTypeName = 'small';
let selectedEnemy: ShipTypeName | 'random' = 'random';
let selectedDifficulty: DifficultyName = 'easy';

// Survivor wave state
let survivorDiffIndex = 0;
let survivorShipIndex = 0;
let survivorKills = 0;

// ── Build selection cards ─────────────────────────────────────────────────────

function makeCard(label: string, stat: string, key: string): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.className = 'card';
  btn.dataset.key = key;
  btn.innerHTML = `<div class="card-name">${label}</div><div class="card-stat">${stat}</div>`;
  return btn;
}

function selectCard(row: Element, key: string) {
  row.querySelectorAll('.card').forEach((c) =>
    c.classList.toggle('selected', (c as HTMLElement).dataset.key === key),
  );
}

// Game mode cards
const modeRow = document.getElementById('mode-cards')!;
const enemySection = document.getElementById('enemy-section')!;
const playerSection = document.getElementById('player-section')!;
const difficultySection = document.getElementById('difficulty-section')!;
const mpSection = document.getElementById('mp-section')!;
const setSailBtn = document.getElementById('set-sail')!;

const modeOptions: Array<{ key: GameMode; label: string; stat: string }> = [
  { key: 'normal', label: 'Normal', stat: 'one battle · win or lose' },
  { key: 'survivor', label: 'Survivor', stat: 'fight until you sink' },
  { key: 'multiplayer', label: 'Multiplayer', stat: 'up to 4 players · online' },
];

modeOptions.forEach(({ key, label, stat }) => {
  const card = makeCard(label, stat, key);
  card.addEventListener('click', () => {
    selectedMode = key;
    selectCard(modeRow, key);
    updateModeUI();
  });
  modeRow.appendChild(card);
});

selectCard(modeRow, selectedMode);

function updateModeUI() {
  const mp = selectedMode === 'multiplayer';
  playerSection.classList.toggle('hidden', mp);
  difficultySection.classList.toggle('hidden', mp);
  enemySection.classList.toggle('hidden', mp || selectedMode === 'survivor');
  mpSection.classList.toggle('hidden', !mp);
  setSailBtn.classList.toggle('hidden', mp);
}

// Player ship cards
const playerRow = document.getElementById('player-cards')!;
(Object.keys(SHIP_TYPES) as ShipTypeName[]).forEach((type) => {
  const s = SHIP_TYPES[type];
  const card = makeCard(
    type[0].toUpperCase() + type.slice(1),
    `${s.guns} guns · ${SPEED_LABELS[type]} · ${s.maxHealth} hp`,
    type,
  );
  card.addEventListener('click', () => {
    selectedPlayer = type;
    selectCard(playerRow, type);
  });
  playerRow.appendChild(card);
});
selectCard(playerRow, selectedPlayer);

// Enemy ship cards (includes Random)
const enemyRow = document.getElementById('enemy-cards')!;
(Object.keys(SHIP_TYPES) as ShipTypeName[]).forEach((type) => {
  const s = SHIP_TYPES[type];
  const card = makeCard(
    type[0].toUpperCase() + type.slice(1),
    `${s.guns} guns · ${SPEED_LABELS[type]} · ${s.maxHealth} hp`,
    type,
  );
  card.addEventListener('click', () => {
    selectedEnemy = type;
    selectCard(enemyRow, type);
  });
  enemyRow.appendChild(card);
});
const randomCard = makeCard('Random', 'any of the three', 'random');
randomCard.addEventListener('click', () => {
  selectedEnemy = 'random';
  selectCard(enemyRow, 'random');
});
enemyRow.appendChild(randomCard);
selectCard(enemyRow, selectedEnemy);

// Difficulty cards
const diffRow = document.getElementById('difficulty-cards')!;
(Object.keys(DIFFICULTIES) as DifficultyName[]).forEach((name) => {
  const blurbs: Record<DifficultyName, string> = {
    easy: 'slow reload · aims at you',
    medium: 'faster reload · leads shots',
    hard: 'same reload · leads shots · sails wind',
  };
  const card = makeCard(DIFFICULTIES[name].label, blurbs[name], name);
  card.addEventListener('click', () => {
    selectedDifficulty = name;
    selectCard(diffRow, name);
  });
  diffRow.appendChild(card);
});
selectCard(diffRow, selectedDifficulty);

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
  game.startBattle(selectedPlayer, SHIP_ORDER[0], DIFFICULTY_ORDER[survivorDiffIndex]);
}

function setSail() {
  if (selectedMode === 'multiplayer') return;
  menuOverlay.classList.add('hidden');
  if (selectedMode === 'survivor') {
    startSurvivor();
  } else {
    game.survivorKills = null;
    game.startBattle(selectedPlayer, selectedEnemy, selectedDifficulty);
  }
}

document.getElementById('set-sail')!.addEventListener('click', setSail);

// ── Game-over handling ────────────────────────────────────────────────────────

game.onGameOver = (won: boolean) => {
  if (selectedMode === 'survivor') {
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
    // Normal mode.
    gameoverTitle.textContent = won ? 'Enemy ship destroyed!' : 'Your ship was destroyed!';
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
  if (selectedMode === 'survivor') {
    startSurvivor();
  } else {
    game.startBattle(selectedPlayer, selectedEnemy, selectedDifficulty);
  }
});

btnHarder.addEventListener('click', () => {
  const nextDiff = NEXT_DIFFICULTY[selectedDifficulty];
  if (nextDiff) {
    selectedDifficulty = nextDiff;
    selectCard(diffRow, selectedDifficulty);
  }
  gameoverOverlay.classList.add('hidden');
  game.startBattle(selectedPlayer, selectedEnemy, selectedDifficulty);
});

btnMenu.addEventListener('click', () => {
  gameoverOverlay.classList.add('hidden');
  menuOverlay.classList.remove('hidden');
});

// R key: Play Again (works in both modes).
window.addEventListener('keydown', (e) => {
  if (e.code === 'KeyR' && !gameoverOverlay.classList.contains('hidden')) {
    gameoverOverlay.classList.add('hidden');
    if (selectedMode === 'survivor') {
      startSurvivor();
    } else {
      game.startBattle(selectedPlayer, selectedEnemy, selectedDifficulty);
    }
  }
});

// ── Multiplayer ───────────────────────────────────────────────────────────────

const mpNameInput = document.getElementById('mp-name') as HTMLInputElement;
const mpCodeInput = document.getElementById('mp-code') as HTMLInputElement;
const mpCreateBtn = document.getElementById('mp-create') as HTMLButtonElement;
const mpJoinBtn = document.getElementById('mp-join') as HTMLButtonElement;
const mpStatus = document.getElementById('mp-status')!;

const lobbyOverlay = document.getElementById('lobby-overlay')!;
const roomCodeEl = document.getElementById('room-code')!;
const lobbyPlayersEl = document.getElementById('lobby-players')!;
const lobbyShipRow = document.getElementById('lobby-ship-cards')!;
const btnReady = document.getElementById('btn-ready') as HTMLButtonElement;
const btnStart = document.getElementById('btn-start') as HTMLButtonElement;
const btnLeave = document.getElementById('btn-leave')!;

const mpendOverlay = document.getElementById('mpend-overlay')!;
const mpendTitle = document.getElementById('mpend-title')!;
const btnRematch = document.getElementById('btn-rematch')!;
const btnToLobby = document.getElementById('btn-tolobby')!;
const btnMpLeave = document.getElementById('btn-mpleave')!;
const mpendWait = document.getElementById('mpend-wait')!;

const MP_COLORS = ['#8b5a2b', '#7a1f1f', '#2e5d34', '#4a3d7a'];

let mp: MpSession | null = null;
let myReady = false;
let myShip: ShipTypeName = 'small';

// Ship cards inside the lobby — each captain picks their own boat.
(Object.keys(SHIP_TYPES) as ShipTypeName[]).forEach((type) => {
  const s = SHIP_TYPES[type];
  const card = makeCard(
    type[0].toUpperCase() + type.slice(1),
    `${s.guns} guns · ${SPEED_LABELS[type]} · ${s.maxHealth} hp`,
    type,
  );
  card.addEventListener('click', () => {
    myShip = type;
    selectCard(lobbyShipRow, type);
    mp?.setShip(type);
  });
  lobbyShipRow.appendChild(card);
});

function renderLobby(players: LobbyPlayerInfo[], you: number, canStart: boolean) {
  lobbyPlayersEl.innerHTML = '';
  players.forEach((p, i) => {
    const row = document.createElement('div');
    row.className = 'lobby-player' + (i === you ? ' you' : '');

    const dot = document.createElement('span');
    dot.className = 'dot';
    dot.style.background = MP_COLORS[i];

    const name = document.createElement('span');
    name.className = 'pname';
    name.textContent = p.name + (i === you ? ' (you)' : '') + (i === 0 ? ' ⚓' : '');

    const ship = document.createElement('span');
    ship.className = 'pship';
    ship.textContent = p.ship;

    const ready = document.createElement('span');
    ready.className = 'pready' + (p.ready ? ' is-ready' : '');
    ready.textContent = p.ready ? 'READY' : 'waiting';

    row.append(dot, name, ship, ready);
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

  const lobbyStatus = document.getElementById('lobby-status')!;
  if (players.length < 2) {
    lobbyStatus.textContent = 'Waiting for at least one more captain…';
  } else if (!canStart) {
    lobbyStatus.textContent = 'Waiting for everyone to be ready…';
  } else {
    lobbyStatus.textContent = isHost ? 'All hands ready — start when you like!' : 'All ready — the host can start.';
  }
}

function endMpSession(errorMessage?: string) {
  mp?.leave();
  mp = null;
  myReady = false;
  game.suspended = false;
  lobbyOverlay.classList.add('hidden');
  mpendOverlay.classList.add('hidden');
  menuOverlay.classList.remove('hidden');
  mpStatus.textContent = errorMessage ?? '';
  mpCreateBtn.disabled = false;
  mpJoinBtn.disabled = false;
}

function mpCallbacks() {
  return {
    onRoomReady(code: string) {
      mpStatus.textContent = '';
      roomCodeEl.textContent = code;
      menuOverlay.classList.add('hidden');
      lobbyOverlay.classList.remove('hidden');
      mpCreateBtn.disabled = false;
      mpJoinBtn.disabled = false;
    },
    onLobby(players: LobbyPlayerInfo[], you: number, canStart: boolean) {
      renderLobby(players, you, canStart);
    },
    onStart() {
      lobbyOverlay.classList.add('hidden');
      mpendOverlay.classList.add('hidden');
      game.suspended = true;
    },
    onEnd(winnerName: string | null) {
      mpendTitle.textContent = winnerName ? `☠️ ${winnerName} rules the seas!` : 'Mutual destruction — a draw!';
      const isHost = mp?.isHost ?? false;
      btnRematch.classList.toggle('hidden', !isHost);
      btnToLobby.classList.toggle('hidden', !isHost);
      mpendWait.classList.toggle('hidden', isHost);
      mpendOverlay.classList.remove('hidden');
    },
    onToLobby() {
      mpendOverlay.classList.add('hidden');
      game.suspended = false;
      lobbyOverlay.classList.remove('hidden');
    },
    onError(message: string) {
      endMpSession(message);
    },
  };
}

mpCreateBtn.addEventListener('click', () => {
  if (mp) return;
  mpStatus.textContent = 'Opening room…';
  mpCreateBtn.disabled = true;
  mpJoinBtn.disabled = true;
  mp = MpSession.host(mpNameInput.value, ctx, input, mpCallbacks(), {
    fire: playCannonFire,
    hit: playExplosion,
  });
});

mpJoinBtn.addEventListener('click', () => {
  if (mp) return;
  const code = mpCodeInput.value.toUpperCase().trim();
  if (code.length !== CODE_LENGTH) {
    mpStatus.textContent = `Room codes are ${CODE_LENGTH} characters.`;
    return;
  }
  mpStatus.textContent = 'Joining…';
  mpCreateBtn.disabled = true;
  mpJoinBtn.disabled = true;
  mp = MpSession.join(code, mpNameInput.value, ctx, input, mpCallbacks(), {
    fire: playCannonFire,
    hit: playExplosion,
  });
});

mpCodeInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') mpJoinBtn.click();
});

btnReady.addEventListener('click', () => {
  myReady = !myReady;
  btnReady.textContent = myReady ? 'Not Ready' : "I'm Ready";
  btnReady.classList.toggle('armed', myReady);
  mp?.setReady(myReady);
});

btnStart.addEventListener('click', () => mp?.startBattle());
btnLeave.addEventListener('click', () => endMpSession());
btnRematch.addEventListener('click', () => mp?.rematch());
btnToLobby.addEventListener('click', () => mp?.backToLobby());
btnMpLeave.addEventListener('click', () => endMpSession());
