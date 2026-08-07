import { reactive } from 'vue';
import { io, type Socket } from 'socket.io-client';
import type { AudioEngine } from '../audio/AudioEngine';
import type {
    AcceptedHit,
    ActionAck,
    ClientToServerEvents,
    JoinIdentity,
    OnlineGameConfig,
    RoomAck,
    RoomSnapshot,
    ServerToClientEvents
} from '../shared/protocol';

type OnlineStage = 'menu' | 'lobby' | 'game' | 'result';

export interface OnlineViewState {
    active: boolean;
    stage: OnlineStage;
    connected: boolean;
    busy: boolean;
    error: string;
    name: string;
    roomCodeInput: string;
    room: RoomSnapshot | null;
    identity: JoinIdentity | null;
    latencyMs: number;
    elapsed: number;
    timeLeft: number;
    barIndex: number;
}

const IDENTITY_KEY = 'zterfusion-online-identity';

/**
 * 联机客户端只把用户意图发送给服务端，最终节奏与分数以房间快照为准。
 * 画面和声音仍在本机调度，避免每次按键都等待网络往返后才反馈。
 */
export class OnlineClient {
    readonly state = reactive<OnlineViewState>({
        active: false,
        stage: 'menu',
        connected: false,
        busy: false,
        error: '',
        name: '',
        roomCodeInput: '',
        room: null,
        identity: null,
        latencyMs: 0,
        elapsed: 0,
        timeLeft: 0,
        barIndex: -1
    });

    private readonly socket: Socket<ServerToClientEvents, ClientToServerEvents>;
    private clockOffsetMs = 0;
    private animationFrame: number | null = null;
    private canvas: HTMLCanvasElement | null = null;
    private context: CanvasRenderingContext2D | null = null;
    private seq = 0;
    private beatCount = Number.MIN_SAFE_INTEGER;
    private sessionId = '';
    private readonly hits = new Map<number, AcceptedHit[]>();

    constructor(private readonly audio: AudioEngine) {
        this.socket = io({ autoConnect: false });
        this.socket.on('connect', () => {
            this.state.connected = true;
            this.state.error = '';
            void this.syncClock().then(() => this.tryResume());
        });
        this.socket.on('disconnect', () => {
            this.state.connected = false;
            if (this.state.active) this.state.error = 'CONNECTION LOST · RETRYING';
        });
        this.socket.on('connect_error', () => {
            this.state.connected = false;
            if (this.state.active) this.state.error = 'SERVER UNAVAILABLE';
        });
        this.socket.on('room:snapshot', room => this.applySnapshot(room));
        this.socket.on('game:hit', hit => this.onAcceptedHit(hit));
        this.socket.on('game:score', update => {
            if (!this.state.room) return;
            this.state.room.players.forEach(player => {
                player.score = update.scores[player.id] || 0;
            });
        });
        this.socket.on('server:error', message => { this.state.error = message; });
    }

    enter(defaultName: string): void {
        this.state.active = true;
        this.state.name = String(defaultName || 'PLAYER').slice(0, 8);
        this.state.error = '';
        if (this.socket.connected) void this.tryResume();
        else this.socket.connect();
    }

    destroy(): void {
        this.stopLoop();
        this.socket.disconnect();
    }

    attachCanvas(canvas: HTMLCanvasElement): void {
        this.canvas = canvas;
        this.context = canvas.getContext('2d');
        this.resizeCanvas();
    }

    resizeCanvas(): void {
        if (!this.canvas) return;
        this.canvas.width = this.canvas.clientWidth || this.canvas.parentElement?.clientWidth || 800;
        this.canvas.height = 200;
    }

    async createRoom(): Promise<void> {
        if (!this.requireConnection()) return;
        // 创建/加入按钮本身是用户手势，趁此时解锁 AudioContext；否则访客等待房主
        // 开始时才收到网络事件，浏览器可能拒绝在非用户手势中启动声音。
        this.audio.init();
        await this.audio.resume();
        this.state.busy = true;
        this.state.error = '';
        const result = await this.emitRoom('room:create', { name: this.state.name });
        this.finishJoin(result);
    }

    async joinRoom(): Promise<void> {
        if (!this.requireConnection()) return;
        this.audio.init();
        await this.audio.resume();
        this.state.busy = true;
        this.state.error = '';
        const result = await this.emitRoom('room:join', {
            code: this.state.roomCodeInput,
            name: this.state.name
        });
        this.finishJoin(result);
    }

