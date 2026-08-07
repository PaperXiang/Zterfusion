import type { Player } from '../types';

type Role = 'attack' | 'defend' | 'tick';
type AudioSource = AudioBufferSourceNode | OscillatorNode;

interface SourceEntry {
    source: AudioSource;
    endTime: number;
    startTime: number;
}

interface PlayerSound {
    buffer: AudioBuffer | null;
    gain: number;
}

const AUDIO_BASE = `${import.meta.env.BASE_URL}audios/`;

/**
 * Web Audio 封装。
 *
 * 这里仍然把音频时序留在原生 AudioContext，而不是交给 Vue 响应式系统：
 * Vue 负责画面状态，AudioContext 负责低延迟播放，两条时间轴互不拖慢。
 */
export class AudioEngine {
    private ctx: AudioContext | null = null;
    private masterGain: GainNode | null = null;
    private readonly buffers: Record<Role, AudioBuffer | null> = {
        attack: null,
        defend: null,
        tick: null
    };
    private readonly playerSounds: Record<string, PlayerSound> = {};
    private readonly playerSources: Record<string, SourceEntry | null> = {};
    private attackerSources: SourceEntry[] = [];

    private readonly soundConfig = {
        metronome: {
            accentFreq: 880,
            normalFreq: 440,
            accentGain: 0.5,
            normalGain: 0.3,
            duration: 0.05
        },
        attack: { freq: 660, gain: 0.4, duration: 0.08, type: 'square' as OscillatorType },
        defend: { freq: 880, gain: 0.4, duration: 0.08, type: 'triangle' as OscillatorType }
    };

    init(): void {
        if (this.ctx) return;
        try {
            const browserWindow = window as Window & {
                webkitAudioContext?: typeof AudioContext;
            };
            const AudioContextConstructor = window.AudioContext || browserWindow.webkitAudioContext;
            if (!AudioContextConstructor) throw new Error('Web Audio API is unavailable');
            this.ctx = new AudioContextConstructor({ latencyHint: 0 });
            this.masterGain = this.ctx.createGain();
            this.masterGain.gain.value = 0.8;
            this.masterGain.connect(this.ctx.destination);
            void this.loadSounds();
        } catch (error) {
            console.error('[Audio] init failed:', error);
        }
    }

    private async loadSounds(): Promise<void> {
        if (!this.ctx) return;
        for (const role of ['attack', 'defend', 'tick'] as Role[]) {
            try {
                const response = await fetch(`${AUDIO_BASE}${role}.wav`);
                if (!response.ok) throw new Error(`HTTP ${response.status}`);
                const arrayBuffer = await response.arrayBuffer();
                this.buffers[role] = await this.ctx.decodeAudioData(arrayBuffer);
            } catch (error) {
                // 采样失败时会自动回退到合成音，不阻塞游戏。
                console.error('[Audio] failed to load', role, error);
            }
        }
    }

    async resume(): Promise<void> {
        if (this.ctx?.state === 'suspended') await this.ctx.resume();
    }

    async suspend(): Promise<void> {
        // 暂停游戏时冻结 AudioContext.currentTime，预约音会和游戏时间轴一起停住，
        // 而不是在暂停遮罩出现后继续把节拍和系统音放完。
        if (this.ctx?.state === 'running') await this.ctx.suspend();
    }

    async loadPlayerLibrarySound(player: Player): Promise<void> {
        if (player.soundSource !== 'library' || !player.soundName || player._libLoaded) return;
        const expectedName = player.soundName;
        try {
            this.init();
            await this.resume();
            const response = await fetch(`${AUDIO_BASE}${encodeURIComponent(expectedName)}`);
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const arrayBuffer = await response.arrayBuffer();
            const buffer = await this.decodeAudio(arrayBuffer);
            // 用户可能在解码期间又切换了音效；旧请求不能覆盖新选择。
            if (player.soundSource !== 'library' || player.soundName !== expectedName) return;
            this.setPlayerSound(player.id, buffer);
            this.setPlayerGain(player.id, 1);
            player._libLoaded = true;
        } catch (error) {
            console.error('[Audio] library sound failed:', expectedName, error);
        }
    }

    decodeAudio(arrayBuffer: ArrayBuffer): Promise<AudioBuffer> {
        if (!this.ctx) return Promise.reject(new Error('audio not initialized'));
        return this.ctx.decodeAudioData(arrayBuffer);
    }

    setPlayerSound(playerId: string, buffer: AudioBuffer | null): void {
        this.playerSounds[playerId] = this.playerSounds[playerId] || { buffer: null, gain: 1 };
        this.playerSounds[playerId].buffer = buffer;
    }

