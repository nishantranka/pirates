// Open-room directory — lets "Join a Room" show currently open rooms without
// any backend of our own. There's no server to ask, so instead one browser
// tab acts as a shared rendezvous point: whichever tab claims a well-known
// PeerJS ID first becomes the directory for as long as it's open, and every
// other tab (hosts announcing a room, or browsers watching the list) is just
// a regular WebRTC client of that tab. If the directory tab closes, its
// listings die with it — everyone still connected notices and races to
// re-elect a new directory, and hosts re-announce once one exists again. No
// server, no static file changes — same broker the game already uses.
import { Peer } from 'peerjs';
import type { DataConnection } from 'peerjs';
import { ID_PREFIX } from './net';

const DIRECTORY_ID = ID_PREFIX + 'directory';
const STALE_MS = 25_000; // an entry with no refresh in this long is dropped
const PRUNE_INTERVAL_MS = 8_000;
const HEARTBEAT_MS = 10_000; // how often a guest re-announces to stay listed
const RECONNECT_BASE_MS = 500; // + jitter, backing off after repeated failures
const CONNECT_TIMEOUT_MS = 6_000; // give up on a hung connection attempt and retry
const WATCHDOG_TIMEOUT_MS = PRUNE_INTERVAL_MS * 3; // no ping this long = the directory is gone

export interface RoomListing {
  code: string;
  hostName: string;
  players: number;
  maxPlayers: number;
  mode: string; // pre-formatted label, e.g. "Leaderboard"
}

interface Entry extends RoomListing {
  lastSeen: number;
}

type DirMsg = { t: 'announce'; room: RoomListing } | { t: 'remove'; code: string };
type DirReply = { t: 'rooms'; rooms: RoomListing[] };

export interface RoomAnnouncer {
  /** Refresh the listed player count / mode (call whenever the lobby roster changes). */
  update(patch: Partial<Pick<RoomListing, 'players' | 'maxPlayers' | 'mode'>>): void;
  /** Stop listing this room. */
  stop(): void;
}

export interface RoomBrowser {
  stop(): void;
}

type Mode = 'idle' | 'electing' | 'host' | 'guest';

/**
 * One shared connection to the directory for this whole tab, lazily started
 * on first use and torn down once nobody needs it. Two roles collapse into
 * one link because a single tab might (rarely) both announce a room it's
 * hosting and browse for others at the same time, and they must agree on
 * whether this tab is the elected directory or a guest of someone else's.
 */
class DirectoryLink {
  private mode: Mode = 'idle';
  private refs = 0;
  private failedAttempts = 0;

  // 'host' mode: we ARE the directory.
  private hostPeer: Peer | null = null;
  private hostRooms = new Map<string, Entry>();
  private hostConns = new Set<DataConnection>(); // every open remote connection — broadcasts go to all of these
  private connCodes = new Map<DataConnection, Set<string>>(); // codes announced by each remote conn, for cleanup on close
  private pruneTimer: ReturnType<typeof setInterval> | null = null;

  // 'guest' mode: we're a client of whoever else holds the directory ID.
  private guestPeer: Peer | null = null;
  private guestConn: DataConnection | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private lastHeardAt = 0; // last time the directory pinged us (watchdog)

  private listeners = new Set<(rooms: RoomListing[]) => void>();
  private ownRoom: RoomListing | null = null; // this tab's own announced room, if any

  retain() {
    this.refs++;
    if (this.mode === 'idle') this.elect();
  }

  release() {
    this.refs = Math.max(0, this.refs - 1);
    if (this.refs === 0) this.teardown();
  }

  addListener(cb: (rooms: RoomListing[]) => void) {
    this.listeners.add(cb);
    cb(this.currentRooms());
  }

  removeListener(cb: (rooms: RoomListing[]) => void) {
    this.listeners.delete(cb);
  }

  setOwnRoom(room: RoomListing) {
    this.ownRoom = room;
    this.publishOwnRoom();
  }

  updateOwnRoom(patch: Partial<Pick<RoomListing, 'players' | 'maxPlayers' | 'mode'>>) {
    if (!this.ownRoom) return;
    this.ownRoom = { ...this.ownRoom, ...patch };
    this.publishOwnRoom();
  }

  clearOwnRoom() {
    const code = this.ownRoom?.code;
    this.ownRoom = null;
    if (!code) return;
    if (this.mode === 'host') {
      this.hostRooms.delete(code);
      this.broadcastRooms();
    } else if (this.mode === 'guest') {
      this.send({ t: 'remove', code });
    }
  }

