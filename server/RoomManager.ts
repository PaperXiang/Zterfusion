import { randomBytes } from 'node:crypto';
import type { Server, Socket } from 'socket.io';
import { GAME_NUMBERS } from '../src/config.js';
import type {
    ActionAck,
    ClientToServerEvents,
    GameHit,
    JoinIdentity,
    OnlineGameConfig,
    RoomAck,
    RoomPlayer,
    RoomSnapshot,
    ScoreUpdate,
    ServerToClientEvents
} from '../src/shared/protocol.js';

type TypedServer = Server<ClientToServerEvents, ServerToClientEvents>;
type TypedSocket = Socket<ClientToServerEvents, ServerToClientEvents>;

interface StoredPlayer extends RoomPlayer {
    token: string;
    socketId: string | null;
    lastSeq: number;
}

interface RuntimeGame {
    sessionId: string;
    currentRound: number;
    currentAttackerIdx: number;
    segmentStartAt: number;
    segmentEndAt: number;
    pausedAt: number | null;
    attackNotes: Map<number, number[]>;
    attackAccuracy: Map<number, number[]>;
    defenderHits: Map<number, Map<string, number[]>>;
    scoredDefenseBars: Set<number>;
    timers: Set<NodeJS.Timeout>;
}

interface Room {
    code: string;
    ownerId: string;
    status: RoomSnapshot['status'];
    players: StoredPlayer[];
    config: OnlineGameConfig;
    game: RuntimeGame | null;
    emptyTimer: NodeJS.Timeout | null;
}

const PLAYER_COLORS = ['#00ff88', '#00aaff', '#ff00aa', '#ffcc00', '#ff6644', '#aa66ff'];
const ROOM_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

const defaultConfig = (): OnlineGameConfig => ({
    bpm: 120,
    beatsPerRound: 4,
    rounds: 2,
    timePerRound: 30,
    grids: [16],
    showAttackNotes: true
});

/**
 * 单进程房间管理器。房间只存在于内存中，适合首版单 VPS；以后横向扩容时，
 * 再把房间状态和定时调度迁往 Redis，而不是提前增加部署复杂度。
 */
export class RoomManager {
    private readonly rooms = new Map<string, Room>();
    private readonly socketRooms = new Map<string, string>();

    constructor(private readonly io: TypedServer) {}

    create(socket: TypedSocket, name: string): RoomAck {
        this.detachSocket(socket.id, true);
        const code = this.createCode();
        const player = this.createPlayer(name, socket.id, 0);
        const room: Room = {
            code,
            ownerId: player.id,
            status: 'lobby',
            players: [player],
            config: defaultConfig(),
            game: null,
            emptyTimer: null
        };
        this.rooms.set(code, room);
        this.attachSocket(socket, room);
        return this.joinResult(room, player);
    }

    join(socket: TypedSocket, rawCode: string, name: string): RoomAck {
        this.detachSocket(socket.id, true);
        const room = this.rooms.get(this.normalizeCode(rawCode));
        if (!room) return { ok: false, error: 'ROOM NOT FOUND' };
        if (room.status !== 'lobby' && room.status !== 'results') {
            return { ok: false, error: 'GAME ALREADY STARTED' };
        }
        if (room.players.length >= 6) return { ok: false, error: 'ROOM IS FULL' };
        const player = this.createPlayer(name, socket.id, room.players.length);
        room.players.push(player);
        this.attachSocket(socket, room);
        this.broadcast(room);
        return this.joinResult(room, player);
    }

    resume(socket: TypedSocket, identity: JoinIdentity): RoomAck {
        const room = this.rooms.get(this.normalizeCode(identity.roomCode));
        const player = room?.players.find(item =>
            item.id === identity.playerId && item.token === identity.playerToken
        );
        if (!room || !player) return { ok: false, error: 'SESSION EXPIRED' };
        this.detachSocket(socket.id, true);
        if (player.socketId && player.socketId !== socket.id) {
            this.socketRooms.delete(player.socketId);
            this.io.sockets.sockets.get(player.socketId)?.disconnect(true);
        }
        player.socketId = socket.id;
        player.connected = true;
        this.attachSocket(socket, room);
        this.broadcast(room);
        return this.joinResult(room, player);
    }

