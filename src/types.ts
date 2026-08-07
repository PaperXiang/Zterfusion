export type Mode = 'casual' | 'challenge-a' | 'challenge-b' | 'challenge-c';
export type GamePhase = 'idle' | 'playing' | 'paused';
export type ScreenName = 'config' | 'game' | 'result';

export interface KeyBinding {
    key: string;
    code: string;
}

export interface Player {
    id: string;
    name: string;
    keys: KeyBinding[];
    color: string;
    score?: number;
    soundSource?: 'default' | 'library' | 'custom';
    soundName?: string | null;
    volumeDb?: number;
    _libLoaded?: boolean;
}

export interface GameConfig {
    mode: Mode;
    bpm: number;
    beatsPerRound: number;
    rounds: number;
    timePerRound: number;
    grids: number[];
    showAttackNotes: boolean;
}

export interface DefendConfig {
    perfectWindow: number;
    matchWindow: number;
    pointsPerNote: number;
}

export interface AttackConfig {
    grid: number;
    perfectWindow: number;
    maxWindow: number;
    pointsPerNote: number;
}

export interface ChallengeAConfig {
    density: number;
    minNotes: number;
}

export interface ChallengeBConfig {
    minNotes: number;
    maxStrikes: number;
    scorePerStep: number;
    bpmStep: number;
    maxBpm: number;
}

export interface GameNumbers {
    tolerance: number;
    defend: DefendConfig;
    attack: AttackConfig;
    softCapKnee: number;
    softCapLimit: number;
    challengeA: ChallengeAConfig;
    challengeB: ChallengeBConfig;
    readyBars: number;
    truncateAtBarBoundary: boolean;
    quickStart: 'double' | 'single';
}

export interface Note {
    offset: number;
    acc?: number;
    early?: boolean;
}

export interface DefenderHit {
    offset: number;
}

export interface AnimationEffect {
    type: 'attack' | 'defend' | 'hit' | 'info';
    playerId?: string;
    score?: number;
    text?: string;
    color: string;
    time: number;
    x: number;
    y: number;
}

export interface GameState {
    phase: GamePhase;
    screen: ScreenName;
    currentRound: number;
    currentAttackerIdx: number;
    startTime: number;
    pausedTime: number;
    elapsed: number;
    timeLeft: number;
    barIndex: number;
    systemScheduledFor: number | null;
    strikes: number;
    prevRhythm: Record<string, number[]>;
    bpm: number;
    forcedEnd: boolean;
    beatCount: number;
    attackNotes: Note[];
    pendingAttack: Note[];
    defenderHits: Record<string, DefenderHit[]>;
    scorePending: boolean;
    scoreAt: number;
    ending: boolean;
    endingAtBar: number | null;
    scores: Record<string, number>;
    totalScores: Record<string, number>;
    animEffects: AnimationEffect[];
    resultTeamScore: number;
    resultBestScore: number;
    resultNewRecord: boolean;
}