  // ── Election ────────────────────────────────────────────────────────────

  private elect() {
    this.mode = 'electing';
    const peer = new Peer(DIRECTORY_ID);
    peer.on('open', () => this.becomeHost(peer));
    peer.on('error', (err) => {
      if (this.mode !== 'electing') return; // already resolved via 'open'
      const type = (err as { type?: string }).type;
      if (type === 'unavailable-id') {
        peer.destroy();
        this.becomeGuest();
      } else {
        peer.destroy();
        this.scheduleReconnect();
      }
    });
  }

  private becomeHost(peer: Peer) {
    this.mode = 'host';
    this.failedAttempts = 0;
    this.hostPeer = peer;
    if (this.ownRoom) this.hostRooms.set(this.ownRoom.code, { ...this.ownRoom, lastSeen: Date.now() });
    peer.on('connection', (conn) => this.acceptConnection(conn));
    peer.on('disconnected', () => peer.reconnect());
    peer.on('error', () => {
      /* an established host tolerates transient errors; disconnected above reconnects the signaling socket */
    });
    this.pruneTimer = setInterval(() => this.prune(), PRUNE_INTERVAL_MS);
    this.notifyListeners();
  }

  private acceptConnection(conn: DataConnection) {
    this.hostConns.add(conn);
    conn.on('open', () => conn.send({ t: 'rooms', rooms: this.currentRooms() } satisfies DirReply));
    conn.on('data', (data) => {
      const msg = data as DirMsg;
      if (msg.t === 'announce') {
        this.hostRooms.set(msg.room.code, { ...msg.room, lastSeen: Date.now() });
        let codes = this.connCodes.get(conn);
        if (!codes) this.connCodes.set(conn, (codes = new Set()));
        codes.add(msg.room.code);
        this.broadcastRooms();
      } else if (msg.t === 'remove') {
        this.hostRooms.delete(msg.code);
        this.connCodes.get(conn)?.delete(msg.code);
        this.broadcastRooms();
      }
    });
    conn.on('close', () => {
      this.hostConns.delete(conn);
      const codes = this.connCodes.get(conn);
      this.connCodes.delete(conn);
      if (codes?.size) {
        for (const code of codes) this.hostRooms.delete(code);
        this.broadcastRooms();
      }
    });
  }

  private prune() {
    const cutoff = Date.now() - STALE_MS;
    for (const [code, entry] of this.hostRooms) {
      // Our own listing (if we're both directory and a room host) is locally
      // authoritative, not something we learned from a remote heartbeat —
      // there's nothing to go stale, so it's only ever removed explicitly,
      // via clearOwnRoom().
      if (code === this.ownRoom?.code) continue;
      if (entry.lastSeen < cutoff) this.hostRooms.delete(code);
    }
    // Broadcast every tick, changed or not — this doubles as a liveness ping
    // guests watch for (see the guest-side watchdog in becomeGuest), since an
    // already-open connection to a peer that silently vanishes may never
    // fire its own close/error event.
    this.broadcastRooms();
  }

  private broadcastRooms() {
    this.notifyListeners();
    if (!this.hostPeer) return;
    const msg = { t: 'rooms', rooms: this.currentRooms() } satisfies DirReply;
    for (const conn of this.hostConns) {
      if (conn.open) conn.send(msg);
    }
  }

  private becomeGuest() {
    this.mode = 'guest';
    const peer = new Peer(); // anonymous id — we're just a client here
    this.guestPeer = peer;
    peer.on('open', () => {
      const conn = peer.connect(DIRECTORY_ID, { reliable: true });
      this.guestConn = conn;
      // The signaling server can hold a destroyed peer's ID for a grace
      // period, so we can end up "connecting" to an ID nobody is actually
      // listening on — the RTC negotiation just hangs, with no error or
      // close event ever firing. Give it a bounded window, then treat it as
      // failed and retry ourselves rather than waiting on WebRTC's own much
      // slower (or absent) failure detection.
      const connectTimeout = setTimeout(() => {
        if (!conn.open) {
          conn.close();
          this.scheduleReconnect();
        }
      }, CONNECT_TIMEOUT_MS);
      conn.on('open', () => {
        clearTimeout(connectTimeout);
        this.failedAttempts = 0;
        this.lastHeardAt = Date.now();
        if (this.ownRoom) this.send({ t: 'announce', room: this.ownRoom });
        this.heartbeatTimer = setInterval(() => {
          if (this.ownRoom) this.send({ t: 'announce', room: this.ownRoom });
          // Watchdog: the directory re-broadcasts on every prune tick (see
          // prune()), so silence this long means the connection is dead even
          // though nothing told us so — WebRTC doesn't guarantee a prompt
          // close/error when the other side just vanishes.
          if (Date.now() - this.lastHeardAt > WATCHDOG_TIMEOUT_MS) this.scheduleReconnect();
        }, HEARTBEAT_MS);
      });
      conn.on('data', (data) => {
        const msg = data as DirReply;
        this.lastHeardAt = Date.now();
        if (msg.t === 'rooms') this.notifyListeners(msg.rooms);
      });
      conn.on('close', () => {
        clearTimeout(connectTimeout);
        this.scheduleReconnect();
      });
      conn.on('error', () => {
        clearTimeout(connectTimeout);
        this.scheduleReconnect();
      });
    });
    peer.on('error', (err) => {
      const type = (err as { type?: string }).type;
      // The one we just tried to reach vanished between election and
      // connect — the ID is free again, so try to claim it ourselves.
      if (type === 'peer-unavailable') {
        peer.destroy();
        this.elect();
      } else {
        this.scheduleReconnect();
      }
    });
  }