    setPlayerGain(playerId: string, gain: number): void {
        this.playerSounds[playerId] = this.playerSounds[playerId] || { buffer: null, gain: 1 };
        this.playerSounds[playerId].gain = gain;
    }

    getPlayerPan(playerIndex: number, totalPlayers: number): number {
        if (totalPlayers <= 1) return 0;
        if (totalPlayers === 2) return playerIndex === 0 ? -0.3 : 0.3;
        if (playerIndex === 0) return 0;
        if (playerIndex === 1) return -0.3;
        if (playerIndex === 2) return 0.3;
        const side = playerIndex % 2 === 0 ? 1 : -1;
        const spread = 0.3 + Math.floor((playerIndex - 1) / 2) * 0.2;
        return Math.min(spread, 0.9) * side;
    }

    private createPannedGain(pan: number): GainNode {
        if (!this.ctx || !this.masterGain) throw new Error('audio not initialized');
        const gainNode = this.ctx.createGain();
        const panner = this.ctx.createStereoPanner();
        panner.pan.value = pan;
        gainNode.connect(panner);
        panner.connect(this.masterGain);
        return gainNode;
    }

    private playTone(
        tone: { freq: number; gain: number; duration: number; type: OscillatorType },
        pan = 0
    ): void {
        if (!this.ctx) return;
        const oscillator = this.ctx.createOscillator();
        const gainNode = this.createPannedGain(pan);
        oscillator.type = tone.type;
        oscillator.frequency.value = tone.freq;
        const now = this.ctx.currentTime;
        gainNode.gain.setValueAtTime(0, now);
        gainNode.gain.linearRampToValueAtTime(tone.gain, now + 0.005);
        gainNode.gain.exponentialRampToValueAtTime(0.001, now + tone.duration);
        oscillator.connect(gainNode);
        oscillator.start(now);
        oscillator.stop(now + tone.duration + 0.01);
    }

    playMetronomeBeat(isAccent: boolean, pan = 0): void {
        if (!this.ctx) return;
        const cfg = this.soundConfig.metronome;
        const gain = isAccent ? cfg.accentGain : cfg.normalGain;
        if (this.buffers.tick) {
            const gainNode = this.createPannedGain(pan);
            gainNode.gain.value = gain;
            const source = this.ctx.createBufferSource();
            source.buffer = this.buffers.tick;
            source.playbackRate.value = isAccent ? Math.pow(2, 200 / 1200) : 1;
            source.connect(gainNode);
            source.start(this.ctx.currentTime);
            return;
        }
        const freq = isAccent ? cfg.accentFreq : cfg.normalFreq;
        this.playTone({
            freq: isAccent ? freq * Math.pow(2, 200 / 1200) : freq,
            gain,
            duration: cfg.duration,
            type: 'square'
        }, pan);
    }

    /** 播放玩家按键音；返回 true 表示一个尚未发声的预约音被取消。 */
    playPlayerSound(
        playerId: string,
        playerIndex: number,
        totalPlayers: number,
        isAttacker: boolean,
        delaySec = 0,
        activeDefenderCount?: number
    ): boolean {
        if (!this.ctx) return false;
        const cancelledScheduled = this.stopPlayerSound(playerId);
        const pan = this.getPlayerPan(playerIndex, totalPlayers);
        const cfg = isAttacker ? this.soundConfig.attack : this.soundConfig.defend;
        const custom = this.playerSounds[playerId];
        const buffer = custom?.buffer || (isAttacker ? this.buffers.attack : this.buffers.defend);
        const baseGain = custom?.buffer ? custom.gain : cfg.gain;
        // 挑战 A 的系统进攻方不在 players 中，因此防守人数不能永远用 totalPlayers - 1 推导。
        const defenderCount = Math.max(activeDefenderCount ?? totalPlayers - 1, 1);
        const scale = isAttacker ? 1 : 1 / Math.sqrt(defenderCount);
        const now = this.ctx.currentTime;
        const startAt = now + Math.max(0, delaySec);
        const gainNode = this.createPannedGain(pan);
        let source: AudioSource;
        let endTime: number;

        if (buffer) {
            const bufferSource = this.ctx.createBufferSource();
            bufferSource.buffer = buffer;
            gainNode.gain.value = baseGain * scale;
            bufferSource.connect(gainNode);
            bufferSource.start(startAt);
            source = bufferSource;
            endTime = startAt + buffer.duration;
        } else {
            const oscillator = this.ctx.createOscillator();
            oscillator.type = cfg.type;
            oscillator.frequency.value = cfg.freq + playerIndex * 50;
            gainNode.gain.setValueAtTime(0, startAt);
            gainNode.gain.linearRampToValueAtTime(cfg.gain * scale, startAt + 0.005);
            gainNode.gain.exponentialRampToValueAtTime(0.001, startAt + cfg.duration);
            oscillator.connect(gainNode);
            oscillator.start(startAt);
            oscillator.stop(startAt + cfg.duration + 0.01);
            source = oscillator;
            endTime = startAt + cfg.duration + 0.01;
        }

        const entry = { source, endTime, startTime: startAt };
        this.playerSources[playerId] = entry;
        if (isAttacker) this.attackerSources.push(entry);
        source.onended = () => {
            if (this.playerSources[playerId]?.source === source) this.playerSources[playerId] = null;
            this.attackerSources = this.attackerSources.filter(item => item.source !== source);
        };
        return cancelledScheduled;
    }