    async leaveRoom(): Promise<void> {
        if (this.socket.connected && this.state.room) {
            await this.emitAction('room:leave');
        }
        sessionStorage.removeItem(IDENTITY_KEY);
        this.stopGameView();
        this.state.identity = null;
        this.state.room = null;
        this.state.stage = 'menu';
        this.state.error = '';
    }

    backToLocal(): void {
        void this.leaveRoom();
        this.state.active = false;
    }

    async updateConfig(config: OnlineGameConfig): Promise<void> {
        const result = await this.emitAction('room:updateConfig', config);
        if (!result.ok) this.state.error = result.error;
    }

    async startGame(): Promise<void> {
        this.audio.init();
        await this.audio.resume();
        const result = await this.emitAction('game:start');
        if (!result.ok) this.state.error = result.error;
    }

    async restartGame(): Promise<void> {
        const result = await this.emitAction('game:restart');
        if (!result.ok) this.state.error = result.error;
    }

    async togglePause(): Promise<void> {
        const status = this.state.room?.status;
        if (status !== 'playing' && status !== 'paused') return;
        const result = await this.emitAction(status === 'paused' ? 'game:resume' : 'game:pause');
        if (!result.ok) this.state.error = result.error;
    }

    handleKeyDown(code: string, repeat: boolean): boolean {
        if (!this.state.active || this.state.stage !== 'game' || repeat) return false;
        if (code === 'Escape') {
            if (this.isOwner()) void this.togglePause();
            return true;
        }
        if (!this.state.room?.game || !this.state.identity || this.state.room.status !== 'playing') return false;
        this.submitHit();
        return true;
    }

    isOwner(): boolean {
        return !!this.state.room && this.state.room.ownerId === this.state.identity?.playerId;
    }

    localPlayerId(): string {
        return this.state.identity?.playerId || '';
    }

    private submitHit(): void {
        const room = this.state.room;
        const game = room?.game;
        if (!room || !game || !this.state.identity) return;
        const barDuration = this.barDurationMs(room.config);
        const elapsed = this.serverNow() - game.segmentStartAt;
        let barIndex = Math.floor(elapsed / barDuration);
        let offsetMs = elapsed - barIndex * barDuration;
        const playerIndex = room.players.findIndex(player => player.id === this.state.identity?.playerId);
        const isAttacker = playerIndex === game.currentAttackerIdx;
        const matchesRole = (index: number) => (index % 2 === 0) === isAttacker;
        const toleranceMs = 80;
        if (!matchesRole(barIndex) && barIndex > 0 && offsetMs < toleranceMs && matchesRole(barIndex - 1)) {
            barIndex--;
            offsetMs += barDuration;
        } else if (!matchesRole(barIndex) && offsetMs > barDuration - toleranceMs
            && matchesRole(barIndex + 1)) {
            barIndex++;
            offsetMs -= barDuration;
        }
        if (barIndex < 0 || !matchesRole(barIndex)) return;

        let delay = 0;
        if (isAttacker) {
            const snapped = this.quantize(room.config, offsetMs);
            delay = Math.max(0, snapped - offsetMs) / 1000;
        }
        this.audio.playPlayerSound(
            this.state.identity.playerId,
            playerIndex,
            room.players.length,
            isAttacker,
            delay,
            Math.max(room.players.length - 1, 1)
        );
        this.socket.emit('game:hit', {
            sessionId: game.sessionId,
            seq: ++this.seq,
            barIndex,
            offsetMs
        });
    }

    private applySnapshot(room: RoomSnapshot): void {
        const previousStatus = this.state.room?.status;
        this.state.room = room;
        this.state.error = '';
        if (room.game?.sessionId !== this.sessionId) {
            this.sessionId = room.game?.sessionId || '';
            this.hits.clear();
            this.seq = 0;
            this.beatCount = Number.MIN_SAFE_INTEGER;
        }
        if (room.status === 'lobby') {
            this.stopGameView();
            this.state.stage = 'lobby';
        } else if (room.status === 'results') {
            this.stopGameView();
            this.state.stage = 'result';
        } else {
            this.state.stage = 'game';
            this.audio.init();
            void this.audio.resume();
            if (room.status === 'paused') void this.audio.suspend();
            else if (previousStatus === 'paused') void this.audio.resume();
            this.startLoop();
        }
    }