    leave(socket: TypedSocket): ActionAck {
        const room = this.roomForSocket(socket.id);
        if (!room) return { ok: true };
        this.removePlayer(room, socket.id);
        socket.leave(room.code);
        this.socketRooms.delete(socket.id);
        return { ok: true };
    }

    disconnect(socketId: string): void {
        const room = this.roomForSocket(socketId);
        if (!room) return;
        this.socketRooms.delete(socketId);
        const player = room.players.find(item => item.socketId === socketId);
        if (!player) return;
        player.connected = false;
        player.socketId = null;
        this.broadcast(room);

        // 给刷新页面和短暂断网留出恢复窗口。房间无人在线时 10 分钟后回收。
        if (!room.players.some(item => item.connected) && !room.emptyTimer) {
            room.emptyTimer = setTimeout(() => this.destroyRoom(room.code), 10 * 60_000);
        }
    }

    updateConfig(socketId: string, incoming: OnlineGameConfig): ActionAck {
        const room = this.roomForSocket(socketId);
        const player = room && this.playerForSocket(room, socketId);
        if (!room || !player) return { ok: false, error: 'NOT IN A ROOM' };
        if (room.ownerId !== player.id) return { ok: false, error: 'OWNER ONLY' };
        if (room.status !== 'lobby' && room.status !== 'results') {
            return { ok: false, error: 'GAME ALREADY STARTED' };
        }
        room.config = this.normalizeConfig(incoming);
        this.broadcast(room);
        return { ok: true };
    }

    start(socketId: string): ActionAck {
        const room = this.roomForSocket(socketId);
        const player = room && this.playerForSocket(room, socketId);
        if (!room || !player) return { ok: false, error: 'NOT IN A ROOM' };
        if (room.ownerId !== player.id) return { ok: false, error: 'OWNER ONLY' };
        if (room.players.length < 2) return { ok: false, error: 'NEED 2 PLAYERS' };
        if (room.players.some(item => !item.connected)) {
            return { ok: false, error: 'WAITING FOR RECONNECT' };
        }
        if (!['lobby', 'results'].includes(room.status)) {
            return { ok: false, error: 'GAME ALREADY STARTED' };
        }
        room.players.forEach(item => {
            item.score = 0;
            item.lastSeq = -1;
        });
        this.startSegment(room, 0, 0, Date.now() + 3000);
        return { ok: true };
    }

    hit(socketId: string, hit: GameHit): void {
        const room = this.roomForSocket(socketId);
        const player = room && this.playerForSocket(room, socketId);
        const game = room?.game;
        if (!room || !player || !game || room.status !== 'playing') return;
        if (hit.sessionId !== game.sessionId || hit.seq <= player.lastSeq) return;
        player.lastSeq = hit.seq;

        const barDurationMs = this.barDurationMs(room.config);
        const nowBar = Math.floor((Date.now() - game.segmentStartAt) / barDurationMs);
        if (Math.abs(hit.barIndex - nowBar) > 1 || hit.barIndex < 0) return;
        if (!Number.isFinite(hit.offsetMs)
            || hit.offsetMs < -GAME_NUMBERS.tolerance * 1000
            || hit.offsetMs > barDurationMs + GAME_NUMBERS.tolerance * 1000) return;

        const attacker = room.players[game.currentAttackerIdx];
        const isAttackBar = hit.barIndex % 2 === 0;
        const isAttacker = player.id === attacker?.id;
        if (isAttackBar !== isAttacker) return;

        let acceptedOffset = hit.offsetMs;
        if (isAttacker) {
            acceptedOffset = this.quantizeOffset(room.config, hit.offsetMs);
            const notes = game.attackNotes.get(hit.barIndex) || [];
            if (notes.some(offset => Math.abs(offset - acceptedOffset) < 0.5)) return;
            notes.push(acceptedOffset);
            notes.sort((a, b) => a - b);
            game.attackNotes.set(hit.barIndex, notes);
            const accuracy = game.attackAccuracy.get(hit.barIndex) || [];
            accuracy.push(this.attackAccuracy(room.config, hit.offsetMs));
            game.attackAccuracy.set(hit.barIndex, accuracy);
        } else {
            const byPlayer = game.defenderHits.get(hit.barIndex) || new Map<string, number[]>();
            const hits = byPlayer.get(player.id) || [];
            hits.push(acceptedOffset);
            byPlayer.set(player.id, hits);
            game.defenderHits.set(hit.barIndex, byPlayer);
        }
        this.io.to(room.code).emit('game:hit', {
            playerId: player.id,
            barIndex: hit.barIndex,
            offsetMs: acceptedOffset,
            isAttacker
        });
    }

