/**
 * Rhythm Party - Audio Engine
 * 使用 Web Audio API 实现：
 * - 节拍器（采样 audios/tick.wav，重拍高 200cent 且音量更大；加载失败回退合成音）
 * - 进攻/防守音效（按下即播放）
 * - 声场分离（B 左 30%, C 右 30%, A 居中）
 * - 角色静态衰减（防守方按 1/√防守人数）
 * - 自截断（同一玩家的新音频截断旧音频）
 * - 新循环边界清理
 */

const AudioEngine = (function() {
    let ctx = null;
    let masterGain = null;

    // 每个玩家当前播放的 source（用于自截断）
    // { playerId: { source: AudioBufferSourceNode|null, endTime: number } }
    const playerSources = {};

    // 当前进攻方的 source（用于循环边界清理）
    let attackerSources = [];

    // 音效参数
    const CONFIG = {
        metronome: {
            accentFreq: 880,      // 重拍频率 (Hz)
            normalFreq: 440,      // 普通拍频率 (Hz)
            accentGain: 0.5,      // 重拍音量
            normalGain: 0.3,      // 普通拍音量
            duration: 0.05        // 声音持续时间 (秒)
        },
        attack: {
            freq: 660,
            gain: 0.4,
            duration: 0.08,
            type: 'square'
        },
        defend: {
            freq: 880,
            gain: 0.4,
            duration: 0.08,
            type: 'triangle'
        }
    };

    /**
     * 初始化音频上下文（需要用户交互后调用）
     */
    function init() {
        if (ctx) return;
        try {
            // latencyHint: 0 请求最小输出缓冲（等价 Unity 的 Best Latency），
            // 压低按键到出声的延迟；代价是渲染预算变紧，本项目音频图简单，风险可忽略
            ctx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 0 });

            // 主增益
            masterGain = ctx.createGain();
            masterGain.gain.value = 0.8;
            masterGain.connect(ctx.destination);

            loadSounds();
            console.log('[Audio] initialized');
        } catch (e) {
            console.error('[Audio] init failed:', e);
        }
    }

    // 采样音效（audios/attack.wav / defend.wav / tick.wav），加载失败则回退到合成音
    const buffers = { attack: null, defend: null, tick: null };

    // 玩家自定义音效 { playerId: { buffer: AudioBuffer, gain: number } }
    const playerSounds = {};

    function setPlayerSound(playerId, buffer) {
        playerSounds[playerId] = playerSounds[playerId] || { buffer: null, gain: 1 };
        playerSounds[playerId].buffer = buffer;
    }

    function setPlayerGain(playerId, gain) {
        playerSounds[playerId] = playerSounds[playerId] || { buffer: null, gain: 1 };
        playerSounds[playerId].gain = gain;
    }

    function decodeAudio(arrayBuffer) {
        if (!ctx) return Promise.reject(new Error('audio not initialized'));
        return ctx.decodeAudioData(arrayBuffer);
    }

    async function loadSounds() {
        for (const role of ['attack', 'defend', 'tick']) {
            try {
                const res = await fetch('audios/' + role + '.wav');
                const arr = await res.arrayBuffer();
                buffers[role] = await ctx.decodeAudioData(arr);
                console.log('[Audio] loaded', role);
            } catch (e) {
                console.error('[Audio] failed to load', role, e);
            }
        }
    }

    /**
     * 恢复音频上下文（从 suspended 状态）
     */
    async function resume() {
        if (ctx && ctx.state === 'suspended') {
            await ctx.resume();
        }
    }

    /**
     * 获取玩家的声场位置
     * @param {number} playerIndex - 玩家索引 (0=A, 1=B, 2=C...)
     * @param {number} totalPlayers - 总玩家数
     * @returns {number} pan 值 (-1 ~ 1)
     */
    function getPlayerPan(playerIndex, totalPlayers) {
        if (totalPlayers <= 1) return 0;
        if (totalPlayers === 2) {
            return playerIndex === 0 ? -0.3 : 0.3;
        }
        if (playerIndex === 0) return 0;
        if (playerIndex === 1) return -0.3;
        if (playerIndex === 2) return 0.3;
        const side = playerIndex % 2 === 0 ? 1 : -1;
        const spread = 0.3 + (Math.floor((playerIndex - 1) / 2) * 0.2);
        return Math.min(spread, 0.9) * side;
    }

    /**
     * 创建带声场的增益节点
     */
    function createPannedGain(pan) {
        const gainNode = ctx.createGain();
        const panner = ctx.createStereoPanner();
        panner.pan.value = pan;
        gainNode.connect(panner);
        panner.connect(masterGain);
        return gainNode;
    }

    /**
     * 播放一个短促的音符
     */
    function playTone({ freq, gain, duration, type = 'square' }, pan = 0) {
        if (!ctx) return;

        const osc = ctx.createOscillator();
        const gainNode = createPannedGain(pan);

        osc.type = type;
        osc.frequency.value = freq;

        const now = ctx.currentTime;
        gainNode.gain.setValueAtTime(0, now);
        gainNode.gain.linearRampToValueAtTime(gain, now + 0.005);
        gainNode.gain.exponentialRampToValueAtTime(0.001, now + duration);

        osc.connect(gainNode);
        osc.start(now);
        osc.stop(now + duration + 0.01);

        return { osc, gainNode };
    }

    /**
     * 节拍器：播放一拍
     * @param {boolean} isAccent - 是否重拍
     * @param {number} pan - 声场位置
     */
    function playMetronomeBeat(isAccent, pan = 0) {
        if (!ctx) return;
        const cfg = CONFIG.metronome;
        const gain = isAccent ? cfg.accentGain : cfg.normalGain;

        if (buffers.tick) {
            // 采样节拍（audios/tick.wav）：重拍音量更大且高 200cent
            const gainNode = createPannedGain(pan);
            gainNode.gain.value = gain;
            const source = ctx.createBufferSource();
            source.buffer = buffers.tick;
            source.playbackRate.value = isAccent ? Math.pow(2, 200 / 1200) : 1;
            source.connect(gainNode);
            source.start(ctx.currentTime);
            return;
        }

        // 回退：合成音（采样未加载完成或加载失败时）
        const freq = isAccent ? cfg.accentFreq : cfg.normalFreq;
        const finalFreq = isAccent ? freq * Math.pow(2, 200 / 1200) : freq;

        playTone({
            freq: finalFreq,
            gain: gain,
            duration: cfg.duration,
            type: 'square'
        }, pan);
    }

    /**
     * 玩家按键音效（进攻或防守）
     * @param {string} playerId - 玩家ID
     * @param {number} playerIndex - 玩家索引
     * @param {number} totalPlayers - 总玩家数
     * @param {boolean} isAttacker - 是否为进攻方
     */
    /**
     * 玩家按键音效（进攻或防守）
     * @param {string} playerId - 玩家ID
     * @param {number} playerIndex - 玩家索引
     * @param {number} totalPlayers - 总玩家数
     * @param {boolean} isAttacker - 是否为进攻方
     * @param {number} delaySec - 延迟播放秒数（提前按下的音预约到小节点播放）
     */
    function playPlayerSound(playerId, playerIndex, totalPlayers, isAttacker, delaySec = 0) {
        if (!ctx) return false;

        // 1. 截断自己之前的音频；若取消的是未发声的预约音，返回 true 让上层同步删音符
        const cancelledScheduled = stopPlayerSound(playerId);

        const pan = getPlayerPan(playerIndex, totalPlayers);
        const cfg = isAttacker ? CONFIG.attack : CONFIG.defend;
        const custom = playerSounds[playerId];
        const buf = (custom && custom.buffer) ? custom.buffer : (isAttacker ? buffers.attack : buffers.defend);
        const baseGain = (custom && custom.buffer) ? custom.gain : cfg.gain;

        // 按角色静态衰减：进攻正常音量；防守按 1/√防守人数 衰减
        // （2 人局只有 1 个防守 = 不处理；3 人局两个防守各 1/√2）
        const defenderCount = Math.max(totalPlayers - 1, 1);
        const scale = isAttacker ? 1 : 1 / Math.sqrt(defenderCount);

        const now = ctx.currentTime;
        const startAt = now + Math.max(0, delaySec);
        const gainNode = createPannedGain(pan);
        let source, endTime;

        if (buf) {
            // 采样音效（自定义 > 默认 attack/defend）
            source = ctx.createBufferSource();
            source.buffer = buf;
            gainNode.gain.value = baseGain * scale;
            source.connect(gainNode);
            source.start(startAt);
            endTime = startAt + buf.duration;
        } else {
            // 回退：合成音（采样未加载完成或加载失败时）
            source = ctx.createOscillator();
            source.type = cfg.type;
            const freqOffset = playerIndex * 50;
            source.frequency.value = cfg.freq + freqOffset;

            gainNode.gain.setValueAtTime(0, startAt);
            gainNode.gain.linearRampToValueAtTime(cfg.gain * scale, startAt + 0.005);
            gainNode.gain.exponentialRampToValueAtTime(0.001, startAt + cfg.duration);

            source.connect(gainNode);
            source.start(startAt);
            source.stop(startAt + cfg.duration + 0.01);
            endTime = startAt + cfg.duration + 0.01;
        }

        // 记录当前 source（startTime 用于区分"预约音"和"已发声的尾巴"）
        playerSources[playerId] = { source, endTime, startTime: startAt };

        // 如果是进攻方，也记录到 attackerSources（用于循环边界清理）
        if (isAttacker) {
            attackerSources.push({ source, endTime, startTime: startAt });
        }

        // 清理完成后移除引用
        source.onended = () => {
            if (playerSources[playerId] && playerSources[playerId].source === source) {
                playerSources[playerId] = null;
            }
            attackerSources = attackerSources.filter(s => s.source !== source);
        };

        return cancelledScheduled;
    }

    /**
     * 挑战模式：系统（虚拟 P0）播放进攻音
     * 与 playPlayerSound 不同：不做自截断（系统一次预约一整小节的音，
     * 互相截断会只剩最后一个），但仍登记到 attackerSources，
     * stopAll / clearBarTails 能统一清理
     */
    function playSystemNote(delaySec = 0, pan = 0) {
        if (!ctx) return;
        const cfg = CONFIG.attack;
        const buf = buffers.attack;
        const now = ctx.currentTime;
        const startAt = now + Math.max(0, delaySec);
        const gainNode = createPannedGain(pan);
        let source, endTime;

        if (buf) {
            source = ctx.createBufferSource();
            source.buffer = buf;
            gainNode.gain.value = cfg.gain;
            source.connect(gainNode);
            source.start(startAt);
            endTime = startAt + buf.duration;
        } else {
            // 回退：合成音（采样未加载完成或加载失败时）
            source = ctx.createOscillator();
            source.type = cfg.type;
            source.frequency.value = cfg.freq;
            gainNode.gain.setValueAtTime(0, startAt);
            gainNode.gain.linearRampToValueAtTime(cfg.gain, startAt + 0.005);
            gainNode.gain.exponentialRampToValueAtTime(0.001, startAt + cfg.duration);
            source.connect(gainNode);
            source.start(startAt);
            source.stop(startAt + cfg.duration + 0.01);
            endTime = startAt + cfg.duration + 0.01;
        }

        attackerSources.push({ source, endTime, startTime: startAt });
        source.onended = () => {
            attackerSources = attackerSources.filter(s => s.source !== source);
        };
    }

    /**
     * 截断指定玩家的当前音频
     * @returns {boolean} true = 被取消的是一个还没发声的预约音
     */
    function stopPlayerSound(playerId) {
        const entry = playerSources[playerId];
        if (entry && entry.source) {
            const wasScheduled = entry.startTime !== undefined && entry.startTime > ctx.currentTime;
            try {
                const now = ctx.currentTime;
                entry.source.stop(now);
            } catch (e) {}
            playerSources[playerId] = null;
            return wasScheduled;
        }
        return false;
    }

    /**
     * 小节边界清理：截断所有玩家拖过边界的尾巴，保留预约到本小节的音
     * @param {number} boundaryPerfMs - 小节边界的 performance.now() 时刻（可选）
     *   精确区分：开始时间 >= 边界 的是预约到本小节的音（保留），
     *   开始时间 < 边界的 是上一小节拖过来的尾巴（截断）
     */
    function clearBarTails(boundaryPerfMs) {
        if (!ctx) return;
        let cutoff;
        if (boundaryPerfMs !== undefined) {
            // 把 performance.now 时间轴的小节边界换算到音频时钟，留 5ms 浮点余量
            const ctxBoundary = ctx.currentTime - (performance.now() - boundaryPerfMs) / 1000;
            cutoff = ctxBoundary - 0.005;
        } else {
            cutoff = ctx.currentTime - 0.03;
        }

        // 所有玩家的当前音（含防守方）
        Object.keys(playerSources).forEach(pid => {
            const entry = playerSources[pid];
            if (entry && entry.source && entry.startTime !== undefined && entry.startTime < cutoff) {
                try { entry.source.stop(ctx.currentTime); } catch (e) {}
                playerSources[pid] = null;
            }
        });

        // 进攻方尾巴列表
        attackerSources = attackerSources.filter(({ source, startTime }) => {
            if (startTime !== undefined && startTime >= cutoff) return true;
            try { source.stop(ctx.currentTime); } catch (e) {}
            return false;
        });
    }

    /**
     * 清理所有玩家的音频
     */
    function stopAll() {
        Object.keys(playerSources).forEach(stopPlayerSound);
        clearBarTails();
    }

    /**
     * 设置主音量
     */
    function setMasterVolume(vol) {
        if (masterGain) {
            masterGain.gain.value = Math.max(0, Math.min(1, vol));
        }
    }

    // 导出
    return {
        init,
        resume,
        playMetronomeBeat,
        playPlayerSound,
        playSystemNote,
        stopPlayerSound,
        clearBarTails,
        stopAll,
        setMasterVolume,
        getPlayerPan,
        setPlayerSound,
        setPlayerGain,
        decodeAudio,
        get context() { return ctx; }
    };
})();
