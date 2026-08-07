export type RoomStatus = 'lobby' | 'countdown' | 'playing' | 'paused' | 'results';

export interface OnlineGameConfig {
    bpm: number;
    beatsPerRound: number;
    rounds: number;
    timePerRound: number;
    grids: number[];
    showAttackNotes: boolean;
}

export interface RoomPlayer {
    id: string;
    name: string;
    color: string;
    connected: boolean;
    score: number;
}

export interface OnlineGameState {
    sessionId: string;
    currentRound: number;
    currentAttackerIdx: number;
    segmentStartAt: number;
    segmentEndAt: number;
    pausedAt: number | null;
}

export interface RoomSnapshot {
    code: string;
    ownerId: string;
    status: RoomStatus;
    players: RoomPlayer[];
    config: OnlineGameConfig;
    game: OnlineGameState | null;
}

export interface JoinIdentity {
    roomCode: string;
    playerId: string;
    playerToken: string;
}

export type RoomAck =
    | { ok: true; identity: JoinIdentity; room: RoomSnapshot }
    | { ok: false; error: string };

export type ActionAck = { ok: true } | { ok: false; error: string };

export interface GameHit {
    sessionId: string;
    seq: number;
    barIndex: number;
    offsetMs: number;
}

export interface AcceptedHit {
    playerId: string;
    barIndex: number;
    offsetMs: number;
    isAttacker: boolean;
}

export interface ScoreUpdate {
    scores: Record<string, number>;
    gains: Record<string, number>;
}

export interface ClientToServerEvents {
    'clock:ping': (clientSentAt: number, ack: (serverNow: number) => void) => void;
    'room:create': (payload: { name: string }, ack: (result: RoomAck) => void) => void;
    'room:join': (payload: { code: string; name: string }, ack: (result: RoomAck) => void) => void;
    'room:resume': (identity: JoinIdentity, ack: (result: RoomAck) => void) => void;
    'room:leave': (ack: (result: ActionAck) => void) => void;
    'room:updateConfig': (config: OnlineGameConfig, ack: (result: ActionAck) => void) => void;
    'game:start': (ack: (result: ActionAck) => void) => void;
    'game:hit': (hit: GameHit) => void;
    'game:pause': (ack: (result: ActionAck) => void) => void;
    'game:resume': (ack: (result: ActionAck) => void) => void;
    'game:restart': (ack: (result: ActionAck) => void) => void;
}

export interface ServerToClientEvents {
    'room:snapshot': (room: RoomSnapshot) => void;
    'game:hit': (hit: AcceptedHit) => void;
    'game:score': (update: ScoreUpdate) => void;
    'server:error': (message: string) => void;
}

