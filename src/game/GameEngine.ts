import { reactive, ref, type Ref } from 'vue';
import { DEFAULT_LIBRARY_SOUNDS } from '../audioLibrary';
import { GAME_NUMBERS, createDefaultConfig } from '../config';
import { AudioEngine } from '../audio/AudioEngine';
import type {
    AnimationEffect,
    GameConfig,
    GameNumbers,
    GameState,
    KeyBinding,
    Mode,
    Note,
    Player
} from '../types';

const PLAYER_COLORS = ['#00ff88', '#00aaff', '#ff00aa', '#ffcc00', '#ff6644', '#aa66ff'];
const SYS_PLAYER: Player = { id: 'sys', name: 'CPU', color: '#eeeeee', keys: [] };
const STORAGE_KEY = 'rhythm-party-settings';
const BEST_KEY_B = 'rhythm-party-best-b';
const AUDIO_BASE = `${import.meta.env.BASE_URL}audios/`;
const CANVAS_MARGIN = 30;
const DIGIT_WINDOW = 200;

function createInitialState(): GameState {
    return {
        phase: 'idle',
        screen: 'config',
        currentRound: 0,
        currentAttackerIdx: 0,
        startTime: 0,
        pausedTime: 0,
        elapsed: 0,
        timeLeft: 0,
        barIndex: -1,
        systemScheduledFor: null,
        strikes: 0,
        prevRhythm: {},
        bpm: 0,
        forcedEnd: false,
        beatCount: -1,
        attackNotes: [],
        pendingAttack: [],
        defenderHits: {},
        scorePending: false,
        scoreAt: 0,
        ending: false,
        endingAtBar: null,
        scores: {},
        totalScores: {},
        animEffects: [],
        resultTeamScore: 0,
        resultBestScore: 0,
        resultNewRecord: false
    };
}

/**
 * 节奏游戏引擎。
 *
 * 迁移后，时间轴/计分/Canvas 仍集中在一个可测试的类中，Vue 组件只读取响应式
 * state 并发出用户意图，避免把 rAF 和 AudioContext 的精确时序拆散到模板里。
 */
export class GameEngine {
    readonly numbers: GameNumbers = GAME_NUMBERS;
    readonly config: GameConfig = reactive(createDefaultConfig());
    readonly players = reactive<Player[]>([]);
    readonly state: GameState = reactive(createInitialState());
    readonly librarySounds: Ref<string[]> = ref([]);

    private canvas: HTMLCanvasElement | null = null;
    private canvasContext: CanvasRenderingContext2D | null = null;
    private animationFrame: number | null = null;
    private transitionTimer: number | null = null;
    private readyDigit: { value: number | null; time: number } = { value: null, time: 0 };

    constructor(private readonly audio: AudioEngine) {
        if (!this.loadSettings()) this.loadDefaultPlayers();
        this.ensureScoreRecords();
    }

    init(): void {
        void this.loadLibraryList();
    }

    attachCanvas(canvas: HTMLCanvasElement): void {
        this.canvas = canvas;
        this.canvasContext = canvas.getContext('2d');
        this.resizeCanvas();
    }

    resizeCanvas(): void {
        if (!this.canvas) return;
        const width = this.canvas.clientWidth || this.canvas.parentElement?.clientWidth || 800;
        this.canvas.width = width;
        this.canvas.height = 200;
    }

    async loadLibraryList(): Promise<void> {
        let sounds: string[] = [];
        try {
            const response = await fetch(AUDIO_BASE);
            const html = await response.text();
            sounds = [...html.matchAll(/href="([^"?]+\.(?:wav|mp3|ogg|m4a|flac))"/gi)]
                .map(match => decodeURIComponent(match[1]))
                .filter(name => !name.includes('/'))
                .filter(name => name !== 'attack.wav' && name !== 'defend.wav' && name !== 'tick.wav');
        } catch (error) {
            console.warn('[Library] directory index unavailable, using built-in list', error);
        }
        this.librarySounds.value = sounds.length ? sounds : DEFAULT_LIBRARY_SOUNDS.slice();
    }

