<script setup lang="ts">
import { onMounted, ref } from 'vue';
import type { GameConfig, GameState, KeyBinding, Player } from '../types';

const props = defineProps<{
    visible: boolean;
    config: GameConfig;
    state: GameState;
    players: Player[];
    attackerName: string;
    phaseLabel: string;
    modeInfo: string;
    formatKeys: (keys: KeyBinding[]) => string;
}>();

const emit = defineEmits<{
    (event: 'canvas-ready', canvas: HTMLCanvasElement): void;
    (event: 'pause'): void;
    (event: 'quit'): void;
}>();

const canvas = ref<HTMLCanvasElement | null>(null);
onMounted(() => {
    if (canvas.value) emit('canvas-ready', canvas.value);
});

function playerScore(player: Player): number {
    return (props.state.totalScores[player.id] || 0) + (props.state.scores[player.id] || 0);
}
</script>

<template>
    <div id="game-screen" class="screen" :class="visible ? 'active' : 'hidden'">
        <div class="game-header">
            <div class="round-info">
                <span>Round: {{ state.currentRound + 1 }} / {{ config.rounds }}</span>
                <span id="phase-display">{{ attackerName }} · {{ phaseLabel }}</span>
                <span id="mode-info-display">{{ modeInfo }}</span>
                <span id="timer-display">{{ state.ending ? 'LAST' : `${Math.ceil(state.timeLeft)}s` }}</span>
            </div>
        </div>
        <div class="rhythm-track-area">
            <canvas ref="canvas" id="rhythm-canvas"></canvas>
            <div class="beat-markers">
                <span v-for="beat in config.beatsPerRound" :key="beat" class="beat-marker">{{ beat }}</span>
            </div>
        </div>
        <div class="players-area">
            <div
                v-for="(player, index) in players"
                :id="`gp-${player.id}`"
                :key="player.id"
                class="game-player"
                :class="index === state.currentAttackerIdx ? 'attacker' : 'defender'"
            >
                <div class="role-badge">{{ index === state.currentAttackerIdx ? 'ATTACK' : 'DEFEND' }}</div>
                <div class="player-avatar" :style="{ background: player.color }"></div>
                <div class="player-name" :style="{ color: player.color }">{{ player.name }}</div>
                <div class="player-keys">{{ formatKeys(player.keys) }}</div>
                <div class="player-score">{{ playerScore(player) }}</div>
            </div>
        </div>
        <div class="game-controls">
            <button class="pixel-btn" @click="emit('pause')">PAUSE</button>
            <button class="pixel-btn" @click="emit('quit')">QUIT</button>
        </div>
    </div>
</template>
