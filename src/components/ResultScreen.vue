<script setup lang="ts">
import { computed } from 'vue';
import type { GameState, Player } from '../types';

const props = defineProps<{
    visible: boolean;
    state: GameState;
    players: Player[];
    challengeB: boolean;
}>();

const emit = defineEmits<{
    (event: 'replay'): void;
    (event: 'settings'): void;
}>();

const sortedPlayers = computed(() => [...props.players].sort((a, b) =>
    (props.state.totalScores[b.id] || 0) - (props.state.totalScores[a.id] || 0)
));
</script>

<template>
    <div id="result-screen" class="screen" :class="visible ? 'active' : 'hidden'">
        <div class="pixel-container">
            <h1 class="pixel-title">GAME OVER</h1>
            <div id="results-list">
                <div v-if="challengeB" class="team-result">
                    <div class="team-score">TEAM {{ state.resultTeamScore }}</div>
                    <div class="team-best">{{ state.resultNewRecord ? 'NEW RECORD!' : `BEST ${state.resultBestScore}` }}</div>
                </div>
                <div v-for="(player, index) in sortedPlayers" :key="player.id" class="result-item">
                    <span class="rank">{{ index < 3 ? ['🥇', '🥈', '🥉'][index] : `#${index + 1}` }}</span>
                    <span class="name" :style="{ color: player.color }">{{ player.name }}</span>
                    <span class="score">{{ state.totalScores[player.id] || 0 }}</span>
                </div>
            </div>
            <button class="pixel-btn primary" @click="emit('replay')">REPLAY</button>
            <button class="pixel-btn" @click="emit('settings')">SETTINGS</button>
        </div>
    </div>
</template>