  private send(msg: DirMsg) {
    if (this.mode === 'host') {
      if (msg.t === 'announce') this.hostRooms.set(msg.room.code, { ...msg.room, lastSeen: Date.now() });
      else this.hostRooms.delete(msg.code);
      this.broadcastRooms();
    } else if (this.guestConn?.open) {
      this.guestConn.send(msg);
    }
  }

  private scheduleReconnect() {
    if (this.refs === 0 || this.reconnectTimer) return;
    this.guestPeer?.destroy();
    this.guestPeer = null;
    this.guestConn = null;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
    this.mode = 'idle';
    const backoff = RECONNECT_BASE_MS * Math.pow(1.6, Math.min(this.failedAttempts++, 5));
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.refs > 0) this.elect();
    }, backoff + Math.random() * 400);
  }

  private currentRooms(): RoomListing[] {
    if (this.mode !== 'host') return this.lastGuestRooms;
    return [...this.hostRooms.values()].map(({ lastSeen: _lastSeen, ...room }) => room);
  }

  private lastGuestRooms: RoomListing[] = [];

  private notifyListeners(rooms?: RoomListing[]) {
    if (rooms) this.lastGuestRooms = rooms;
    const list = this.currentRooms();
    for (const cb of this.listeners) cb(list);
  }

  private publishOwnRoom() {
    if (!this.ownRoom) return;
    if (this.mode === 'host') {
      this.hostRooms.set(this.ownRoom.code, { ...this.ownRoom, lastSeen: Date.now() });
      this.broadcastRooms();
    } else if (this.mode === 'guest') {
      this.send({ t: 'announce', room: this.ownRoom });
    }
    // While still electing, setOwnRoom's value is picked up by
    // becomeHost/becomeGuest once election resolves.
  }

  private teardown() {
    if (this.pruneTimer) clearInterval(this.pruneTimer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.pruneTimer = null;
    this.heartbeatTimer = null;
    this.reconnectTimer = null;
    this.hostPeer?.destroy();
    this.guestPeer?.destroy();
    this.hostPeer = null;
    this.guestPeer = null;
    this.guestConn = null;
    this.hostRooms.clear();
    this.hostConns.clear();
    this.connCodes.clear();
    this.listeners.clear();
    this.ownRoom = null;
    this.mode = 'idle';
    this.failedAttempts = 0;
  }
}

const link = new DirectoryLink();
// Dev-only hook so E2E tests can observe the directory link; stripped in prod.
if (import.meta.env.DEV) (window as unknown as { __directory: DirectoryLink }).__directory = link;

/** Announce a room to the shared directory and keep it listed until stop(). */
export function announceRoom(room: RoomListing): RoomAnnouncer {
  link.retain();
  link.setOwnRoom(room);
  let stopped = false;
  return {
    update(patch) {
      if (!stopped) link.updateOwnRoom(patch);
    },
    stop() {
      if (stopped) return;
      stopped = true;
      link.clearOwnRoom();
      link.release();
    },
  };
}

/** Watch the shared directory for open rooms; onRooms fires immediately with
 *  the current list and again whenever it changes, until stop(). */
export function browseRooms(onRooms: (rooms: RoomListing[]) => void): RoomBrowser {
  link.retain();
  link.addListener(onRooms);
  let stopped = false;
  return {
    stop() {
      if (stopped) return;
      stopped = true;
      link.removeListener(onRooms);
      link.release();
    },
  };
}
