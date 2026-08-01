/**
 * Rhythm Party - Game Core
 *
 * 回合结构（以 4 拍为例）：
 *   小节0: 进攻方按键（记录）
 *   小节1: 防守方复刻（记录）
 *   小节1 结束后统一比对：每个进攻音找最近的防守音，误差 <=20ms 满分，>=80ms 零分
 *   小节2: 进攻方再次按键 ... 依次循环，直到本进攻方时间耗尽，换下一位进攻方
 */

const Game = (function() {
    const PLAYER_COLORS = ['#00ff88', '#00aaff', '#ff00aa', '#ffcc00', '#ff6644', '#aa66ff'];
    // 挑战模式：系统作为虚拟 P0（进攻方），不进 players 列表、不计分
    const SYS_PLAYER = { id: 'sys', name: 'CPU', color: '#eeeeee', keys: [] };

    // 数值配置（来自 config.js，缺失时用内置默认值兜底）
    const CFG = (typeof GAME_CONFIG !== 'undefined') ? GAME_CONFIG : {
        tolerance: 0.08,
        defend: { perfectWindow: 0.02, matchWindow: 0.08, pointsPerNote: 100 },
        attack: { grid: 32, perfectWindow: 0.02, maxWindow: 0.05, pointsPerNote: 100 },
        challengeA: { density: 0.3, minNotes: 2 },
        challengeB: { minNotes: 3, maxStrikes: 3, scorePerStep: 500, bpmStep: 5, maxBpm: 200 },
        softCapKnee: 600, softCapLimit: 400,
        readyBars: 2,
        truncateAtBarBoundary: false,
        quickStart: 'double'
    };

    const TOLERANCE = CFG.tolerance; // 手感容错：小节前后各延长的判定窗口
    const CANVAS_MARGIN = 30;        // 节拍框左右边距（与 .beat-markers 的 padding 对齐）

    let players = [];
    let librarySounds = []; // audios/ 官方音效库文件列表
    let config = {
        mode: 'casual',     // casual | challenge-a（B/C 预留）
        bpm: 120, beatsPerRound: 4, rounds: 2, timePerRound: 30,
        grids: [16],            // 进攻音符对齐网格（8/12/16/24 分音，可多选）
        showAttackNotes: true   // 进攻小节是否立即显示音符；false 则在防守小节随播放头出现
    };

    let gameState = {
        phase: 'idle',          // idle | countdown | playing | paused
        currentRound: 0,
        currentAttackerIdx: 0,
        startTime: 0,
        pausedTime: 0,
        barIndex: -1,           // 当前小节序号（0起，偶数=进攻，奇数=防守）
        systemScheduledFor: null, // 挑战模式：已预约随机节奏的小节序号（防止重复生成）
        strikes: 0,             // 挑战模式 B：违规（MISS）次数，整局累计
        prevRhythm: {},         // 挑战模式 B：各玩家自己上一段进攻节奏 {pid: [offset]}（判重用）
        bpm: 0,                 // 挑战模式 B：当前速度（回合边界按团队总分升档）
        forcedEnd: false,       // 挑战模式 B：MISS 打满强制结束
        beatCount: -1,
        attackNotes: [],        // 当前进攻小节的音符 [{offset}]（小节内秒偏移）
        pendingAttack: [],      // 等待比对的进攻音符（上一个进攻小节）
        defenderHits: {},       // 当前防守小节各防守方的按键 {pid: [{offset}]}
        scorePending: false,    // 是否有待延迟比对的防守小节
        scoreAt: 0,             // 延迟比对触发时间（elapsed 秒）
        ending: false,          // 时间已到，等当前进攻+防守一组走完后结束
        endingAtBar: null,      // 触发 ending 时所在的小节：该小节的进攻音允许打完
        scores: {},             // 本进攻方回合得分
        totalScores: {},
        animEffects: []
    };

    let animFrame = null;
    const canvas = document.getElementById('rhythm-canvas');
    const ctx = canvas.getContext('2d');

    // READY 期间改拍数：数字键缓冲（0.2s 内连按算两位数）
    const readyDigit = { value: null, time: 0 };
    const DIGIT_WINDOW = 200; // ms

    function barDuration() {
        return config.beatsPerRound * 60 / effectiveBpm();
    }

    // 挑战模式 A：系统（SYS_PLAYER）当进攻方，所有玩家都是防守方
    function isChallenge() {
        return config.mode === 'challenge-a';
    }

    // 挑战模式 B：合作冲分（轮换进攻不变，加进攻约束 + MISS + 随分加速）
    function isChallengeB() {
        return config.mode === 'challenge-b';
    }

    // 当前进攻方对象：挑战模式返回虚拟 P0，休闲模式返回玩家
    function currentAttacker() {
        return isChallenge() ? SYS_PLAYER : players[gameState.currentAttackerIdx];
    }

    // 挑战模式 B 随团队总分加速（gameState.bpm 在回合边界升档）；其它模式恒为设定 BPM
    function effectiveBpm() {
        return isChallengeB() ? (gameState.bpm || config.bpm) : config.bpm;
    }

    // 团队总分 = 已结算 + 本轮进行中（挑战模式 B 的冲分目标）
    function teamTotal() {
        return players.reduce((s, p) => s + (gameState.totalScores[p.id] || 0) + (gameState.scores[p.id] || 0), 0);
    }

    function init() {
        if (!loadSettings()) loadDefaultPlayers();
        bindUI();
        resizeCanvas();
        window.addEventListener('resize', resizeCanvas);
        InputSystem.init();
        loadLibraryList();
    }

    // 读取 audios/ 目录列表作为官方音效库（http 服务器自动生成目录索引）
    async function loadLibraryList() {
        try {
            const res = await fetch('audios/');
            const html = await res.text();
            librarySounds = [...html.matchAll(/href="([^"?]+\.(?:wav|mp3|ogg|m4a|flac))"/gi)]
                .map(m => decodeURIComponent(m[1]))
                .filter(n => n.indexOf('/') < 0)
                .filter(n => n !== 'attack.wav' && n !== 'defend.wav'); // 默认音效不进音效库
            renderPlayersList();
        } catch (e) {
            console.error('[Library]', e);
        }
    }

    // 加载玩家的音效库音效（库音效已均衡，固定增益 1，无需调 dB）
    async function ensurePlayerSound(player) {
        if (player.soundSource !== 'library' || !player.soundName || player._libLoaded) return;
        try {
            const res = await fetch('audios/' + encodeURIComponent(player.soundName));
            const arr = await res.arrayBuffer();
            const buf = await AudioEngine.decodeAudio(arr);
            AudioEngine.setPlayerSound(player.id, buf);
            AudioEngine.setPlayerGain(player.id, 1);
            player._libLoaded = true;
        } catch (e) {
            console.error('[Library]', player.soundName, e);
        }
    }

    // ========== 设置记忆（localStorage） ==========
    const STORAGE_KEY = 'rhythm-party-settings';

    function saveSettings() {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify({
                config,
                players: players.map(p => ({
                    id: p.id, name: p.name, keys: p.keys,
                    soundSource: p.soundSource || 'default',
                    soundName: p.soundName || null, volumeDb: p.volumeDb || 0
                }))
            }));
        } catch (e) { console.error('[Save]', e); }
    }

    function loadSettings() {
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            if (!raw) return false;
            const data = JSON.parse(raw);
            if (data.config) Object.assign(config, data.config);
            if (Array.isArray(data.players) && data.players.length >= 2) {
                players = data.players.map((p, i) => ({
                    id: p.id, name: p.name, keys: p.keys || [],
                    soundSource: p.soundSource || (p.soundName ? 'custom' : 'default'),
                    soundName: p.soundName || null, volumeDb: p.volumeDb || 0,
                    color: PLAYER_COLORS[i % PLAYER_COLORS.length], score: 0
                }));
            }
            // 注意：自定义上传的音效文件本身不保存，需重新上传；音效库音效会自动重新加载
            renderPlayersList();
            return true;
        } catch (e) {
            return false;
        }
    }

    function loadDefaultPlayers() {
        players = [
            { id: 'p1', name: 'Zizhi', keys: [{key:'a',code:'KeyA'}], color: PLAYER_COLORS[0], score: 0 },
            { id: 'p2', name: 'P2', keys: [{key:'l',code:'KeyL'}], color: PLAYER_COLORS[1], score: 0 }
        ];
        renderPlayersList();
    }

    function bindUI() {
        // 把记忆的配置同步到输入框
        document.getElementById('bpm-input').value = config.bpm;
        document.getElementById('beats-per-round-input').value = config.beatsPerRound;
        document.getElementById('rounds-input').value = config.rounds;
        document.getElementById('time-per-round-input').value = config.timePerRound;

        document.getElementById('add-player-btn').addEventListener('click', addPlayer);
        document.getElementById('start-game-btn').addEventListener('click', startGame);

        // 模式选择（B/C 为预留占位，disabled）
        const modeBtns = [...document.querySelectorAll('.mode-btn')];
        const syncModeBtns = () => modeBtns.forEach(b => b.classList.toggle('selected', b.dataset.mode === config.mode));
        syncModeBtns();
        modeBtns.forEach(b => b.addEventListener('click', () => {
            if (b.disabled) return;
            config.mode = b.dataset.mode;
            syncModeBtns();
            saveSettings();
        }));
        document.getElementById('reset-settings-btn').addEventListener('click', resetSettings);
        document.getElementById('pause-btn').addEventListener('click', pauseGame);
        document.getElementById('quit-btn').addEventListener('click', quitGame);
        document.getElementById('resume-btn').addEventListener('click', resumeGame);
        document.getElementById('restart-btn').addEventListener('click', restartGame);
        document.getElementById('back-to-config-btn').addEventListener('click', showConfig);

        document.getElementById('bpm-input').addEventListener('change', e => { config.bpm = parseInt(e.target.value) || 120; saveSettings(); });
        document.getElementById('beats-per-round-input').addEventListener('change', e => { config.beatsPerRound = parseInt(e.target.value) || 4; saveSettings(); });
        document.getElementById('rounds-input').addEventListener('change', e => { config.rounds = parseInt(e.target.value) || 2; saveSettings(); });
        document.getElementById('time-per-round-input').addEventListener('change', e => { config.timePerRound = parseInt(e.target.value) || 30; saveSettings(); });

        // 对齐网格复选框：至少保留一种，全取消时把刚取消的那个勾回来
        if (!Array.isArray(config.grids) || config.grids.length === 0) config.grids = [16];
        const gridChecks = [...document.querySelectorAll('.grid-check')];
        const syncGridChecks = () => gridChecks.forEach(c => { c.checked = config.grids.includes(parseInt(c.value)); });
        syncGridChecks();
        gridChecks.forEach(cb => {
            cb.addEventListener('change', () => {
                config.grids = gridChecks.filter(c => c.checked).map(c => parseInt(c.value));
                if (config.grids.length === 0) {
                    cb.checked = true;
                    config.grids = [parseInt(cb.value)];
                }
                saveSettings();
            });
        });

        // 进攻音符即时显示开关
        const showAttackNotesCb = document.getElementById('show-attack-notes');
        if (showAttackNotesCb) {
            showAttackNotesCb.checked = config.showAttackNotes !== false;
            showAttackNotesCb.addEventListener('change', () => {
                config.showAttackNotes = showAttackNotesCb.checked;
                saveSettings();
            });
        }

        // 预设：只覆盖开关与网格，不动 BPM/rounds/time 等其它设置
        [...document.querySelectorAll('.preset-btn')].forEach(btn => {
            btn.addEventListener('click', () => {
                if (btn.dataset.preset === 'visual') {
                    config.showAttackNotes = true;
                    config.grids = [16];
                } else if (btn.dataset.preset === 'audio') {
                    config.showAttackNotes = false;
                    config.grids = [8];
                }
                if (showAttackNotesCb) showAttackNotesCb.checked = config.showAttackNotes;
                syncGridChecks();
                saveSettings();
            });
        });

        document.addEventListener('keydown', e => {
            if (e.code === 'Escape') {
                if (gameState.phase === 'playing') pauseGame();
                else if (gameState.phase === 'paused') resumeGame();
            }
        });
    }

    function resetSettings() {
        if (!confirm('Clear ALL settings and players?')) return;
        try { localStorage.removeItem(STORAGE_KEY); } catch (e) {}
        location.reload();
    }

    function addPlayer() {
        if (players.length >= 6) { alert('Max 6 players!'); return; }
        const idx = players.length;
        const defaultKeys = [
            [{key:'a',code:'KeyA'}],[{key:'l',code:'KeyL'}],[{key:'f',code:'KeyF'}],
            [{key:'j',code:'KeyJ'}],[{key:'d',code:'KeyD'}],[{key:'k',code:'KeyK'}]
        ];
        players.push({
            id: 'p' + (idx + 1), name: 'P' + (idx + 1),
            keys: defaultKeys[idx] || [{key:'Space',code:'Space'}],
            color: PLAYER_COLORS[idx % PLAYER_COLORS.length], score: 0
        });
        renderPlayersList();
        saveSettings();
    }

    function removePlayer(pid) {
        players = players.filter(p => p.id !== pid);
        players.forEach((p, i) => p.color = PLAYER_COLORS[i % PLAYER_COLORS.length]);
        AudioEngine.setPlayerSound(pid, null); // 清理自定义音效，避免 id 复用时串音
        renderPlayersList();
        saveSettings();
    }

    function updatePlayerName(pid, name) {
        const p = players.find(p => p.id === pid);
        if (p) { p.name = name; saveSettings(); }
    }

    function renderPlayersList() {
        const container = document.getElementById('players-list');
        container.innerHTML = players.map((p) => `
            <div class="player-card" data-id="${p.id}">
                <div class="player-info">
                    <div class="player-color" style="background:${p.color}"></div>
                    <input class="player-name-input" value="${p.name}" data-id="${p.id}" maxlength="8">
                </div>
                <div class="player-keys">${InputSystem.formatKeys(p.keys)}</div>
                <div class="player-sound">
                    <button class="sound-btn" data-id="${p.id}" title="Upload custom sound">UPLOAD</button>
                    <select class="sound-select" data-id="${p.id}">
                        <option value="">default</option>
                        ${librarySounds.map(n => `<option value="${n}" ${p.soundSource === 'library' && p.soundName === n ? 'selected' : ''}>${n}</option>`).join('')}
                    </select>
                    <span class="sound-name">${p.soundSource === 'custom' ? (p.soundName || '') : ''}</span>
                    <input type="range" class="vol-slider" data-id="${p.id}"
                           min="-24" max="6" step="1" value="${p.volumeDb || 0}"
                           ${p.soundSource === 'custom' ? '' : 'disabled'}>
                    <span class="vol-label">${(p.volumeDb || 0)}dB</span>
                </div>
                <button class="delete-btn" data-id="${p.id}">X</button>
            </div>
        `).join('');

        container.querySelectorAll('.player-card').forEach(card => {
            card.addEventListener('click', e => {
                if (e.target.classList.contains('delete-btn') || e.target.classList.contains('player-name-input')) return;
                if (e.target.closest('.player-sound')) return;
                const pid = card.dataset.id;
                const player = players.find(p => p.id === pid);
                if (player) {
                    InputSystem.openBindModal(player, newKeys => {
                        const conflict = players.some(p => p.id !== pid && InputSystem.hasConflict(p.keys, newKeys));
                        if (conflict) {
                            alert('Key conflict! Please rebind.');
                            return false;
                        }
                        player.keys = newKeys;
                        renderPlayersList();
                        saveSettings();
                    });
                }
            });
        });

        container.querySelectorAll('.sound-btn').forEach(btn => {
            btn.addEventListener('click', e => {
                e.stopPropagation();
                pickSoundFile(btn.dataset.id);
            });
        });

        container.querySelectorAll('.sound-select').forEach(sel => {
            sel.addEventListener('click', e => e.stopPropagation());
            sel.addEventListener('change', async e => {
                const pid = e.target.dataset.id;
                const player = players.find(p => p.id === pid);
                if (!player) return;
                const name = e.target.value;
                if (!name) {
                    // 恢复默认音效
                    player.soundSource = 'default';
                    player.soundName = null;
                    player._libLoaded = false;
                    AudioEngine.setPlayerSound(pid, null);
                } else {
                    // 音效库：已均衡，固定增益
                    player.soundSource = 'library';
                    player.soundName = name;
                    player._libLoaded = false;
                    AudioEngine.init();
                    await AudioEngine.resume().catch(() => {});
                    await ensurePlayerSound(player);
                }
                renderPlayersList();
                saveSettings();
            });
        });

        container.querySelectorAll('.vol-slider').forEach(slider => {
            slider.addEventListener('click', e => e.stopPropagation());
            slider.addEventListener('input', e => {
                const pid = e.target.dataset.id;
                const player = players.find(p => p.id === pid);
                if (!player) return;
                player.volumeDb = parseInt(e.target.value) || 0;
                e.target.nextElementSibling.textContent = `${player.volumeDb}dB`;
                AudioEngine.setPlayerGain(pid, Math.pow(10, player.volumeDb / 20));
                saveSettings();
            });
        });

        container.querySelectorAll('.delete-btn').forEach(btn => {
            btn.addEventListener('click', e => {
                e.stopPropagation();
                if (players.length <= 2) { alert('Need at least 2 players!'); return; }
                removePlayer(btn.dataset.id);
            });
        });

        container.querySelectorAll('.player-name-input').forEach(input => {
            input.addEventListener('change', e => updatePlayerName(e.target.dataset.id, e.target.value));
            input.addEventListener('click', e => e.stopPropagation());
        });
    }

    function resizeCanvas() {
        canvas.width = canvas.clientWidth || canvas.parentElement.clientWidth;
        canvas.height = 200;
    }

    // 打开文件资源管理器，为玩家选择自定义音效
    function pickSoundFile(pid) {
        const player = players.find(p => p.id === pid);
        if (!player) return;
        const fi = document.createElement('input');
        fi.type = 'file';
        fi.accept = 'audio/*';
        fi.onchange = async () => {
            const file = fi.files[0];
            if (!file) return;
            try {
                AudioEngine.init();
                await AudioEngine.resume().catch(() => {});
                const arr = await file.arrayBuffer();
                const audioBuf = await AudioEngine.decodeAudio(arr);
                AudioEngine.setPlayerSound(pid, audioBuf);
                AudioEngine.setPlayerGain(pid, Math.pow(10, (player.volumeDb || 0) / 20));
                player.soundSource = 'custom'; // 只有自定义上传的音效才需要均衡响度
                player._libLoaded = false;
                player.soundName = file.name.length > 16 ? file.name.slice(0, 14) + '…' : file.name;
                renderPlayersList();
                saveSettings();
            } catch (err) {
                console.error('[Sound]', err);
                alert('Failed to load audio file!');
            }
        };
        fi.click();
    }

    function showScreen(id) {
        document.querySelectorAll('.screen').forEach(s => {
            s.classList.remove('active');
            s.classList.add('hidden');
        });
        const target = document.getElementById(id);
        target.classList.remove('hidden');
        target.classList.add('active');
    }

    function showConfig() {
        showScreen('config-screen');
        gameState.phase = 'idle';
    }

    function startGame() {
        // 休闲模式至少 2 人（一攻一防）；挑战模式系统是进攻方，1 人也能玩
        if (players.length < (isChallenge() ? 1 : 2)) { alert('Need at least 2 players!'); return; }
        try {
            AudioEngine.init();
            AudioEngine.resume().catch(() => {});
            players.forEach(p => ensurePlayerSound(p)); // 加载音效库选择（异步，READY 期间完成）
        } catch (e) { console.error('[Audio]', e); }
        players.forEach(p => gameState.totalScores[p.id] = 0);
        gameState.currentRound = 0;
        // 挑战模式 B：合作冲分状态整局累计（startRound 不重置）
        gameState.strikes = 0;
        gameState.prevRhythm = {};
        gameState.bpm = config.bpm;
        gameState.forcedEnd = false;
        // 挑战模式：进攻方固定为系统（-1），不轮换
        startRound(isChallenge() ? -1 : 0);
    }

    function startRound(attackerIdx) {
        gameState.currentAttackerIdx = attackerIdx;
        gameState.startTime = performance.now();
        gameState.pausedTime = 0;
        gameState.barIndex = -1;
        gameState.beatCount = -1;
        gameState.systemScheduledFor = null;
        gameState.attackNotes = [];
        gameState.pendingAttack = [];
        gameState.defenderHits = {};
        gameState.scorePending = false;
        gameState.scoreAt = 0;
        gameState.ending = false;
        gameState.endingAtBar = null;
        gameState.scores = {};
        players.forEach(p => {
            gameState.defenderHits[p.id] = [];
            gameState.scores[p.id] = 0;
        });
        gameState.animEffects = [];
        InputSystem.clearPressedKeys();

        // 挑战模式 B：按团队总分升档加速（只升不降）。
        // 只在回合边界换速：小节时长由 BPM 决定，中途变速会让 elapsed 对应的小节序号跳变
        if (isChallengeB()) {
            const cb = CFG.challengeB;
            const nb = Math.min(cb.maxBpm, config.bpm + Math.floor(teamTotal() / cb.scorePerStep) * cb.bpmStep);
            if (gameState.bpm && nb > gameState.bpm) {
                gameState.animEffects.push({
                    type: 'info', text: 'SPEED UP ' + nb + 'BPM', color: '#ffcc00',
                    time: performance.now(), x: canvas.width / 2 - 60, y: canvas.height / 2
                });
            }
            gameState.bpm = nb;
        }

        renderGamePlayers();
        renderBeatMarkers();
        updateScores(); // 刷新累计分数显示（renderGamePlayers 会把分数重置成 0）
        showScreen('game-screen');
        resizeCanvas();
        document.getElementById('pause-overlay').classList.add('hidden');
        updateHeader();

        // 准备阶段 = 2 个小节（2 × 设定拍数），播放条正常走动，显示 READY
        // startTime 设在将来，elapsed 从负值走到 0 即正式开始
        gameState.phase = 'playing';
        gameState.startTime = performance.now() + readyDuration() * 1000;
        gameState.beatCount = -CFG.readyBars * config.beatsPerRound - 1;
        startGameLoop();
    }

    function readyDuration() {
        return CFG.readyBars * barDuration();
    }

    function startGameLoop() {
        if (animFrame) cancelAnimationFrame(animFrame);
        gameLoop();
    }

    function gameLoop() {
        if (gameState.phase !== 'playing') return;
        const now = performance.now();
        const elapsed = (now - gameState.startTime) / 1000; // 准备阶段为负值
        const timeLeft = Math.max(0, config.timePerRound - Math.max(0, elapsed));

        document.getElementById('timer-display').textContent = gameState.ending ? 'LAST' : `${Math.ceil(timeLeft)}s`;

        // 小节切换检测
        const barIdx = Math.floor(elapsed / barDuration());
        if (barIdx !== gameState.barIndex) onBarBoundary(barIdx);

        // 挑战模式：系统当进攻方，在进攻小节开始前 0.1s 生成随机节奏并预约音效
        // （和真人"提前音预约"同一时间轴，保证音画一致；预约窗口只留 0.1s，
        //   避免暂停时一整小节的预约音漏进暂停里。ending 后不再生成新节奏）
        if (isChallenge() && !gameState.ending && (barIdx < 0 || !isAttackBar(barIdx))) {
            const nextBar = barIdx + 1;
            if (nextBar >= 0 && isAttackBar(nextBar) && gameState.systemScheduledFor !== nextBar
                && elapsed >= nextBar * barDuration() - 0.1) {
                scheduleSystemBar(nextBar, elapsed);
            }
        }

        // 防守小节结束后的延迟比对（等晚按的防守音进来）
        if (gameState.scorePending && elapsed >= gameState.scoreAt) {
            gameState.scorePending = false;
            scorePair();
            // 时间到时保证以防空小节收尾：当前这组比对完才结束
            if (gameState.ending) { endSubRound(); return; }
        }

        // 时间到不立即结束：置 ending，等当前进攻+防守一组走完。
        // 记录当前小节号：进行中的进攻小节允许打完，之后的小节不再接收进攻音
        if (timeLeft <= 0 && !gameState.ending) {
            gameState.ending = true;
            gameState.endingAtBar = barIdx;
        }

        // READY 期间的改拍数缓冲：单个数字超过 0.2s 未续按则生效
        if (gameState.barIndex < 0 && readyDigit.value !== null && (now - readyDigit.time) > DIGIT_WINDOW) {
            applyReadyBeats(readyDigit.value);
            readyDigit.value = null;
        }

        // 节拍器（准备阶段也照常打拍）
        const totalBeats = elapsed * effectiveBpm() / 60;
        const currentBeatNum = Math.floor(totalBeats);
        if (currentBeatNum > gameState.beatCount) {
            gameState.beatCount = currentBeatNum;
            const beatInCycle = ((currentBeatNum % config.beatsPerRound) + config.beatsPerRound) % config.beatsPerRound;
            const isAccent = beatInCycle === 0;
            const pan = isChallenge() ? 0 : AudioEngine.getPlayerPan(gameState.currentAttackerIdx, players.length);
            AudioEngine.playMetronomeBeat(isAccent, pan);
        }

        updateHeader();
        renderCanvas(now, elapsed);

        animFrame = requestAnimationFrame(gameLoop);
    }

    function isAttackBar(barIdx) {
        return barIdx % 2 === 0;
    }

    // READY 期间按数字键：0.2s 内连按两位 = 两位数拍数（如 1→3 = 13 拍）
    function onReadyDigit(d) {
        if (gameState.phase !== 'playing' || gameState.barIndex >= 0) return;
        const now = performance.now();
        if (readyDigit.value !== null && now - readyDigit.time <= DIGIT_WINDOW) {
            const combined = readyDigit.value * 10 + d;
            readyDigit.value = null;
            applyReadyBeats(combined);
        } else {
            readyDigit.value = d;
            readyDigit.time = now;
        }
    }

    function applyReadyBeats(n) {
        n = Math.max(2, Math.min(16, n));
        config.beatsPerRound = n;
        document.getElementById('beats-per-round-input').value = n;
        saveSettings();
        renderBeatMarkers();
        // 按新拍数重新锚定 READY（重走 2 小节）
        gameState.startTime = performance.now() + readyDuration() * 1000;
        gameState.beatCount = -CFG.readyBars * n - 1;
        gameState.barIndex = -CFG.readyBars;
        gameState.animEffects.push({
            type: 'info', text: n + ' BEATS', color: '#ffffff',
            time: performance.now(), x: canvas.width / 2 - 40, y: canvas.height / 2
        });
    }

    function onBarBoundary(newBar) {
        const prevBar = gameState.barIndex;

        // 准备阶段的小节（负数）：只推进序号，不比对不记录
        if (newBar < 0) {
            gameState.barIndex = newBar;
            return;
        }

        // 刚结束的小节是防守小节 -> 延迟 TOLERANCE 再比对，
        // 容纳防守方"想按结尾却晚按几十毫秒"的情况
        if (prevBar >= 0 && !isAttackBar(prevBar)) {
            gameState.scoreAt = newBar * barDuration() + TOLERANCE;
            gameState.scorePending = true;
        }

        if (isAttackBar(newBar)) {
            // 进入进攻小节：attackNotes 里只会有本小节的音
            // （提前音 offset<0，或刚开始几毫秒内的音）——不能过滤，
            // 否则 rAF 检测延迟会把压线的音抹掉（有声无点）
            // 挑战模式兜底：正常在 gameLoop 提前 0.1s 生成；
            // 卡顿错过预约窗口时在进小节这一刻补生成
            if (isChallenge() && gameState.systemScheduledFor !== newBar) {
                scheduleSystemBar(newBar, newBar * barDuration());
            }
        } else {
            // 挑战模式 B：校验进攻小节——音数不足 / 与"自己上一段"完全相同 → 记 MISS。
            // 违规小节不作废（防守方照常复刻得分），惩罚只有 MISS，避免断节奏；
            // 判重按玩家各自记录：换人进攻不会被别人的习惯节奏误伤。
            // ending 后允许打完的小节（<= endingAtBar）照常校验；
            // 更后面的死小节按键被禁、不会有音符，且游戏在那之前就结束了
            if (isChallengeB() && (!gameState.ending || gameState.endingAtBar === null || newBar - 1 <= gameState.endingAtBar)) {
                const cb = CFG.challengeB;
                const pid = players[gameState.currentAttackerIdx].id;
                // 节奏型按"拍"归一化再比较：加速后同一手法秒数偏移会变，但拍位置不变
                const beatDur = 60 / effectiveBpm();
                const offs = gameState.attackNotes
                    .map(n => Math.round(n.offset / beatDur * 1000) / 1000).sort((a, b) => a - b);
                const tooFew = offs.length < cb.minNotes;
                const prev = gameState.prevRhythm[pid];
                const repeated = !tooFew && prev && offs.length === prev.length
                    && offs.every((o, i) => Math.abs(o - prev[i]) < 1e-6);
                if (tooFew || repeated) {
                    gameState.strikes++;
                    const reason = tooFew ? 'TOO FEW NOTES!' : 'SAME RHYTHM!';
                    gameState.animEffects.push({
                        type: 'info', text: reason + ' MISS ' + gameState.strikes + '/' + cb.maxStrikes,
                        color: '#ff4444', time: performance.now(), x: canvas.width / 2 - 110, y: canvas.height / 2
                    });
                    if (gameState.strikes >= cb.maxStrikes) {
                        // MISS 打满：当前防守小节走完后直接结算（ending 阻止新的进攻音）
                        gameState.forcedEnd = true;
                        gameState.ending = true;
                        gameState.endingAtBar = newBar;
                    }
                }
                // 每个非空进攻小节都更新该玩家自己的节奏记录（含违规小节）
                if (!tooFew) gameState.prevRhythm[pid] = offs;
            }
            // 进入防守小节：先结算进攻方自身准确度分（软封顶），再移交音符待比对
            // 挑战模式 A 进攻方是系统，没有准确度分
            if (!isChallenge()) {
                const rawAcc = gameState.attackNotes.reduce((s, n) => s + (n.acc || 0), 0);
                const accGain = softCap(rawAcc);
                if (accGain > 0) {
                    const attacker = players[gameState.currentAttackerIdx];
                    gameState.scores[attacker.id] += accGain;
                    addAnimEffect('hit', attacker.id, accGain);
                    updateScores();
                }
            }
            gameState.pendingAttack = gameState.attackNotes;
            gameState.attackNotes = [];
            // defenderHits 同理：此时只会有本防守小节的音，不过滤
        }
        gameState.barIndex = newBar;

        // 小节边界自然截断（config 可配置，默认不截断）
        if (CFG.truncateAtBarBoundary) {
            AudioEngine.clearBarTails(gameState.startTime + newBar * barDuration() * 1000);
        }
    }

    /**
     * 小节结束后统一比对：
     * 对每个进攻音，找该防守方最近的未匹配防守音，
     * 误差 <=20ms 满分(100)，>=80ms 零分，线性过渡；匹配后删除该防守音
     */
    function scorePair() {
        const attacks = gameState.pendingAttack;
        gameState.pendingAttack = [];

        if (attacks && attacks.length > 0) {
            // 挑战模式进攻方是系统，不参与计分（只有防守方得分）
            const attacker = isChallenge() ? null : players[gameState.currentAttackerIdx];

            players.forEach((p, i) => {
                if (i === gameState.currentAttackerIdx) return;
                const hits = gameState.defenderHits[p.id] || [];

                // 全局最优匹配：所有 (进攻,防守) 候选对按误差升序依次配对，
                // 避免按顺序贪心时完美对被相邻音抢走
                const pairs = [];
                attacks.forEach((a, ai) => {
                    hits.forEach((h, hi) => {
                        const err = Math.abs(h.offset - a.offset);
                        if (err < CFG.defend.matchWindow) pairs.push({ ai, hi, err });
                    });
                });
                pairs.sort((x, y) => x.err - y.err);
                const usedA = new Set(), usedH = new Set();
                let gained = 0;
                pairs.forEach(pr => {
                    if (usedA.has(pr.ai) || usedH.has(pr.hi)) return;
                    usedA.add(pr.ai);
                    usedH.add(pr.hi);
                    gained += calcScore(pr.err);
                });

                // 匹配得分软封顶，防止 32 分音刷分
                gained = softCap(gained);
                if (gained > 0) {
                    // 防守方和进攻方同时加分（你画我猜式互相成就）
                    gameState.scores[p.id] += gained;
                    if (attacker) gameState.scores[attacker.id] += gained;
                    addAnimEffect('hit', p.id, gained);
                }
                // 按错不扣分，最多就是不加分
            });
            updateScores();
        }

        // 比对完清空防守记录
        players.forEach(p => gameState.defenderHits[p.id] = []);
    }

    function calcScore(err) {
        const d = CFG.defend;
        if (err <= d.perfectWindow) return d.pointsPerNote;
        if (err >= d.matchWindow) return 0;
        return Math.round(d.pointsPerNote * (1 - (err - d.perfectWindow) / (d.matchWindow - d.perfectWindow)));
    }

    // 进攻准确度：对齐到最近的 32/24 分音网格，<=20ms 满分，>50ms 零分
    function attackAccuracy(offset) {
        const a = CFG.attack;
        const gridStep = (60 / effectiveBpm()) * 4 / a.grid;
        const err = Math.abs(offset - Math.round(offset / gridStep) * gridStep);
        if (err <= a.perfectWindow) return a.pointsPerNote;
        if (err >= a.maxWindow) return 0;
        return Math.round(a.pointsPerNote * (1 - (err - a.perfectWindow) / (a.maxWindow - a.perfectWindow)));
    }

    // 进攻音符自动对齐：吸附到 config.grids 勾选的所有网格中最近的切分点
    // （如同时勾 16/24 分，则取 4 等分和 6 等分网格里离按键最近的那个点）
    function quantizeOffset(offset) {
        const grids = (Array.isArray(config.grids) && config.grids.length) ? config.grids : [16];
        const beatDur = 60 / effectiveBpm();
        let best = offset, bestErr = Infinity;
        grids.forEach(g => {
            const step = beatDur * 4 / g; // g 分音 = 每拍 g/4 等分
            const snapped = Math.round(offset / step) * step;
            const err = Math.abs(snapped - offset);
            if (err < bestErr) { bestErr = err; best = snapped; }
        });
        return best;
    }

    // 软封顶：膝盖以下不压缩，以上指数衰减，上限 ≈ knee + limit
    function softCap(x) {
        const knee = CFG.softCapKnee, lim = CFG.softCapLimit;
        if (x <= knee) return Math.round(x);
        return Math.round(knee + lim * (1 - Math.exp(-(x - knee) / lim)));
    }

    // 挑战模式 A：生成一小节的随机节奏，音落在勾选网格的并集切分点上
    function generateChallengeNotes() {
        const ca = CFG.challengeA;
        const barDur = barDuration();
        const beatDur = 60 / effectiveBpm();
        const grids = (Array.isArray(config.grids) && config.grids.length) ? config.grids : [16];
        // 并集切分点（毫秒级去重，去掉 8 分和 16 分重叠的点）
        const points = new Set();
        grids.forEach(g => {
            const step = beatDur * 4 / g; // g 分音 = 每拍 g/4 等分
            const n = Math.round(barDur / step);
            for (let i = 0; i < n; i++) points.add(Math.round(i * step * 1000) / 1000);
        });
        const sorted = [...points].sort((a, b) => a - b);
        let notes = sorted.filter(() => Math.random() < ca.density).map(off => ({ offset: off }));
        // 保底 minNotes 个音：随机补齐（避免空小节没法复刻）
        while (notes.length < Math.min(ca.minNotes, sorted.length)) {
            const off = sorted[Math.floor(Math.random() * sorted.length)];
            if (!notes.some(n => Math.abs(n.offset - off) < 1e-6)) {
                notes.push({ offset: off });
                notes.sort((a, b) => a.offset - b.offset);
            }
        }
        return notes;
    }

    // 挑战模式：为指定进攻小节生成节奏，并把每个音预约到对应时刻播放
    // （delaySec 相对当前 elapsed，复用真人进攻方的预约音机制保证音画一致）
    function scheduleSystemBar(barIdx, elapsed) {
        gameState.systemScheduledFor = barIdx;
        const barStart = barIdx * barDuration();
        gameState.attackNotes = generateChallengeNotes();
        gameState.attackNotes.forEach(n => {
            AudioEngine.playSystemNote(Math.max(0, barStart + n.offset - elapsed));
        });
    }

    function onPlayerKeydown(playerId, time) {
        if (gameState.phase !== 'playing') return;
        const pIdx = players.findIndex(p => p.id === playerId);
        if (pIdx < 0) return;

        const isAttacker = pIdx === gameState.currentAttackerIdx;
        const elapsed = (time - gameState.startTime) / 1000;
        if (elapsed < -TOLERANCE) return; // 准备阶段超过提前量的按键无效

        // 手感容错：判定窗口前后各延长 TOLERANCE。
        // 在小节末尾提前按 -> 归到下一小节开头（offset 为负，视觉钳到最左）
        // 在小节开头才按   -> 归到上一小节结尾（offset 超过小节长，视觉钳到最右）
        // 存储用真实 offset，计分也算上这个偏移
        const barDur = barDuration();
        let barIdx = Math.floor(elapsed / barDur);
        let offset = elapsed - barIdx * barDur;
        let isLate = false;   // 晚按归到上一小节：只记录，不出声（避免和小节边界截断冲突）
        let earlyDelay = 0;   // 早按归到下一小节：音效预约到小节点播放，避免被边界截断
        const matches = (b) => isAttackBar(b) === isAttacker;

        if (!matches(barIdx) && barIdx > 0 && offset < TOLERANCE && matches(barIdx - 1)) {
            barIdx -= 1;
            offset = elapsed - barIdx * barDur;
            isLate = true;
        } else if (!matches(barIdx) && offset > barDur - TOLERANCE && matches(barIdx + 1)) {
            barIdx += 1;
            offset = elapsed - barIdx * barDur;
            earlyDelay = -offset; // offset 为负，延迟到小节点
        }

        // 时间已到（ending）：触发时所在的进攻小节允许打完（之前是时间一到就静默，
        // 最后一轮的进攻方会"按着按着不能按"）；只有更后面的进攻小节才忽略，
        // 避免最后一组比对结束后还有音没分。按容错路由后的落点小节判断
        if (gameState.ending && isAttacker && gameState.endingAtBar !== null && barIdx > gameState.endingAtBar) return;

        const attackBar = isAttackBar(barIdx);
        if (attackBar && isAttacker) {
            // 音符吸附到最近的勾选网格点：方块画在吸附后的位置，音效也预约到该时刻
            // （吸附点在过去则立即播放；路由用原始 offset，避免压线音换条）
            const snapped = quantizeOffset(offset);
            // 按 offset 路由目标数组（不能用 gameState.barIndex，rAF 检测有一帧延迟）：
            // offset 在 [0, barDur] = 本小节的音；< 0 = 提前音；> barDur = 晚按归上一小节
            const target = offset > barDur ? gameState.pendingAttack : gameState.attackNotes;
            // 快速连打吸附到同一个点：只留第一个，后按的直接忽略（不出声不出点）
            if (target.some(n => Math.abs(n.offset - snapped) < 1e-6)) return;
            const delaySec = Math.max(0, snapped - offset);
            const cancelledEarly = !isLate && AudioEngine.playPlayerSound(playerId, pIdx, players.length, true, delaySec);
            // 上一次预约的音被取消了：同步删掉它的音符，保持音画一致
            if (cancelledEarly) removeLatestEarlyNote(gameState.attackNotes);
            // 进攻方自身准确度：仍按原始按下时刻对齐 32 分网格计分（保留手感区分度）
            const note = { offset: snapped, acc: attackAccuracy(offset), early: offset < 0 };
            target.push(note);
            addAnimEffect('attack', playerId);
        } else if (!attackBar && !isAttacker) {
            const cancelledEarly = !isLate && AudioEngine.playPlayerSound(playerId, pIdx, players.length, false, earlyDelay);
            if (cancelledEarly) removeLatestEarlyNote(gameState.defenderHits[playerId]);
            gameState.defenderHits[playerId].push({ offset });
            addAnimEffect('defend', playerId);
        }
        // 其余情况（按在自己不该按的小节中部）直接忽略
    }

    // 删除该玩家最近的提前音（按在小节边界前，early 标记；吸附后 offset 可能已归 0）
    // 用于预约音被取消时保持音画一致
    function removeLatestEarlyNote(arr) {
        for (let i = arr.length - 1; i >= 0; i--) {
            if (arr[i].early || arr[i].offset < 0) { arr.splice(i, 1); return; }
        }
    }

    // ========== 渲染 ==========

    function currentDefenders() {
        return players.filter((_, i) => i !== gameState.currentAttackerIdx);
    }

    function renderCanvas(now, elapsed) {
        const w = canvas.width, h = canvas.height;
        ctx.clearRect(0, 0, w, h);
        ctx.fillStyle = '#1a1a2e';
        ctx.fillRect(0, 0, w, h);

        const barDur = barDuration();
        const barIdx = Math.floor(elapsed / barDur);
        const barProgress = Math.min((elapsed - barIdx * barDur) / barDur, 1);
        const isReady = barIdx < 0;
        const attackBar = isAttackBar(barIdx);
        const attacker = currentAttacker(); // 挑战模式为虚拟 P0（CPU）
        const defenders = currentDefenders();

        const boxX = CANVAS_MARGIN;
        const boxW = w - CANVAS_MARGIN * 2;
        const laneHeight = h * 0.55;
        const laneTop = (h - laneHeight) / 2 + 10;
        const cellW = boxW / config.beatsPerRound;

        // 框体背景
        ctx.fillStyle = '#0d0d1a';
        ctx.fillRect(boxX, laneTop, boxW, laneHeight);

        // 当前拍高亮
        const beatInBar = Math.min(Math.floor(barProgress * config.beatsPerRound), config.beatsPerRound - 1);
        ctx.globalAlpha = 0.10;
        ctx.fillStyle = isReady ? '#888899' : attackBar ? attacker.color : (defenders[0] ? defenders[0].color : '#ffffff');
        ctx.fillRect(boxX + beatInBar * cellW, laneTop, cellW, laneHeight);
        ctx.globalAlpha = 1.0;

        // 拍子分隔线（方框分割 = 拍子数）
        ctx.strokeStyle = '#2d2d44';
        ctx.lineWidth = 2;
        for (let i = 0; i <= config.beatsPerRound; i++) {
            const x = boxX + i * cellW;
            ctx.beginPath(); ctx.moveTo(x, laneTop); ctx.lineTo(x, laneTop + laneHeight); ctx.stroke();
        }

        // 外框颜色：准备=灰色，进攻=进攻方颜色，防守=防守方颜色（多人用渐变）
        let frameStyle;
        if (isReady) {
            frameStyle = '#555577';
        } else if (attackBar || defenders.length === 1) {
            frameStyle = attackBar ? attacker.color : defenders[0].color;
        } else {
            const grad = ctx.createLinearGradient(boxX, 0, boxX + boxW, 0);
            defenders.forEach((d, i) => grad.addColorStop(defenders.length === 1 ? 0 : i / (defenders.length - 1), d.color));
            frameStyle = grad;
        }
        ctx.strokeStyle = frameStyle;
        ctx.lineWidth = 4;
        ctx.strokeRect(boxX, laneTop, boxW, laneHeight);

        // 音符 x 坐标：存储用真实 offset（可为负或超过小节长），视觉钳到框内
        const noteX = (offset) => boxX + Math.max(0, Math.min(1, offset / barDur)) * boxW;

        // 每个玩家一行：进攻方在最上，防守方按顺序依次往下
        // 挑战模式进攻方是系统（不在 players 里），行数 = 玩家数 + 1
        const rowOf = {};
        {
            let r = 0;
            rowOf[attacker.id] = r++;
            players.forEach((p, i) => { if (i !== gameState.currentAttackerIdx) rowOf[p.id] = r++; });
        }
        const rowCount = Object.keys(rowOf).length;
        const rowH = laneHeight / rowCount;
        const noteY = (pid) => laneTop + rowH * (rowOf[pid] + 0.5);

        // 行分隔线
        if (rowCount > 1) {
            ctx.strokeStyle = '#1f1f33';
            ctx.lineWidth = 1;
            for (let r = 1; r < rowCount; r++) {
                const y = laneTop + r * rowH;
                ctx.beginPath(); ctx.moveTo(boxX, y); ctx.lineTo(boxX + boxW, y); ctx.stroke();
            }
        }

        // 音符（准备阶段不画）
        if (!isReady && attackBar) {
            // 不立即显示时，进攻小节隐藏攻击音符，迫使玩家靠听觉记忆
            if (config.showAttackNotes !== false) {
                gameState.attackNotes.forEach(n => {
                    drawNote(noteX(n.offset), noteY(attacker.id), attacker.color, 12);
                });
            }
        } else if (!isReady) {
            // 防守小节：进攻方的点作为复刻目标；关闭即时显示时随播放头逐个出现
            const visibleAttack = config.showAttackNotes !== false
                ? gameState.pendingAttack
                : gameState.pendingAttack.filter(n => (n.offset / barDur) <= barProgress);
            visibleAttack.forEach(n => {
                drawNote(noteX(n.offset), noteY(attacker.id), attacker.color, 12);
            });
            Object.entries(gameState.defenderHits).forEach(([pid, hits]) => {
                const p = players.find(pl => pl.id === pid);
                if (!p || pid === attacker.id) return;
                hits.forEach(hit => {
                    drawNote(noteX(hit.offset), noteY(pid), p.color, 10);
                });
            });
        }

        // 播放头：每小节从左扫到右
        const playheadX = boxX + barProgress * boxW;
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 3;
        ctx.beginPath(); ctx.moveTo(playheadX, laneTop - 6); ctx.lineTo(playheadX, laneTop + laneHeight + 6); ctx.stroke();

        // 阶段标签
        ctx.font = '12px "Press Start 2P", monospace';
        ctx.fillStyle = isReady ? '#888899' : attackBar ? attacker.color : '#ffffff';
        ctx.textAlign = 'left';
        ctx.fillText(isReady ? 'READY...' : attackBar ? 'ATTACK' : 'DEFEND', boxX, laneTop - 14);

        renderAnimEffects();
    }

    function drawNote(x, y, color, size) {
        ctx.fillStyle = color;
        ctx.fillRect(x - size / 2, y - size / 2, size, size);
    }

    function addAnimEffect(type, playerId, score) {
        const p = players.find(p => p.id === playerId);
        gameState.animEffects.push({
            type, playerId, score,
            color: p ? p.color : '#fff',
            time: performance.now(),
            x: 60 + Math.random() * (canvas.width - 120),
            y: canvas.height / 2
        });
    }

    function renderAnimEffects() {
        const now = performance.now();
        gameState.animEffects = gameState.animEffects.filter(fx => {
            const age = now - fx.time;
            if (age > 600) return false;
            const alpha = 1 - age / 600;
            ctx.globalAlpha = alpha;
            ctx.font = '10px "Press Start 2P", monospace';
            ctx.fillStyle = fx.color;
            const y = fx.y - age / 8;
            if (fx.type === 'hit') ctx.fillText(`+${fx.score}`, fx.x, y);
            else if (fx.type === 'info') ctx.fillText(fx.text, fx.x, y);
            else ctx.fillText('♪', fx.x, y);
            ctx.globalAlpha = 1;
            return true;
        });
    }

    function renderBeatMarkers() {
        const container = document.querySelector('.beat-markers');
        container.innerHTML = '';
        for (let i = 1; i <= config.beatsPerRound; i++) {
            const s = document.createElement('span');
            s.className = 'beat-marker';
            s.textContent = i;
            container.appendChild(s);
        }
    }

    function renderGamePlayers() {
        const container = document.getElementById('game-players-area');
        const aIdx = gameState.currentAttackerIdx;
        container.innerHTML = players.map((p, i) => {
            const isA = i === aIdx;
            return `
                <div class="game-player ${isA ? 'attacker' : 'defender'}" id="gp-${p.id}">
                    <div class="role-badge">${isA ? 'ATTACK' : 'DEFEND'}</div>
                    <div class="player-avatar" style="background:${p.color}"></div>
                    <div class="player-name" style="color:${p.color}">${p.name}</div>
                    <div class="player-keys">${InputSystem.formatKeys(p.keys)}</div>
                    <div class="player-score" id="score-${p.id}">0</div>
                </div>
            `;
        }).join('');
    }

    function updateScores() {
        // 显示总分（已结算的 + 本轮进行中的）
        players.forEach(p => {
            const el = document.getElementById(`score-${p.id}`);
            if (el) el.textContent = (gameState.totalScores[p.id] || 0) + (gameState.scores[p.id] || 0);
        });
    }

    function updateHeader() {
        document.getElementById('round-display').textContent = `Round: ${gameState.currentRound + 1} / ${config.rounds}`;
        const a = currentAttacker();
        const phaseLabel = gameState.barIndex < 0 ? 'READY' : isAttackBar(gameState.barIndex) ? 'ATTACK' : 'DEFEND';
        document.getElementById('phase-display').textContent = `${a ? a.name : '?'} · ${phaseLabel}`;
        // 挑战模式 B：TEAM 总分 / 当前速度 / MISS 计数
        const mi = document.getElementById('mode-info-display');
        mi.textContent = isChallengeB()
            ? `TEAM ${teamTotal()} · ${effectiveBpm()}BPM · MISS ${gameState.strikes}/${CFG.challengeB.maxStrikes}`
            : '';
    }

    function endSubRound() {
        cancelAnimationFrame(animFrame);
        gameState.phase = 'idle';
        AudioEngine.stopAll(); // 清掉尾巴和未触发的预约音，避免漏到下一回合

        // 兜底：若还有未触发的延迟比对，先冲刷掉
        if (gameState.scorePending) {
            gameState.scorePending = false;
            scorePair();
        }

        players.forEach(p => { gameState.totalScores[p.id] += gameState.scores[p.id] || 0; });

        // 挑战模式 B：MISS 打满立即结束（不等 rounds 走完）
        if (gameState.forcedEnd) {
            showResults();
            return;
        }

        // 挑战模式：进攻方固定是系统，不走轮换，直接按局数推进
        if (isChallenge()) {
            gameState.currentRound++;
            if (gameState.currentRound < config.rounds) {
                setTimeout(() => startRound(-1), 1200);
            } else {
                showResults();
            }
            return;
        }

        const nextA = gameState.currentAttackerIdx + 1;
        if (nextA < players.length) {
            setTimeout(() => startRound(nextA), 1200);
        } else {
            gameState.currentRound++;
            if (gameState.currentRound < config.rounds) {
                setTimeout(() => startRound(0), 1200);
            } else {
                showResults();
            }
        }
    }

    function pauseGame() {
        if (gameState.phase !== 'playing') return;
        gameState.phase = 'paused';
        gameState.pausedTime = performance.now();
        cancelAnimationFrame(animFrame);
        document.getElementById('pause-overlay').classList.remove('hidden');
    }

    function resumeGame() {
        if (gameState.phase !== 'paused') return;
        const pausedDur = performance.now() - gameState.pausedTime;
        gameState.startTime += pausedDur;
        document.getElementById('pause-overlay').classList.add('hidden');
        gameState.phase = 'playing';
        startGameLoop();
    }

    function quitGame() {
        cancelAnimationFrame(animFrame);
        AudioEngine.stopAll();
        gameState.phase = 'idle';
        showConfig();
    }

    function restartGame() {
        gameState.currentRound = 0;
        players.forEach(p => gameState.totalScores[p.id] = 0);
        startGame();
    }

    // 挑战模式 B 最高团队分（与设置分开存，RESET 不清纪录）
    const BEST_KEY_B = 'rhythm-party-best-b';

    function showResults() {
        showScreen('result-screen');
        const container = document.getElementById('results-list');
        const sorted = [...players].sort((a, b) =>
            (gameState.totalScores[b.id] || 0) - (gameState.totalScores[a.id] || 0)
        );
        const medals = ['🥇', '🥈', '🥉'];
        // 挑战模式 B：顶部展示 TEAM 总分与历史最佳
        let head = '';
        if (isChallengeB()) {
            const team = teamTotal();
            let best = 0;
            try { best = parseInt(localStorage.getItem(BEST_KEY_B)) || 0; } catch (e) {}
            const isRecord = team > best;
            if (isRecord) {
                best = team;
                try { localStorage.setItem(BEST_KEY_B, String(team)); } catch (e) {}
            }
            head = `
                <div class="team-result">
                    <div class="team-score">TEAM ${team}</div>
                    <div class="team-best">${isRecord ? 'NEW RECORD!' : 'BEST ' + best}</div>
                </div>
            `;
        }
        container.innerHTML = head + sorted.map((p, i) => `
            <div class="result-item">
                <span class="rank">${i < 3 ? medals[i] : '#' + (i + 1)}</span>
                <span class="name" style="color:${p.color}">${p.name}</span>
                <span class="score">${gameState.totalScores[p.id] || 0}</span>
            </div>
        `).join('');
    }

    return {
        init, startGame, onPlayerKeydown, ensurePlayerSound, onReadyDigit,
        players: () => players,
        config: () => config,
        cfg: () => CFG,
        state: () => gameState
    };
})();