    pause(socketId: string): ActionAck {
        const checked = this.ownerGame(socketId, 'playing');
        if ('error' in checked) return { ok: false, error: checked.error };
        checked.room.status = 'paused';
        checked.game.pausedAt = Date.now();
        this.clearGameTimer(checked.game);
        this.broadcast(checked.room);
        return { ok: true };
    }

    resumeGame(socketId: string): ActionAck {
        const checked = this.ownerGame(socketId, 'paused');
        if ('error' in checked) return { ok: false, error: checked.error };
        const pausedAt = checked.game.pausedAt || Date.now();
        const shift = Date.now() - pausedAt;
        checked.game.segmentStartAt += shift;
        checked.game.segmentEndAt += shift;
        checked.game.pausedAt = null;
        checked.room.status = 'playing';
        this.scheduleScoreTicks(checked.room);
        this.scheduleSegmentEnd(checked.room);
        this.broadcast(checked.room);
        return { ok: true };
    }

    snapshot(socketId: string): RoomSnapshot | null {
        const room = this.roomForSocket(socketId);
        return room ? this.toSnapshot(room) : null;
    }

    private startSegment(room: Room, round: number, attackerIdx: number, startAt: number): void {
        if (room.game) this.clearGameTimer(room.game);
        const barDurationMs = this.barDurationMs(room.config);
        const pairCount = Math.max(1, Math.ceil(room.config.timePerRound * 1000 / (barDurationMs * 2)));
        room.status = 'countdown';
        room.game = {
            sessionId: randomBytes(8).toString('hex'),
            currentRound: round,
            currentAttackerIdx: attackerIdx,
            segmentStartAt: startAt,
            segmentEndAt: startAt + pairCount * barDurationMs * 2,
            pausedAt: null,
            attackNotes: new Map(),
            attackAccuracy: new Map(),
            defenderHits: new Map(),
            scoredDefenseBars: new Set(),
            timers: new Set()
        };
        this.broadcast(room);
        this.addGameTimer(room.game, () => {
            if (!room.game || room.game.segmentStartAt !== startAt) return;
            room.status = 'playing';
            this.broadcast(room);
            this.scheduleScoreTicks(room);
            this.scheduleSegmentEnd(room);
        }, Math.max(0, startAt - Date.now()));
    }

    private scheduleScoreTicks(room: Room): void {
        const game = room.game;
        if (!game) return;
        const barDurationMs = this.barDurationMs(room.config);
        const defenseBars = Math.round((game.segmentEndAt - game.segmentStartAt) / barDurationMs / 2);
        for (let pair = 0; pair < defenseBars; pair++) {
            const defenseBar = pair * 2 + 1;
            this.addGameTimer(game, () => {
                if (room.game !== game || !['playing', 'paused'].includes(room.status)) return;
                if (room.status === 'paused') return;
                this.scoreDefenseBar(room, defenseBar);
            }, Math.max(0, game.segmentStartAt + (defenseBar + 1) * barDurationMs
                + GAME_NUMBERS.tolerance * 1000 - Date.now()));
        }
    }

