import type { GameConfig, GameNumbers } from './types.js';

export const GAME_NUMBERS: GameNumbers = {
    tolerance: 0.08,
    defend: {
        perfectWindow: 0.02,
        matchWindow: 0.08,
        pointsPerNote: 100
    },
    attack: {
        grid: 32,
        perfectWindow: 0.02,
        maxWindow: 0.05,
        pointsPerNote: 100
    },
    softCapKnee: 600,
    softCapLimit: 400,
    challengeA: {
        density: 0.3,
        minNotes: 2
    },
    challengeB: {
        minNotes: 3,
        maxStrikes: 3,
        scorePerStep: 500,
        bpmStep: 5,
        maxBpm: 200
    },
    readyBars: 2,
    truncateAtBarBoundary: false,
    quickStart: 'double'
};

export function createDefaultConfig(): GameConfig {
    return {
        mode: 'casual',
        bpm: 120,
        beatsPerRound: 4,
        rounds: 2,
        timePerRound: 30,
        grids: [16],
        showAttackNotes: true
    };
}