    private loadSettings(): boolean {
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            if (!raw) return false;
            const data = JSON.parse(raw) as {
                config?: Partial<GameConfig>;
                players?: Array<Partial<Player> & { id: string; name: string }>;
            };
            if (data.config) Object.assign(this.config, data.config);
            this.normalizeConfig();
            if (Array.isArray(data.players) && data.players.length >= 2) {
                this.players.splice(0, this.players.length, ...data.players.map((player, index) => ({
                    id: player.id,
                    name: String(player.name || `P${index + 1}`).slice(0, 8),
                    keys: Array.isArray(player.keys) ? player.keys as KeyBinding[] : [],
                    color: PLAYER_COLORS[index % PLAYER_COLORS.length],
                    score: 0,
                    soundSource: player.soundSource || (player.soundName ? 'custom' : 'default'),
                    soundName: player.soundName || null,
                    volumeDb: player.volumeDb || 0
                })));
                this.normalizePlayerIds();
            } else {
                return false;
            }
            return true;
        } catch (error) {
            console.error('[Settings] load failed', error);
            return false;
        }
    }

    saveSettings(): void {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify({
                config: this.config,
                players: this.players.map(player => ({
                    id: player.id,
                    name: player.name,
                    keys: player.keys,
                    soundSource: player.soundSource || 'default',
                    soundName: player.soundName || null,
                    volumeDb: player.volumeDb || 0
                }))
            }));
        } catch (error) {
            console.error('[Settings] save failed', error);
        }
    }

    private loadDefaultPlayers(): void {
        this.players.splice(0, this.players.length,
            { id: 'p1', name: 'Zizhi', keys: [{ key: 'a', code: 'KeyA' }], color: PLAYER_COLORS[0], score: 0 },
            { id: 'p2', name: 'P2', keys: [{ key: 'l', code: 'KeyL' }], color: PLAYER_COLORS[1], score: 0 }
        );
    }

    private normalizeConfig(): void {
        const defaults = createDefaultConfig();
        if (!['casual', 'challenge-a', 'challenge-b'].includes(this.config.mode)) {
            this.config.mode = defaults.mode;
        }
        const ranges: Record<'bpm' | 'beatsPerRound' | 'rounds' | 'timePerRound', [number, number]> = {
            bpm: [60, 240],
            beatsPerRound: [2, 16],
            rounds: [1, 10],
            timePerRound: [10, 120]
        };
        (Object.keys(ranges) as Array<keyof typeof ranges>).forEach(key => {
            const value = Number(this.config[key]);
            const [min, max] = ranges[key];
            this.config[key] = Number.isFinite(value)
                ? Math.max(min, Math.min(max, Math.round(value)))
                : defaults[key];
        });
        const allowedGrids = new Set([8, 12, 16, 24]);
        const grids = Array.isArray(this.config.grids)
            ? [...new Set(this.config.grids.map(Number).filter(grid => allowedGrids.has(grid)))]
            : [];
        this.config.grids = grids.length ? grids : defaults.grids.slice();
        this.config.showAttackNotes = this.config.showAttackNotes !== false;
    }

    private normalizePlayerIds(): void {
        const used = new Set<string>();
        this.players.forEach(player => {
            let id = player.id;
            if (!id || used.has(id)) id = this.nextPlayerId(used);
            player.id = id;
            used.add(id);
        });
    }

    private nextPlayerId(extraUsed?: Set<string>): string {
        const used = extraUsed || new Set(this.players.map(player => player.id));
        let index = 1;
        while (used.has(`p${index}`)) index++;
        return `p${index}`;
    }

    private ensureScoreRecords(): void {
        this.players.forEach(player => {
            if (this.state.totalScores[player.id] === undefined) this.state.totalScores[player.id] = 0;
        });
    }

    setMode(mode: Mode): void {
        if (mode === 'challenge-c') return;
        this.config.mode = mode;
        this.saveSettings();
    }

    setNumberSetting(key: 'bpm' | 'beatsPerRound' | 'rounds' | 'timePerRound', value: number): void {
        const ranges = {
            bpm: [60, 240],
            beatsPerRound: [2, 16],
            rounds: [1, 10],
            timePerRound: [10, 120]
        } as const;
        const [min, max] = ranges[key];
        const fallback = createDefaultConfig()[key];
        const normalized = Number.isFinite(value) && value > 0 ? Math.round(value) : fallback;
        this.config[key] = Math.max(min, Math.min(max, normalized));
        this.saveSettings();
    }

    setGrids(grids: number[]): void {
        this.config.grids = grids.length ? grids : [16];
        this.saveSettings();
    }

    setShowAttackNotes(value: boolean): void {
        this.config.showAttackNotes = value;
        this.saveSettings();
    }

    applyPreset(preset: 'visual' | 'audio'): void {
        this.config.showAttackNotes = preset === 'visual';
        this.config.grids = preset === 'visual' ? [16] : [8];
        this.saveSettings();
    }

    addPlayer(): boolean {
        if (this.players.length >= 6) return false;
        const index = this.players.length;
        const playerId = this.nextPlayerId();
        const defaultKeys: KeyBinding[][] = [
            [{ key: 'a', code: 'KeyA' }], [{ key: 'l', code: 'KeyL' }],
            [{ key: 'f', code: 'KeyF' }], [{ key: 'j', code: 'KeyJ' }],
            [{ key: 'd', code: 'KeyD' }], [{ key: 'k', code: 'KeyK' }]
        ];
        this.players.push({
            id: playerId,
            name: playerId.toUpperCase(),
            keys: defaultKeys[index] || [{ key: 'Space', code: 'Space' }],
            color: PLAYER_COLORS[index % PLAYER_COLORS.length],
            score: 0
        });
        this.ensureScoreRecords();
        this.saveSettings();
        return true;
    }

    removePlayer(playerId: string): boolean {
        if (this.players.length <= 2) return false;
        const index = this.players.findIndex(player => player.id === playerId);
        if (index < 0) return false;
        this.players.splice(index, 1);
        this.players.forEach((player, i) => { player.color = PLAYER_COLORS[i % PLAYER_COLORS.length]; });
        this.audio.setPlayerSound(playerId, null);
        delete this.state.totalScores[playerId];
        delete this.state.scores[playerId];
        delete this.state.defenderHits[playerId];
        delete this.state.prevRhythm[playerId];
        this.saveSettings();
        return true;
    }

    setPlayerName(playerId: string, name: string): void {
        const player = this.players.find(item => item.id === playerId);
        if (player) {
            player.name = name.slice(0, 8);
            this.saveSettings();
        }
    }

    setPlayerKeys(playerId: string, keys: KeyBinding[]): boolean {
        const conflict = this.players.some(player =>
            player.id !== playerId && keys.some(key => player.keys.some(item => item.code === key.code))
        );
        if (conflict) return false;
        const player = this.players.find(item => item.id === playerId);
        if (!player) return false;
        player.keys = keys;
        this.saveSettings();
        return true;
    }

    async setPlayerSound(playerId: string, soundName: string): Promise<void> {
        const player = this.players.find(item => item.id === playerId);
        if (!player) return;
        player._libLoaded = false;
        if (!soundName) {
            player.soundSource = 'default';
            player.soundName = null;
            this.audio.setPlayerSound(playerId, null);
        } else {
            player.soundSource = 'library';
            player.soundName = soundName;
            this.audio.init();
            await this.audio.loadPlayerLibrarySound(player);
        }
        this.saveSettings();
    }

    async uploadPlayerSound(playerId: string, file: File): Promise<void> {
        const player = this.players.find(item => item.id === playerId);
        if (!player) return;
        this.audio.init();
        await this.audio.resume();
        const buffer = await this.audio.decodeAudio(await file.arrayBuffer());
        this.audio.setPlayerSound(playerId, buffer);
        this.audio.setPlayerGain(playerId, Math.pow(10, (player.volumeDb || 0) / 20));
        player.soundSource = 'custom';
        player._libLoaded = false;
        player.soundName = file.name.length > 16 ? `${file.name.slice(0, 14)}…` : file.name;
        this.saveSettings();
    }

    setPlayerVolume(playerId: string, volumeDb: number): void {
        const player = this.players.find(item => item.id === playerId);
        if (!player) return;
        player.volumeDb = Math.max(-24, Math.min(6, Math.round(volumeDb)));
        this.audio.setPlayerGain(playerId, Math.pow(10, player.volumeDb / 20));
        this.saveSettings();
    }

    resetSettings(): void {
        if (!window.confirm('Clear ALL settings and players?')) return;
        localStorage.removeItem(STORAGE_KEY);
        window.location.reload();
    }

    isChallenge(): boolean {
        return this.config.mode === 'challenge-a';
    }

    isChallengeB(): boolean {
        return this.config.mode === 'challenge-b';
    }

    currentAttacker(): Player {
        return this.isChallenge() ? SYS_PLAYER : (this.players[this.state.currentAttackerIdx] || SYS_PLAYER);
    }

    currentDefenders(): Player[] {
        return this.players.filter((_, index) => index !== this.state.currentAttackerIdx);
    }

    effectiveBpm(): number {
        return this.isChallengeB() ? (this.state.bpm || this.config.bpm) : this.config.bpm;
    }

    barDuration(): number {
        return this.config.beatsPerRound * 60 / this.effectiveBpm();
    }

    readyDuration(): number {
        return this.numbers.readyBars * this.barDuration();
    }

    teamTotal(): number {
        return this.players.reduce((sum, player) =>
            sum + (this.state.totalScores[player.id] || 0) + (this.state.scores[player.id] || 0), 0);
    }

    startGame(): boolean {
        const minimumPlayers = this.isChallenge() ? 1 : 2;
        if (this.players.length < minimumPlayers) {
            window.alert(`Need at least ${minimumPlayers} player${minimumPlayers === 1 ? '' : 's'}!`);
            return false;
        }
        if (this.transitionTimer !== null) window.clearTimeout(this.transitionTimer);
        this.transitionTimer = null;
        this.audio.init();
        void this.audio.resume();
        this.players.forEach(player => { void this.audio.loadPlayerLibrarySound(player); });
        this.players.forEach(player => { this.state.totalScores[player.id] = 0; });
        this.state.currentRound = 0;
        this.state.strikes = 0;
        this.state.prevRhythm = {};
        this.state.bpm = this.config.bpm;
        this.state.forcedEnd = false;
        this.startRound(this.isChallenge() ? -1 : 0);
        return true;
    }

    private startRound(attackerIdx: number): void {
        this.state.currentAttackerIdx = attackerIdx;
        this.state.startTime = performance.now();
        this.state.pausedTime = 0;
        this.state.elapsed = 0;
        this.state.timeLeft = this.config.timePerRound;
        this.state.barIndex = -1;
        this.state.systemScheduledFor = null;
        this.state.beatCount = -1;
        this.state.attackNotes = [];
        this.state.pendingAttack = [];
        this.state.defenderHits = {};
        this.state.scorePending = false;
        this.state.scoreAt = 0;
        this.state.ending = false;
        this.state.endingAtBar = null;
        this.state.scores = {};
        this.state.animEffects = [];
        this.players.forEach(player => {
            this.state.defenderHits[player.id] = [];
            this.state.scores[player.id] = 0;
        });

        if (this.isChallengeB()) {
            const challenge = this.numbers.challengeB;
            const nextBpm = Math.min(
                challenge.maxBpm,
                this.config.bpm + Math.floor(this.teamTotal() / challenge.scorePerStep) * challenge.bpmStep
            );
            if (this.state.bpm && nextBpm > this.state.bpm) {
                this.state.animEffects.push({
                    type: 'info',
                    text: `SPEED UP ${nextBpm}BPM`,
                    color: '#ffcc00',
                    time: performance.now(),
                    x: (this.canvas?.width || 800) / 2 - 60,
                    y: 100
                });
            }
            this.state.bpm = nextBpm;
        }

        this.state.screen = 'game';
        this.state.phase = 'playing';
        this.resizeCanvas();
        this.state.startTime = performance.now() + this.readyDuration() * 1000;
        this.state.beatCount = -this.numbers.readyBars * this.config.beatsPerRound - 1;
        this.startGameLoop();
    }

    private startGameLoop(): void {
        if (this.animationFrame !== null) cancelAnimationFrame(this.animationFrame);
        this.gameLoop();
    }

    private gameLoop = (): void => {
        if (this.state.phase !== 'playing') return;
        const now = performance.now();
        const elapsed = (now - this.state.startTime) / 1000;
        const timeLeft = Math.max(0, this.config.timePerRound - Math.max(0, elapsed));
        this.state.elapsed = elapsed;
        this.state.timeLeft = timeLeft;

        const barIdx = Math.floor(elapsed / this.barDuration());
        if (barIdx !== this.state.barIndex) this.onBarBoundary(barIdx);

        if (this.isChallenge() && !this.state.ending && (barIdx < 0 || !this.isAttackBar(barIdx))) {
            const nextBar = barIdx + 1;
            if (nextBar >= 0 && this.isAttackBar(nextBar)
                && this.state.systemScheduledFor !== nextBar
                && elapsed >= nextBar * this.barDuration() - 0.1) {
                this.scheduleSystemBar(nextBar, elapsed);
            }
        }

        if (this.state.scorePending && elapsed >= this.state.scoreAt) {
            this.state.scorePending = false;
            this.scorePair();
            if (this.state.ending) {
                this.endSubRound();
                return;
            }
        }

        if (timeLeft <= 0 && !this.state.ending) {
            this.state.ending = true;
            this.state.endingAtBar = barIdx;
        }

        if (this.state.barIndex < 0 && this.readyDigit.value !== null
            && now - this.readyDigit.time > DIGIT_WINDOW) {
            this.applyReadyBeats(this.readyDigit.value);
            this.readyDigit.value = null;
        }

        const totalBeats = elapsed * this.effectiveBpm() / 60;
        const currentBeatNum = Math.floor(totalBeats);
        if (currentBeatNum > this.state.beatCount) {
            this.state.beatCount = currentBeatNum;
            const beatInCycle = ((currentBeatNum % this.config.beatsPerRound) + this.config.beatsPerRound)
                % this.config.beatsPerRound;
            const pan = this.isChallenge()
                ? 0
                : this.audio.getPlayerPan(this.state.currentAttackerIdx, this.players.length);
            this.audio.playMetronomeBeat(beatInCycle === 0, pan);
        }

        this.renderCanvas(elapsed);
        this.animationFrame = requestAnimationFrame(this.gameLoop);
    };

    onReadyDigit(digit: number): void {
        if (this.state.phase !== 'playing' || this.state.barIndex >= 0) return;
        const now = performance.now();
        if (this.readyDigit.value !== null && now - this.readyDigit.time <= DIGIT_WINDOW) {
            const combined = this.readyDigit.value * 10 + digit;
            this.readyDigit.value = null;
            this.applyReadyBeats(combined);
        } else {
            this.readyDigit.value = digit;
            this.readyDigit.time = now;
        }
    }

    private applyReadyBeats(beats: number): void {
        const nextBeats = Math.max(2, Math.min(16, beats));
        this.config.beatsPerRound = nextBeats;
        this.saveSettings();
        this.state.startTime = performance.now() + this.readyDuration() * 1000;
        this.state.beatCount = -this.numbers.readyBars * nextBeats - 1;
        this.state.barIndex = -this.numbers.readyBars;
        this.state.animEffects.push({
            type: 'info', text: `${nextBeats} BEATS`, color: '#ffffff',
            time: performance.now(), x: (this.canvas?.width || 800) / 2 - 40, y: 100
        });
    }

    private isAttackBar(barIndex: number): boolean {
        return barIndex % 2 === 0;
    }

    private onBarBoundary(newBar: number): void {
        const previousBar = this.state.barIndex;
        if (newBar < 0) {
            this.state.barIndex = newBar;
            return;
        }

        if (previousBar >= 0 && !this.isAttackBar(previousBar)) {
            this.state.scoreAt = newBar * this.barDuration() + this.numbers.tolerance;
            this.state.scorePending = true;
        }

        if (this.isAttackBar(newBar)) {
            if (this.isChallenge() && this.state.systemScheduledFor !== newBar) {
                this.scheduleSystemBar(newBar, newBar * this.barDuration());
            }
        } else {
            if (this.isChallengeB()
                && (!this.state.ending || this.state.endingAtBar === null
                    || newBar - 1 <= this.state.endingAtBar)) {
                const challenge = this.numbers.challengeB;
                const attacker = this.players[this.state.currentAttackerIdx];
                if (attacker) {
                    const beatDuration = 60 / this.effectiveBpm();
                    const offsets = this.state.attackNotes
                        .map(note => Math.round(note.offset / beatDuration * 1000) / 1000)
                        .sort((a, b) => a - b);
                    const tooFew = offsets.length < challenge.minNotes;
                    const previous = this.state.prevRhythm[attacker.id];
                    const repeated = !tooFew && !!previous && offsets.length === previous.length
                        && offsets.every((offset, index) => Math.abs(offset - previous[index]) < 1e-6);
                    if (tooFew || repeated) {
                        this.state.strikes++;
                        this.state.animEffects.push({
                            type: 'info',
                            text: `${tooFew ? 'TOO FEW NOTES!' : 'SAME RHYTHM!'} MISS ${this.state.strikes}/${challenge.maxStrikes}`,
                            color: '#ff4444',
                            time: performance.now(),
                            x: (this.canvas?.width || 800) / 2 - 110,
                            y: 100
                        });
                        if (this.state.strikes >= challenge.maxStrikes) {
                            this.state.forcedEnd = true;
                            this.state.ending = true;
                            this.state.endingAtBar = newBar;
                        }
                    }
                    if (!tooFew) this.state.prevRhythm[attacker.id] = offsets;
                }
            }

            if (!this.isChallenge()) {
                const rawAccuracy = this.state.attackNotes.reduce((sum, note) => sum + (note.acc || 0), 0);
                const accuracyGain = this.softCap(rawAccuracy);
                const attacker = this.players[this.state.currentAttackerIdx];
                if (attacker && accuracyGain > 0) {
                    this.state.scores[attacker.id] = (this.state.scores[attacker.id] || 0) + accuracyGain;
                    this.addAnimEffect('hit', attacker.id, accuracyGain);
                }
            }
            this.state.pendingAttack = this.state.attackNotes;
            this.state.attackNotes = [];
        }

        this.state.barIndex = newBar;
        if (this.numbers.truncateAtBarBoundary && this.state.startTime) {
            this.audio.clearBarTails(this.state.startTime + newBar * this.barDuration() * 1000);
        }
    }

    private scorePair(): void {
        const attacks = this.state.pendingAttack;
        this.state.pendingAttack = [];
        if (attacks.length > 0) {
            const attacker = this.isChallenge() ? null : this.players[this.state.currentAttackerIdx];
            this.players.forEach((player, index) => {
                if (index === this.state.currentAttackerIdx) return;
                const hits = this.state.defenderHits[player.id] || [];
                const pairs: Array<{ attackIndex: number; hitIndex: number; error: number }> = [];
                attacks.forEach((attack, attackIndex) => {
                    hits.forEach((hit, hitIndex) => {
                        const error = Math.abs(hit.offset - attack.offset);
                        if (error < this.numbers.defend.matchWindow) {
                            pairs.push({ attackIndex, hitIndex, error });
                        }
                    });
                });
                pairs.sort((a, b) => a.error - b.error);
                const usedAttacks = new Set<number>();
                const usedHits = new Set<number>();
                let gained = 0;
                pairs.forEach(pair => {
                    if (usedAttacks.has(pair.attackIndex) || usedHits.has(pair.hitIndex)) return;
                    usedAttacks.add(pair.attackIndex);
                    usedHits.add(pair.hitIndex);
                    gained += this.calcScore(pair.error);
                });
                gained = this.softCap(gained);
                if (gained > 0) {
                    this.state.scores[player.id] = (this.state.scores[player.id] || 0) + gained;
                    if (attacker) {
                        this.state.scores[attacker.id] = (this.state.scores[attacker.id] || 0) + gained;
                    }
                    this.addAnimEffect('hit', player.id, gained);
                }
            });
        }
        this.players.forEach(player => { this.state.defenderHits[player.id] = []; });
    }

    private calcScore(error: number): number {
        const defend = this.numbers.defend;
        if (error <= defend.perfectWindow) return defend.pointsPerNote;
        if (error >= defend.matchWindow) return 0;
        return Math.round(defend.pointsPerNote *
            (1 - (error - defend.perfectWindow) / (defend.matchWindow - defend.perfectWindow)));
    }

    private attackAccuracy(offset: number): number {
        const attack = this.numbers.attack;
        const gridStep = (60 / this.effectiveBpm()) * 4 / attack.grid;
        const error = Math.abs(offset - Math.round(offset / gridStep) * gridStep);
        if (error <= attack.perfectWindow) return attack.pointsPerNote;
        if (error >= attack.maxWindow) return 0;
        return Math.round(attack.pointsPerNote *
            (1 - (error - attack.perfectWindow) / (attack.maxWindow - attack.perfectWindow)));
    }

    private quantizeOffset(offset: number): number {
        const grids = this.config.grids.length ? this.config.grids : [16];
        const beatDuration = 60 / this.effectiveBpm();
        let best = offset;
        let bestError = Infinity;
        grids.forEach(grid => {
            const step = beatDuration * 4 / grid;
            const snapped = Math.round(offset / step) * step;
            const error = Math.abs(snapped - offset);
            if (error < bestError) {
                bestError = error;
                best = snapped;
            }
        });
        return best;
    }

    private softCap(score: number): number {
        const knee = this.numbers.softCapKnee;
        const limit = this.numbers.softCapLimit;
        if (score <= knee) return Math.round(score);
        return Math.round(knee + limit * (1 - Math.exp(-(score - knee) / limit)));
    }

    private generateChallengeNotes(): Note[] {
        const challenge = this.numbers.challengeA;
        const barDuration = this.barDuration();
        const beatDuration = 60 / this.effectiveBpm();
        const grids = this.config.grids.length ? this.config.grids : [16];
        const points = new Set<number>();
        grids.forEach(grid => {
            const step = beatDuration * 4 / grid;
            const count = Math.round(barDuration / step);
            for (let index = 0; index < count; index++) {
                points.add(Math.round(index * step * 1000) / 1000);
            }
        });
        const sorted = [...points].sort((a, b) => a - b);
        const notes = sorted.filter(() => Math.random() < challenge.density).map(offset => ({ offset }));
        while (notes.length < Math.min(challenge.minNotes, sorted.length)) {
            const offset = sorted[Math.floor(Math.random() * sorted.length)];
            if (!notes.some(note => Math.abs(note.offset - offset) < 1e-6)) {
                notes.push({ offset });
                notes.sort((a, b) => a.offset - b.offset);
            }
        }
        return notes;
    }

    private scheduleSystemBar(barIndex: number, elapsed: number): void {
        this.state.systemScheduledFor = barIndex;
        const barStart = barIndex * this.barDuration();
        this.state.attackNotes = this.generateChallengeNotes();
        this.state.attackNotes.forEach(note => {
            this.audio.playSystemNote(Math.max(0, barStart + note.offset - elapsed));
        });
    }

    /** 根据实际落点小节处理一个玩家按键。 */
    onPlayerKeydown(playerId: string, time: number): void {
        if (this.state.phase !== 'playing') return;
        const playerIndex = this.players.findIndex(player => player.id === playerId);
        if (playerIndex < 0) return;
        const isAttacker = playerIndex === this.state.currentAttackerIdx;
        const elapsed = (time - this.state.startTime) / 1000;
        if (elapsed < -this.numbers.tolerance) return;

        const barDuration = this.barDuration();
        let barIndex = Math.floor(elapsed / barDuration);
        let offset = elapsed - barIndex * barDuration;
        let isLate = false;
        let earlyDelay = 0;
        const matchesRole = (index: number) => this.isAttackBar(index) === isAttacker;

        if (!matchesRole(barIndex) && barIndex > 0 && offset < this.numbers.tolerance
            && matchesRole(barIndex - 1)) {
            barIndex -= 1;
            offset = elapsed - barIndex * barDuration;
            isLate = true;
        } else if (!matchesRole(barIndex) && offset > barDuration - this.numbers.tolerance
            && matchesRole(barIndex + 1)) {
            barIndex += 1;
            offset = elapsed - barIndex * barDuration;
            earlyDelay = -offset;
        }

        if (this.state.ending && isAttacker && this.state.endingAtBar !== null
            && barIndex > this.state.endingAtBar) return;

        const attackBar = this.isAttackBar(barIndex);
        if (attackBar && isAttacker) {
            const snapped = this.quantizeOffset(offset);
            const target = offset > barDuration ? this.state.pendingAttack : this.state.attackNotes;
            if (target.some(note => Math.abs(note.offset - snapped) < 1e-6)) return;
            const delay = Math.max(0, snapped - offset);
            const cancelledEarly = !isLate
                && this.audio.playPlayerSound(playerId, playerIndex, this.players.length, true, delay);
            if (cancelledEarly) this.removeLatestEarlyNote(this.state.attackNotes);
            target.push({ offset: snapped, acc: this.attackAccuracy(offset), early: offset < 0 });
            this.addAnimEffect('attack', playerId);
        } else if (!attackBar && !isAttacker) {
            const cancelledEarly = !isLate
                && this.audio.playPlayerSound(
                    playerId,
                    playerIndex,
                    this.players.length,
                    false,
                    earlyDelay,
                    this.currentDefenders().length
                );
            if (cancelledEarly) this.removeLatestEarlyNote(this.state.defenderHits[playerId]);
            this.state.defenderHits[playerId].push({ offset });
            this.addAnimEffect('defend', playerId);
        }
    }

    /** 键码可能同时绑定给多个玩家；返回 true 让 InputSystem 吃掉浏览器默认行为。 */
    handleGameKey(code: string, time: number): boolean {
        if (this.state.phase !== 'playing') return false;
        let used = false;
        this.players.forEach(player => {
            if (player.keys.some(key => key.code === code)) {
                used = true;
                this.onPlayerKeydown(player.id, time);
            }
        });
        return used;
    }

    previewPlayerSound(code: string): void {
        if (this.state.phase !== 'idle' || this.state.screen !== 'config') return;
        this.players.forEach((player, index) => {
            if (!player.keys.some(key => key.code === code)) return;
            this.audio.init();
            void this.audio.resume();
            if (player.soundSource === 'library') void this.audio.loadPlayerLibrarySound(player);
            this.audio.playPlayerSound(player.id, index, this.players.length, true);
        });
    }

    private removeLatestEarlyNote(notes: Note[] | undefined): void {
        if (!notes) return;
        for (let index = notes.length - 1; index >= 0; index--) {
            if (notes[index].early || notes[index].offset < 0) {
                notes.splice(index, 1);
                return;
            }
        }
    }

    private addAnimEffect(type: AnimationEffect['type'], playerId?: string, score?: number): void {
        const player = playerId ? this.players.find(item => item.id === playerId) : undefined;
        this.state.animEffects.push({
            type,
            playerId,
            score,
            color: player?.color || '#ffffff',
            time: performance.now(),
            x: 60 + Math.random() * Math.max(1, (this.canvas?.width || 800) - 120),
            y: 100
        });
    }

    private renderCanvas(elapsed: number): void {
        const context = this.canvasContext;
        const canvas = this.canvas;
        if (!context || !canvas) return;
        const width = canvas.width;
        const height = canvas.height;
        context.clearRect(0, 0, width, height);
        context.fillStyle = '#1a1a2e';
        context.fillRect(0, 0, width, height);

        const barDuration = this.barDuration();
        const barIndex = Math.floor(elapsed / barDuration);
        const barProgress = Math.min((elapsed - barIndex * barDuration) / barDuration, 1);
        const isReady = barIndex < 0;
        const attackBar = this.isAttackBar(barIndex);
        const attacker = this.currentAttacker();
        const defenders = this.currentDefenders();
        const boxX = CANVAS_MARGIN;
        const boxWidth = width - CANVAS_MARGIN * 2;
        const laneHeight = height * 0.55;
        const laneTop = (height - laneHeight) / 2 + 10;
        const cellWidth = boxWidth / this.config.beatsPerRound;

        context.fillStyle = '#0d0d1a';
        context.fillRect(boxX, laneTop, boxWidth, laneHeight);
        const beatInBar = Math.min(Math.floor(barProgress * this.config.beatsPerRound), this.config.beatsPerRound - 1);
        context.globalAlpha = 0.1;
        context.fillStyle = isReady ? '#888899' : attackBar ? attacker.color : (defenders[0]?.color || '#ffffff');
        context.fillRect(boxX + beatInBar * cellWidth, laneTop, cellWidth, laneHeight);
        context.globalAlpha = 1;

        context.strokeStyle = '#2d2d44';
        context.lineWidth = 2;
        for (let index = 0; index <= this.config.beatsPerRound; index++) {
            const x = boxX + index * cellWidth;
            context.beginPath();
            context.moveTo(x, laneTop);
            context.lineTo(x, laneTop + laneHeight);
            context.stroke();
        }

        let frameStyle: string | CanvasGradient;
        if (isReady) frameStyle = '#555577';
        else if (attackBar || defenders.length === 1) frameStyle = attackBar ? attacker.color : defenders[0].color;
        else {
            const gradient = context.createLinearGradient(boxX, 0, boxX + boxWidth, 0);
            defenders.forEach((defender, index) => {
                gradient.addColorStop(defenders.length === 1 ? 0 : index / (defenders.length - 1), defender.color);
            });
            frameStyle = gradient;
        }
        context.strokeStyle = frameStyle;
        context.lineWidth = 4;
        context.strokeRect(boxX, laneTop, boxWidth, laneHeight);

        const noteX = (offset: number) => boxX + Math.max(0, Math.min(1, offset / barDuration)) * boxWidth;
        const rowOf: Record<string, number> = { [attacker.id]: 0 };
        defenders.forEach((player, index) => { rowOf[player.id] = index + 1; });
        const rowHeight = laneHeight / Object.keys(rowOf).length;
        const noteY = (playerId: string) => laneTop + rowHeight * (rowOf[playerId] + 0.5);

        if (Object.keys(rowOf).length > 1) {
            context.strokeStyle = '#1f1f33';
            context.lineWidth = 1;
            for (let index = 1; index < Object.keys(rowOf).length; index++) {
                const y = laneTop + index * rowHeight;
                context.beginPath();
                context.moveTo(boxX, y);
                context.lineTo(boxX + boxWidth, y);
                context.stroke();
            }
        }

        if (!isReady && attackBar) {
            if (this.config.showAttackNotes) {
                this.state.attackNotes.forEach(note => this.drawNote(context, noteX(note.offset), noteY(attacker.id), attacker.color, 12));
            }
        } else if (!isReady) {
            const visibleAttack = this.config.showAttackNotes
                ? this.state.pendingAttack
                : this.state.pendingAttack.filter(note => note.offset / barDuration <= barProgress);
            visibleAttack.forEach(note => this.drawNote(context, noteX(note.offset), noteY(attacker.id), attacker.color, 12));
            Object.entries(this.state.defenderHits).forEach(([playerId, hits]) => {
                const player = this.players.find(item => item.id === playerId);
                if (!player) return;
                hits.forEach(hit => this.drawNote(context, noteX(hit.offset), noteY(playerId), player.color, 10));
            });
        }

        const playheadX = boxX + barProgress * boxWidth;
        context.strokeStyle = '#ffffff';
        context.lineWidth = 3;
        context.beginPath();
        context.moveTo(playheadX, laneTop - 6);
        context.lineTo(playheadX, laneTop + laneHeight + 6);
        context.stroke();

        context.font = '12px "Press Start 2P", monospace';
        context.fillStyle = isReady ? '#888899' : attackBar ? attacker.color : '#ffffff';
        context.textAlign = 'left';
        context.fillText(isReady ? 'READY...' : attackBar ? 'ATTACK' : 'DEFEND', boxX, laneTop - 14);
        this.renderAnimationEffects(context);
    }

    private drawNote(context: CanvasRenderingContext2D, x: number, y: number, color: string, size: number): void {
        context.fillStyle = color;
        context.fillRect(x - size / 2, y - size / 2, size, size);
    }

    private renderAnimationEffects(context: CanvasRenderingContext2D): void {
        const now = performance.now();
        this.state.animEffects = this.state.animEffects.filter(effect => {
            const age = now - effect.time;
            if (age > 600) return false;
            context.globalAlpha = 1 - age / 600;
            context.font = '10px "Press Start 2P", monospace';
            context.fillStyle = effect.color;
            const y = effect.y - age / 8;
            if (effect.type === 'hit') context.fillText(`+${effect.score || 0}`, effect.x, y);
            else if (effect.type === 'info') context.fillText(effect.text || '', effect.x, y);
            else context.fillText('♪', effect.x, y);
            context.globalAlpha = 1;
            return true;
        });
    }

    togglePause(): void {
        if (this.state.phase === 'playing') this.pauseGame();
        else if (this.state.phase === 'paused') this.resumeGame();
    }

    pauseGame(): void {
        if (this.state.phase !== 'playing') return;
        this.state.phase = 'paused';
        this.state.pausedTime = performance.now();
        if (this.animationFrame !== null) cancelAnimationFrame(this.animationFrame);
        this.animationFrame = null;
        void this.audio.suspend();
    }

    resumeGame(): void {
        if (this.state.phase !== 'paused') return;
        this.state.startTime += performance.now() - this.state.pausedTime;
        this.state.phase = 'playing';
        void this.audio.resume();
        this.startGameLoop();
    }

    quitGame(): void {
        if (this.animationFrame !== null) cancelAnimationFrame(this.animationFrame);
        this.animationFrame = null;
        if (this.transitionTimer !== null) window.clearTimeout(this.transitionTimer);
        this.transitionTimer = null;
        this.audio.stopAll();
        this.state.phase = 'idle';
        this.state.screen = 'config';
    }

    showConfig(): void {
        this.state.phase = 'idle';
        this.state.screen = 'config';
    }

    restartGame(): void {
        this.startGame();
    }

    private endSubRound(): void {
        if (this.animationFrame !== null) cancelAnimationFrame(this.animationFrame);
        this.animationFrame = null;
        this.state.phase = 'idle';
        this.audio.stopAll();
        if (this.state.scorePending) {
            this.state.scorePending = false;
            this.scorePair();
        }
        this.players.forEach(player => {
            this.state.totalScores[player.id] = (this.state.totalScores[player.id] || 0)
                + (this.state.scores[player.id] || 0);
        });
        // 当前轮分数已并入 totalScores，清空避免结算页重复计算 TEAM 分。
        this.state.scores = {};

        if (this.state.forcedEnd) {
            this.showResults();
            return;
        }

        if (this.isChallenge()) {
            this.state.currentRound++;
            if (this.state.currentRound < this.config.rounds) {
                this.transitionTimer = window.setTimeout(() => this.startRound(-1), 1200);
            } else {
                this.showResults();
            }
            return;
        }

        const nextAttacker = this.state.currentAttackerIdx + 1;
        if (nextAttacker < this.players.length) {
            this.transitionTimer = window.setTimeout(() => this.startRound(nextAttacker), 1200);
        } else {
            this.state.currentRound++;
            if (this.state.currentRound < this.config.rounds) {
                this.transitionTimer = window.setTimeout(() => this.startRound(0), 1200);
            } else {
                this.showResults();
            }
        }
    }

    private showResults(): void {
        this.state.screen = 'result';
        const teamScore = this.players.reduce((sum, player) => sum + (this.state.totalScores[player.id] || 0), 0);
        this.state.resultTeamScore = teamScore;
        this.state.resultBestScore = 0;
        this.state.resultNewRecord = false;
        if (this.isChallengeB()) {
            let best = 0;
            try { best = parseInt(localStorage.getItem(BEST_KEY_B) || '0', 10) || 0; } catch { /* no-op */ }
            this.state.resultNewRecord = teamScore > best;
            this.state.resultBestScore = Math.max(teamScore, best);
            if (this.state.resultNewRecord) {
                try { localStorage.setItem(BEST_KEY_B, String(teamScore)); } catch { /* no-op */ }
            }
        }
    }
}