// 全局按键分发（防按住重复触发）
const _keyPressedThisFrame = new Set();

function dispatchGameInput(code, e) {
    if (Game.state().phase !== 'playing') return;
    if (_keyPressedThisFrame.has(code)) return;
    _keyPressedThisFrame.add(code);
    let used = false;
    Game.players().forEach(p => {
        if (p.keys.some(k => k.code === code)) {
            Game.onPlayerKeydown(p.id, performance.now());
            used = true;
        }
    });
    if (used && e) e.preventDefault();
}

document.addEventListener('keydown', e => dispatchGameInput(e.code, e));
document.addEventListener('keyup', e => _keyPressedThisFrame.delete(e.code));
document.addEventListener('mousedown', e => dispatchGameInput('Mouse' + e.button, e));
document.addEventListener('mouseup', e => _keyPressedThisFrame.delete('Mouse' + e.button));

// 配置界面按键试听：按玩家绑定的键，按其设定响度播放对应音效，方便均衡音量
function previewPlayerSound(code) {
    if (Game.state().phase !== 'idle') return;
    if (!document.getElementById('config-screen').classList.contains('active')) return;
    if (!document.getElementById('keybind-modal').classList.contains('hidden')) return;
    Game.players().forEach((p, i) => {
        if (p.keys.some(k => k.code === code)) {
            try {
                AudioEngine.init();
                AudioEngine.resume().catch(() => {});
                ensureLib(p);
                AudioEngine.playPlayerSound(p.id, i, Game.players().length, true);
            } catch (err) { console.error('[Preview]', err); }
        }
    });
    function ensureLib(p) { if (Game.ensurePlayerSound) Game.ensurePlayerSound(p); }
}