    private scoreDefenseBar(room: Room, defenseBar: number): void {
        const game = room.game;
        if (!game || game.scoredDefenseBars.has(defenseBar)) return;
        game.scoredDefenseBars.add(defenseBar);
        const attacks = game.attackNotes.get(defenseBar - 1) || [];
        const byPlayer = game.defenderHits.get(defenseBar) || new Map<string, number[]>();
        const attacker = room.players[game.currentAttackerIdx];
        const gains: Record<string, number> = {};
        // 与本地版一致：攻击准确度按整个进攻小节汇总后做一次软封顶，
        // 不能逐音直接加分，否则高密度节奏会绕过封顶规则。
        const attackGain = this.softCap((game.attackAccuracy.get(defenseBar - 1) || [])
            .reduce((sum, score) => sum + score, 0));
        if (attacker && attackGain) {
            attacker.score += attackGain;
            gains[attacker.id] = attackGain;
        }
        room.players.forEach(player => {
            if (player.id === attacker?.id) return;
            const gained = this.matchScore(attacks, byPlayer.get(player.id) || []);
            if (!gained) return;
            player.score += gained;
            if (attacker) attacker.score += gained;
            gains[player.id] = (gains[player.id] || 0) + gained;
            if (attacker) gains[attacker.id] = (gains[attacker.id] || 0) + gained;
        });
        if (Object.keys(gains).length) this.emitScores(room, gains);
    }

    private scheduleSegmentEnd(room: Room): void {
        const game = room.game;
        if (!game) return;
        this.addGameTimer(game, () => this.finishSegment(room, game),
            Math.max(0, game.segmentEndAt + GAME_NUMBERS.tolerance * 1000 - Date.now()));
    }

    private finishSegment(room: Room, game: RuntimeGame): void {
        if (room.game !== game || room.status !== 'playing') return;
        const barDurationMs = this.barDurationMs(room.config);
        const lastDefenseBar = Math.round((game.segmentEndAt - game.segmentStartAt) / barDurationMs) - 1;
        this.scoreDefenseBar(room, lastDefenseBar);
        const nextAttacker = game.currentAttackerIdx + 1;
        if (nextAttacker < room.players.length) {
            this.startSegment(room, game.currentRound, nextAttacker, Date.now() + 1800);
            return;
        }
        const nextRound = game.currentRound + 1;
        if (nextRound < room.config.rounds) {
            this.startSegment(room, nextRound, 0, Date.now() + 1800);
            return;
        }
        this.clearGameTimer(game);
        room.status = 'results';
        room.game = null;
        this.broadcast(room);
    }

    private matchScore(attacks: number[], hits: number[]): number {
        const pairs: Array<{ attack: number; hit: number; error: number }> = [];
        attacks.forEach((attack, attackIndex) => hits.forEach((hit, hitIndex) => {
            const error = Math.abs(hit - attack) / 1000;
            if (error < GAME_NUMBERS.defend.matchWindow) {
                pairs.push({ attack: attackIndex, hit: hitIndex, error });
            }
        }));
        pairs.sort((a, b) => a.error - b.error);
        const usedAttack = new Set<number>();
        const usedHit = new Set<number>();
        let score = 0;
        pairs.forEach(pair => {
            if (usedAttack.has(pair.attack) || usedHit.has(pair.hit)) return;
            usedAttack.add(pair.attack);
            usedHit.add(pair.hit);
            score += this.noteScore(pair.error);
        });
        return this.softCap(score);
    }

