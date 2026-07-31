/**
 * Rhythm Party - 游戏数值配置
 * 时间单位：秒；得分单位：分
 */
const GAME_CONFIG = {

    // 手感容错：小节前后各延长的判定窗口（早按归下一节，晚按归上一节）
    tolerance: 0.08,

    // 防守复刻评分（防守音 vs 进攻音的匹配误差）
    defend: {
        perfectWindow: 0.02,  // <= 20ms 满分
        matchWindow: 0.08,    // >= 80ms 零分（也是匹配上限）
        pointsPerNote: 100    // 每个匹配音的满分
    },

    // 进攻准确度评分（进攻音对齐到网格，比防守严格）
    attack: {
        grid: 32,             // 网格密度：32 分音（可改 24）
        perfectWindow: 0.02,  // <= 20ms 满分
        maxWindow: 0.05,      // <= 50ms 才有分，超出零分
        pointsPerNote: 100    // 每个音的满分
    },

    // 每小节得分软封顶（膝盖以下不压缩，以上指数衰减）
    // 单节得分上限 ≈ softCapKnee + softCapLimit，防止 32 分音刷分
    softCapKnee: 600,
    softCapLimit: 400,

    // 挑战模式 A：系统（虚拟 P0）随机生成节奏的密度
    challengeA: {
        density: 0.3,   // 每个网格切分点放音的概率（网格 = 勾选的分音并集）
        minNotes: 2     // 每小节保底音数（太少没有复刻价值）
    },

    // 挑战模式 B：合作冲分（一人进攻其余防守，全队冲 TEAM 总分）
    challengeB: {
        minNotes: 3,      // 进攻小节最少音数，不足则该小节作废 + MISS
        maxStrikes: 3,    // MISS 上限（音数不足 / 节奏与上一段完全相同），打满立即结束
        scorePerStep: 500,// 团队总分每多少分升一档速度
        bpmStep: 5,       // 每档 +5 BPM
        maxBpm: 200       // 速度上限
    },

    // 准备阶段小节数
    readyBars: 2,

    // 小节边界自然截断：攻防切换时是否截断拖过边界的尾巴（attack→defend / defend→attack）
    truncateAtBarBoundary: false,

    // 快速开始：'double' = 双击 Enter/Space，'single' = 单击
    quickStart: 'double'
};