document.addEventListener('keydown', e => {
    const t = e.target.tagName;
    if (t === 'INPUT' || t === 'SELECT' || t === 'TEXTAREA') return;
    previewPlayerSound(e.code);
});

// READY 期间数字键改拍数（小键盘和主键盘数字都支持）
document.addEventListener('keydown', e => {
    const m = e.code.match(/^(?:Numpad|Digit)(\d)$/);
    if (m) Game.onReadyDigit(parseInt(m[1]));
});

// 配置界面 Enter / Space 快速开始（设置里可选单击/双击，默认双击；绑键弹窗打开时不触发）
const _quickStart = { code: null, time: 0 };
document.addEventListener('keydown', e => {
    if (e.code !== 'Enter' && e.code !== 'Space') return;
    const t = e.target.tagName;
    if (t === 'INPUT' || t === 'SELECT' || t === 'TEXTAREA') return;
    if (Game.state().phase !== 'idle') return;
    if (!document.getElementById('config-screen').classList.contains('active')) return;
    if (!document.getElementById('keybind-modal').classList.contains('hidden')) return;
    e.preventDefault();
    if (Game.cfg().quickStart === 'single') {
        Game.startGame();
        return;
    }
    const now = performance.now();
    if (_quickStart.code === e.code && now - _quickStart.time < 400) {
        _quickStart.code = null;
        Game.startGame();
    } else {
        _quickStart.code = e.code;
        _quickStart.time = now;
    }
});
document.addEventListener('mousedown', e => previewPlayerSound('Mouse' + e.button));

if (document.readyState === 'complete' || document.readyState === 'interactive') {
    Game.init();
} else {
    document.addEventListener('DOMContentLoaded', () => Game.init());
}