    private noteScore(error: number): number {
        const cfg = GAME_NUMBERS.defend;
        if (error <= cfg.perfectWindow) return cfg.pointsPerNote;
        if (error >= cfg.matchWindow) return 0;
        return Math.round(cfg.pointsPerNote
            * (1 - (error - cfg.perfectWindow) / (cfg.matchWindow - cfg.perfectWindow)));
    }

    private attackAccuracy(config: OnlineGameConfig, offsetMs: number): number {
        const cfg = GAME_NUMBERS.attack;
        const step = (60 / config.bpm) * 4 / cfg.grid * 1000;
        const error = Math.abs(offsetMs - Math.round(offsetMs / step) * step) / 1000;
        if (error <= cfg.perfectWindow) return cfg.pointsPerNote;
        if (error >= cfg.maxWindow) return 0;
        return Math.round(cfg.pointsPerNote
            * (1 - (error - cfg.perfectWindow) / (cfg.maxWindow - cfg.perfectWindow)));
    }

    private quantizeOffset(config: OnlineGameConfig, offsetMs: number): number {
        let best = offsetMs;
        let bestError = Infinity;
        config.grids.forEach(grid => {
            const step = (60 / config.bpm) * 4 / grid * 1000;
            const snapped = Math.round(offsetMs / step) * step;
            const error = Math.abs(snapped - offsetMs);
            if (error < bestError) {
                best = snapped;
                bestError = error;
            }
        });
        return Math.round(best * 1000) / 1000;
    }

    private softCap(score: number): number {
        if (score <= GAME_NUMBERS.softCapKnee) return Math.round(score);
        return Math.round(GAME_NUMBERS.softCapKnee + GAME_NUMBERS.softCapLimit
            * (1 - Math.exp(-(score - GAME_NUMBERS.softCapKnee) / GAME_NUMBERS.softCapLimit)));
    }

    private emitScores(room: Room, gains: Record<string, number>): void {
        const update: ScoreUpdate = {
            scores: Object.fromEntries(room.players.map(player => [player.id, player.score])),
            gains
        };
        this.io.to(room.code).emit('game:score', update);
    }

    private ownerGame(socketId: string, status: RoomSnapshot['status']):
        { room: Room; game: RuntimeGame } | { error: string } {
        const room = this.roomForSocket(socketId);
        const player = room && this.playerForSocket(room, socketId);
        if (!room || !player || !room.game) return { error: 'NO ACTIVE GAME' };
        if (room.ownerId !== player.id) return { error: 'OWNER ONLY' };
        if (room.status !== status) return { error: `GAME IS NOT ${status.toUpperCase()}` };
        return { room, game: room.game };
    }

    private normalizeConfig(config: OnlineGameConfig): OnlineGameConfig {
        const number = (value: number, min: number, max: number, fallback: number) =>
            Number.isFinite(value) ? Math.max(min, Math.min(max, Math.round(value))) : fallback;
        const grids = [...new Set((Array.isArray(config.grids) ? config.grids : [])
            .map(Number).filter(grid => [8, 12, 16, 24].includes(grid)))];
        return {
            bpm: number(config.bpm, 60, 240, 120),
            beatsPerRound: number(config.beatsPerRound, 2, 16, 4),
            rounds: number(config.rounds, 1, 10, 2),
            timePerRound: number(config.timePerRound, 10, 120, 30),
            grids: grids.length ? grids : [16],
            showAttackNotes: config.showAttackNotes !== false
        };
    }

    private createPlayer(name: string, socketId: string, index: number): StoredPlayer {
        return {
            id: randomBytes(6).toString('hex'),
            token: randomBytes(24).toString('hex'),
            socketId,
            name: String(name || `P${index + 1}`).trim().slice(0, 8) || `P${index + 1}`,
            color: PLAYER_COLORS[index % PLAYER_COLORS.length],
            connected: true,
            score: 0,
            lastSeq: -1
        };
    }