    private onAcceptedHit(hit: AcceptedHit): void {
        const items = this.hits.get(hit.barIndex) || [];
        items.push(hit);
        this.hits.set(hit.barIndex, items);
        if (hit.playerId === this.state.identity?.playerId) return;
        const room = this.state.room;
        const game = room?.game;
        if (!room || !game) return;
        const playerIndex = room.players.findIndex(player => player.id === hit.playerId);
        const targetAt = game.segmentStartAt + hit.barIndex * this.barDurationMs(room.config) + hit.offsetMs;
        this.audio.playPlayerSound(
            hit.playerId,
            Math.max(0, playerIndex),
            room.players.length,
            hit.isAttacker,
            Math.max(0, targetAt - this.serverNow()) / 1000,
            Math.max(room.players.length - 1, 1)
        );
    }

    private startLoop(): void {
        if (this.animationFrame !== null) return;
        this.gameLoop();
    }

    private gameLoop = (): void => {
        const room = this.state.room;
        const game = room?.game;
        if (!this.state.active || this.state.stage !== 'game' || !room || !game) {
            this.animationFrame = null;
            return;
        }
        const timelineNow = room.status === 'paused' && game.pausedAt ? game.pausedAt : this.serverNow();
        const elapsedMs = timelineNow - game.segmentStartAt;
        const barDuration = this.barDurationMs(room.config);
        this.state.elapsed = elapsedMs / 1000;
        this.state.timeLeft = Math.max(0, (game.segmentEndAt - timelineNow) / 1000);
        this.state.barIndex = Math.floor(elapsedMs / barDuration);

        if (room.status !== 'paused') {
            const beat = Math.floor(elapsedMs / (60_000 / room.config.bpm));
            if (beat > this.beatCount) {
                this.beatCount = beat;
                const beatInBar = ((beat % room.config.beatsPerRound) + room.config.beatsPerRound)
                    % room.config.beatsPerRound;
                this.audio.playMetronomeBeat(beatInBar === 0);
            }
        }
        this.renderCanvas();
        this.animationFrame = requestAnimationFrame(this.gameLoop);
    };

    private renderCanvas(): void {
        const context = this.context;
        const canvas = this.canvas;
        const room = this.state.room;
        if (!context || !canvas || !room) return;
        const width = canvas.width;
        const height = canvas.height;
        const margin = 30;
        const trackWidth = width - margin * 2;
        context.clearRect(0, 0, width, height);
        context.fillStyle = '#111827';
        context.fillRect(0, 0, width, height);
        context.strokeStyle = '#334155';
        context.lineWidth = 2;
        context.beginPath();
        context.moveTo(margin, height / 2);
        context.lineTo(width - margin, height / 2);
        context.stroke();

        for (let beat = 0; beat <= room.config.beatsPerRound; beat++) {
            const x = margin + trackWidth * beat / room.config.beatsPerRound;
            context.strokeStyle = beat === 0 ? '#ffffff' : '#475569';
            context.beginPath();
            context.moveTo(x, 25);
            context.lineTo(x, height - 25);
            context.stroke();
        }
        const barDuration = this.barDurationMs(room.config);
        const progress = ((this.state.elapsed * 1000 % barDuration) + barDuration) % barDuration / barDuration;
        context.strokeStyle = '#ffffff';
        context.lineWidth = 3;
        context.beginPath();
        context.moveTo(margin + trackWidth * progress, 15);
        context.lineTo(margin + trackWidth * progress, height - 15);
        context.stroke();

        const visibleBar = this.state.barIndex;
        const attackBar = visibleBar % 2 === 0 ? visibleBar : visibleBar - 1;
        const hits = [
            ...(room.config.showAttackNotes ? (this.hits.get(attackBar) || []) : []),
            ...(this.hits.get(visibleBar) || []).filter(hit => !hit.isAttacker)
        ];
        hits.forEach(hit => {
            const player = room.players.find(item => item.id === hit.playerId);
            const x = margin + trackWidth * Math.max(0, Math.min(1, hit.offsetMs / barDuration));
            context.fillStyle = player?.color || '#ffffff';
            context.beginPath();
            context.arc(x, hit.isAttacker ? 75 : 125, hit.isAttacker ? 7 : 5, 0, Math.PI * 2);
            context.fill();
        });
    }