    /** 系统进攻音不做玩家级自截断，允许整小节同时预约多个音。 */
    playSystemNote(delaySec = 0, pan = 0): void {
        if (!this.ctx) return;
        const cfg = this.soundConfig.attack;
        const now = this.ctx.currentTime;
        const startAt = now + Math.max(0, delaySec);
        const gainNode = this.createPannedGain(pan);
        let source: AudioSource;
        let endTime: number;
        if (this.buffers.attack) {
            const bufferSource = this.ctx.createBufferSource();
            bufferSource.buffer = this.buffers.attack;
            gainNode.gain.value = cfg.gain;
            bufferSource.connect(gainNode);
            bufferSource.start(startAt);
            source = bufferSource;
            endTime = startAt + this.buffers.attack.duration;
        } else {
            const oscillator = this.ctx.createOscillator();
            oscillator.type = cfg.type;
            oscillator.frequency.value = cfg.freq;
            gainNode.gain.setValueAtTime(0, startAt);
            gainNode.gain.linearRampToValueAtTime(cfg.gain, startAt + 0.005);
            gainNode.gain.exponentialRampToValueAtTime(0.001, startAt + cfg.duration);
            oscillator.connect(gainNode);
            oscillator.start(startAt);
            oscillator.stop(startAt + cfg.duration + 0.01);
            source = oscillator;
            endTime = startAt + cfg.duration + 0.01;
        }
        const entry = { source, endTime, startTime: startAt };
        this.attackerSources.push(entry);
        source.onended = () => {
            this.attackerSources = this.attackerSources.filter(item => item.source !== source);
        };
    }

    stopPlayerSound(playerId: string): boolean {
        if (!this.ctx) return false;
        const entry = this.playerSources[playerId];
        if (!entry) return false;
        const wasScheduled = entry.startTime > this.ctx.currentTime;
        try { entry.source.stop(this.ctx.currentTime); } catch { /* 已结束的 source 无需处理 */ }
        this.playerSources[playerId] = null;
        return wasScheduled;
    }

    clearBarTails(boundaryPerfMs?: number): void {
        if (!this.ctx) return;
        let cutoff: number;
        if (boundaryPerfMs !== undefined) {
            const ctxBoundary = this.ctx.currentTime - (performance.now() - boundaryPerfMs) / 1000;
            cutoff = ctxBoundary - 0.005;
        } else {
            cutoff = this.ctx.currentTime - 0.03;
        }
        Object.keys(this.playerSources).forEach(playerId => {
            const entry = this.playerSources[playerId];
            if (entry && entry.startTime < cutoff) {
                try { entry.source.stop(this.ctx!.currentTime); } catch { /* no-op */ }
                this.playerSources[playerId] = null;
            }
        });
        this.attackerSources = this.attackerSources.filter(entry => {
            if (entry.startTime >= cutoff) return true;
            try { entry.source.stop(this.ctx!.currentTime); } catch { /* no-op */ }
            return false;
        });
    }

    stopAll(): void {
        Object.keys(this.playerSources).forEach(playerId => { this.stopPlayerSound(playerId); });
        // clearBarTails 会保留边界之后的预约音；整局退出时则必须连未来预约一起清掉。
        this.attackerSources.forEach(entry => {
            try { entry.source.stop(this.ctx?.currentTime); } catch { /* no-op */ }
        });
        this.attackerSources = [];
    }

    setMasterVolume(volume: number): void {
        if (this.masterGain) this.masterGain.gain.value = Math.max(0, Math.min(1, volume));
    }

    get context(): AudioContext | null {
        return this.ctx;
    }
}
