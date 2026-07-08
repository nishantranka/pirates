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

export interface ShipState {
  x: number;
  y: number;
  heading: number;
  health: number;
  sink: number;
}

export interface BallState {
  x: number;
  y: number;
  vx: number;
  vy: number;
}

export type GameEvent =
  | { e: 'fire' }
  | { e: 'hit'; x: number; y: number }
  | { e: 'splash'; x: number; y: number };

/** Guest → host. */
export type C2HMsg =
  | { t: 'hello'; name: string }
  | { t: 'choose'; ship: ShipTypeName }
  | { t: 'ready'; ready: boolean }
  | { t: 'input'; turn: Turn; fire: boolean };

/** Host → guest. */
export type H2CMsg =
  | { t: 'reject'; reason: string }
  | { t: 'lobby'; players: LobbyPlayerInfo[]; you: number }
  | { t: 'start'; islands: IslandData[]; ships: ShipSpawn[]; you: number }
  | { t: 'state'; ships: ShipState[]; balls: BallState[]; wind: number; events: GameEvent[] }
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
  onError: (message: string) => void;
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
      cb.onError(friendly(type));
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