    private stopLoop(): void {
        if (this.animationFrame !== null) cancelAnimationFrame(this.animationFrame);
        this.animationFrame = null;
    }

    private stopGameView(): void {
        this.stopLoop();
        this.audio.stopAll();
        void this.audio.resume();
        this.state.elapsed = 0;
        this.state.timeLeft = 0;
        this.state.barIndex = -1;
    }

    private async tryResume(): Promise<void> {
        if (!this.state.active || this.state.identity || !this.socket.connected) return;
        let identity: JoinIdentity | null = null;
        try { identity = JSON.parse(sessionStorage.getItem(IDENTITY_KEY) || 'null') as JoinIdentity | null; }
        catch { sessionStorage.removeItem(IDENTITY_KEY); }
        if (!identity) return;
        const result = await this.emitRoom('room:resume', identity);
        if (result.ok) this.finishJoin(result);
        else sessionStorage.removeItem(IDENTITY_KEY);
    }

    private async syncClock(): Promise<void> {
        const samples: Array<{ rtt: number; offset: number }> = [];
        for (let index = 0; index < 5; index++) {
            const sentAt = Date.now();
            const serverNow = await new Promise<number>(resolve => {
                this.socket.emit('clock:ping', sentAt, resolve);
            });
            const receivedAt = Date.now();
            samples.push({
                rtt: receivedAt - sentAt,
                offset: serverNow - (sentAt + receivedAt) / 2
            });
        }
        samples.sort((a, b) => a.rtt - b.rtt);
        this.clockOffsetMs = samples[0]?.offset || 0;
        this.state.latencyMs = Math.round((samples[0]?.rtt || 0) / 2);
    }

    private serverNow(): number {
        return Date.now() + this.clockOffsetMs;
    }

    private finishJoin(result: RoomAck): void {
        this.state.busy = false;
        if (!result.ok) {
            this.state.error = result.error;
            return;
        }
        this.state.identity = result.identity;
        // sessionStorage 刷新后仍在，但不同标签页彼此隔离，便于同一浏览器开多个玩家。
        sessionStorage.setItem(IDENTITY_KEY, JSON.stringify(result.identity));
        this.applySnapshot(result.room);
    }

    private requireConnection(): boolean {
        if (this.socket.connected) return true;
        this.state.error = 'SERVER UNAVAILABLE';
        return false;
    }

    private emitRoom<Event extends 'room:create' | 'room:join' | 'room:resume'>(
        event: Event,
        payload: Parameters<ClientToServerEvents[Event]>[0]
    ): Promise<RoomAck> {
        return new Promise(resolve => {
            const timer = window.setTimeout(() => resolve({ ok: false, error: 'REQUEST TIMEOUT' }), 5000);
            // 泛型事件联合难以让 Socket.IO 推导出对应重载，这里已经由共享协议约束 payload。
            (this.socket.emit as (...args: unknown[]) => void)(event, payload, (result: RoomAck) => {
                window.clearTimeout(timer);
                resolve(result);
            });
        });
    }

    private emitAction(
        event: 'room:leave' | 'game:start' | 'game:pause' | 'game:resume' | 'game:restart'
    ): Promise<ActionAck>;
    private emitAction(event: 'room:updateConfig', payload: OnlineGameConfig): Promise<ActionAck>;
    private emitAction(
        event: 'room:leave' | 'room:updateConfig' | 'game:start' | 'game:pause' | 'game:resume' | 'game:restart',
        payload?: OnlineGameConfig
    ): Promise<ActionAck> {
        return new Promise(resolve => {
            const timer = window.setTimeout(() => resolve({ ok: false, error: 'REQUEST TIMEOUT' }), 5000);
            const done = (result: ActionAck) => {
                window.clearTimeout(timer);
                resolve(result);
            };
            if (payload) (this.socket.emit as (...args: unknown[]) => void)(event, payload, done);
            else (this.socket.emit as (...args: unknown[]) => void)(event, done);
        });
    }

    private barDurationMs(config: OnlineGameConfig): number {
        return config.beatsPerRound * 60_000 / config.bpm;
    }

    private quantize(config: OnlineGameConfig, offsetMs: number): number {
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
        return best;
    }
}