    private createCode(): string {
        do {
            let code = '';
            for (let index = 0; index < 6; index++) {
                code += ROOM_ALPHABET[Math.floor(Math.random() * ROOM_ALPHABET.length)];
            }
            if (!this.rooms.has(code)) return code;
        } while (true);
    }

    private normalizeCode(code: string): string {
        return String(code || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
    }

    private attachSocket(socket: TypedSocket, room: Room): void {
        if (room.emptyTimer) clearTimeout(room.emptyTimer);
        room.emptyTimer = null;
        socket.join(room.code);
        this.socketRooms.set(socket.id, room.code);
    }

    private detachSocket(socketId: string, remove: boolean): void {
        const room = this.roomForSocket(socketId);
        if (!room) return;
        if (remove) this.removePlayer(room, socketId);
        this.socketRooms.delete(socketId);
    }

    private removePlayer(room: Room, socketId: string): void {
        const index = room.players.findIndex(item => item.socketId === socketId);
        if (index < 0) return;
        const [removed] = room.players.splice(index, 1);
        if (!room.players.length) {
            this.destroyRoom(room.code);
            return;
        }
        room.players.forEach((player, playerIndex) => {
            player.color = PLAYER_COLORS[playerIndex % PLAYER_COLORS.length];
        });
        if (room.ownerId === removed.id) room.ownerId = room.players[0].id;
        // 主动退出会改变玩家顺序，进行中的局无法安全续算，因此回到大厅。
        if (!['lobby', 'results'].includes(room.status)) {
            if (room.game) this.clearGameTimer(room.game);
            room.status = 'lobby';
            room.game = null;
            room.players.forEach(player => { player.score = 0; });
        }
        this.broadcast(room);
    }

    private destroyRoom(code: string): void {
        const room = this.rooms.get(code);
        if (!room) return;
        if (room.game) this.clearGameTimer(room.game);
        if (room.emptyTimer) clearTimeout(room.emptyTimer);
        room.players.forEach(player => {
            if (player.socketId) this.socketRooms.delete(player.socketId);
        });
        this.rooms.delete(code);
    }

    private clearGameTimer(game: RuntimeGame): void {
        game.timers.forEach(timer => clearTimeout(timer));
        game.timers.clear();
    }

    private addGameTimer(game: RuntimeGame, callback: () => void, delay: number): void {
        const timer = setTimeout(() => {
            game.timers.delete(timer);
            callback();
        }, delay);
        game.timers.add(timer);
    }

    private roomForSocket(socketId: string): Room | undefined {
        const code = this.socketRooms.get(socketId);
        return code ? this.rooms.get(code) : undefined;
    }

    private playerForSocket(room: Room, socketId: string): StoredPlayer | undefined {
        return room.players.find(player => player.socketId === socketId);
    }

    private joinResult(room: Room, player: StoredPlayer): RoomAck {
        return {
            ok: true,
            identity: { roomCode: room.code, playerId: player.id, playerToken: player.token },
            room: this.toSnapshot(room)
        };
    }

    private broadcast(room: Room): void {
        this.io.to(room.code).emit('room:snapshot', this.toSnapshot(room));
    }

    private toSnapshot(room: Room): RoomSnapshot {
        return {
            code: room.code,
            ownerId: room.ownerId,
            status: room.status,
            players: room.players.map(({ id, name, color, connected, score }) => ({
                id, name, color, connected, score
            })),
            config: { ...room.config, grids: room.config.grids.slice() },
            game: room.game ? {
                sessionId: room.game.sessionId,
                currentRound: room.game.currentRound,
                currentAttackerIdx: room.game.currentAttackerIdx,
                segmentStartAt: room.game.segmentStartAt,
                segmentEndAt: room.game.segmentEndAt,
                pausedAt: room.game.pausedAt
            } : null
        };
    }

    private barDurationMs(config: OnlineGameConfig): number {
        return config.beatsPerRound * 60_000 / config.bpm;
    }
}
