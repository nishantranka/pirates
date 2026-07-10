// P2P transport for multiplayer, built on PeerJS (WebRTC + the free public
// PeerJS signaling server). The host claims a peer ID derived from a short
// room code; guests connect to that ID. After signaling, all game traffic
// flows peer-to-peer.

import { Peer } from 'peerjs';
import type { DataConnection } from 'peerjs';
import type { IslandData } from './island';
import type { ShipTypeName, Turn } from './ship';

const ID_PREFIX = 'pirates-nvc1-';
// No 0/O/1/I/L — codes get read aloud.
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const CODE_LENGTH = 5;

// ── Wire types ────────────────────────────────────────────────────────────────

export interface LobbyPlayerInfo {
  name: string;
  ship: ShipTypeName;
  ready: boolean;
  bot: boolean;
}

export interface ShipSpawn {
  name: string;
  type: ShipTypeName;
  color: string;
  x: number;
  y: number;
  heading: number;
}

export type PickupType = 'health' | 'shield' | 'speed' | 'double' | 'machinegun';

export interface PickupState {
  t: PickupType;
  x: number;
  y: number;
}

export interface ShipState {
  x: number;
  y: number;
  heading: number;
  health: number;
  sink: number;
  shield: number; // remaining shield hits
  spd: boolean; // speed boost active
  dbl: boolean; // double-broadside active
  mg: boolean; // machine-gun active
  inv: boolean; // spawn-protection (invulnerable) active
  depth: number; // submarine: 0 surfaced → 1 fully submerged
  charge: number; // submarine dive charge, 0..1
  score: number; // weighted battle score
  kills: number; // enemies sunk
}

export interface BallState {
  x: number;
  y: number;
  vx: number;
  vy: number;
  tp?: boolean; // torpedo (rendered differently)
}

export type GameEvent =
  | { e: 'fire' }
  | { e: 'hit'; x: number; y: number }
  | { e: 'splash'; x: number; y: number }
  | { e: 'grab'; x: number; y: number; p: PickupType }
  | { e: 'block'; x: number; y: number };

/** Guest → host. */
export type C2HMsg =
  | { t: 'hello'; name: string }
  | { t: 'choose'; ship: ShipTypeName }
  | { t: 'ready'; ready: boolean }
  | { t: 'input'; turn: Turn; fire: boolean; dive: boolean };

/** Host → guest. */
export type H2CMsg =
  | { t: 'reject'; reason: string }
  | { t: 'lobby'; players: LobbyPlayerInfo[]; you: number }
  | { t: 'start'; islands: IslandData[]; ships: ShipSpawn[]; you: number }
  | {
      t: 'state';
      ships: ShipState[];
      balls: BallState[];
      wind: number;
      events: GameEvent[];
      pickups: PickupState[];
      eye: number; // whirlpool eye radius in px (shrinks over time; large = no maelstrom yet)
      freeze: number; // start-of-round locate-your-ship pause remaining, s
    }
  | { t: 'end'; winner: number }
  | { t: 'toLobby' };

// ── Peer lifecycle ────────────────────────────────────────────────────────────

export interface PeerHandle {
  destroy(): void;
}

function friendly(type: string | undefined): string {
  if (type === 'network') return 'Could not reach the matchmaking server — check your connection.';
  if (type === 'browser-incompatible') return 'This browser does not support WebRTC.';
  return `Connection error${type ? ` (${type})` : ''}.`;
}

function randomCode(): string {
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i++) {
    code += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  }
  return code;
}

/** Open a room. Retries with a fresh code if the ID happens to be taken. */
export function createHostPeer(cb: {
  onReady: (code: string) => void;
  onConnection: (conn: DataConnection) => void;
  // recoverable = the signaling server is unreachable; the host can still play
  // locally against bots, it just can't be joined by remote friends.
  onError: (message: string, recoverable: boolean) => void;
}): PeerHandle {
  let peer: Peer | null = null;
  let destroyed = false;
  let attemptsLeft = 4;

  const attempt = () => {
    const code = randomCode();
    peer = new Peer(ID_PREFIX + code);
    peer.on('open', () => {
      if (!destroyed) cb.onReady(code);
    });
    peer.on('connection', (conn) => {
      if (!destroyed) cb.onConnection(conn);
    });
    peer.on('error', (err) => {
      if (destroyed) return;
      const type = (err as { type?: string }).type;
      if (type === 'unavailable-id' && attemptsLeft-- > 0) {
        peer?.destroy();
        attempt();
        return;
      }
      const recoverable =
        type === 'network' ||
        type === 'server-error' ||
        type === 'socket-error' ||
        type === 'socket-closed' ||
        type === 'disconnected';
      cb.onError(friendly(type), recoverable);
    });
  };
  attempt();

  return {
    destroy() {
      destroyed = true;
      peer?.destroy();
    },
  };
}

/** Join a room by code. onOpen fires once the data channel is usable. */
export function createGuestPeer(
  code: string,
  cb: {
    onOpen: (conn: DataConnection) => void;
    onError: (message: string) => void;
  },
): PeerHandle {
  const peer = new Peer();
  let destroyed = false;

  peer.on('open', () => {
    if (destroyed) return;
    const conn = peer.connect(ID_PREFIX + code.toUpperCase().trim(), { reliable: true });
    conn.on('open', () => {
      if (!destroyed) cb.onOpen(conn);
    });
  });
  peer.on('error', (err) => {
    if (destroyed) return;
    const type = (err as { type?: string }).type;
    cb.onError(type === 'peer-unavailable' ? 'Room not found — check the code.' : friendly(type));
  });

  return {
    destroy() {
      destroyed = true;
      peer.destroy();
    },
  };
}
