<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { OnlineViewState } from '../network/OnlineClient';
import type { OnlineGameConfig } from '../shared/protocol';

const props = defineProps<{
    state: OnlineViewState;
    isOwner: boolean;
    localPlayerId: string;
}>();

const emit = defineEmits<{
    (event: 'create'): void;
    (event: 'join'): void;
    (event: 'leave'): void;
    (event: 'local'): void;
    (event: 'start'): void;
    (event: 'restart'): void;
    (event: 'pause'): void;
    (event: 'config', config: OnlineGameConfig): void;
    (event: 'canvas', canvas: HTMLCanvasElement): void;
}>();

const canvas = ref<HTMLCanvasElement | null>(null);
watch(canvas, value => { if (value) emit('canvas', value); });

const room = computed(() => props.state.room);
const attacker = computed(() => room.value?.game
    ? room.value.players[room.value.game.currentAttackerIdx]
    : null);
const phase = computed(() => {
    if (room.value?.status === 'countdown' || props.state.barIndex < 0) return 'READY';
    return props.state.barIndex % 2 === 0 ? 'ATTACK' : 'DEFEND';
});
const sortedPlayers = computed(() => [...(room.value?.players || [])].sort((a, b) => b.score - a.score));

function patchConfig(key: keyof OnlineGameConfig, value: unknown): void {
    if (!room.value || !props.isOwner) return;
    emit('config', { ...room.value.config, [key]: value });
}
</script>

<template>
    <div class="screen active online-screen" :class="{ 'online-game-screen': state.stage === 'game' }">
        <div v-if="state.stage === 'menu'" class="pixel-container online-panel">
            <h1 class="pixel-title">ONLINE</h1>
            <div class="connection-state" :class="{ offline: !state.connected }">
                {{ state.connected ? `CONNECTED · ${state.latencyMs}MS` : 'CONNECTING...' }}
            </div>
            <div class="config-section">
                <h2 class="pixel-subtitle">PLAYER</h2>
                <input v-model="state.name" class="online-input" maxlength="8" placeholder="NAME">
            </div>
            <button class="pixel-btn primary wide-btn" :disabled="state.busy || !state.connected" @click="emit('create')">
                CREATE ROOM
            </button>
            <div class="join-row">
                <input
                    v-model="state.roomCodeInput"
                    class="online-input room-code-input"
                    maxlength="6"
                    placeholder="ROOM CODE"
                    @input="state.roomCodeInput = state.roomCodeInput.toUpperCase()"
                    @keyup.enter="emit('join')"
                >
                <button class="pixel-btn" :disabled="state.busy || !state.connected" @click="emit('join')">JOIN</button>
            </div>
            <p v-if="state.error" class="online-error">{{ state.error }}</p>
            <button class="pixel-btn" @click="emit('local')">BACK TO LOCAL</button>
        </div>

        <div v-else-if="state.stage === 'lobby' && room" class="pixel-container online-panel">
            <h1 class="pixel-title">ROOM {{ room.code }}</h1>
            <p class="room-hint">SHARE THIS CODE · {{ state.latencyMs }}MS</p>
            <div class="online-player-list">
                <div v-for="player in room.players" :key="player.id" class="online-player-row">
                    <span class="player-color" :style="{ background: player.color }"></span>
                    <span :style="{ color: player.color }">{{ player.name }}</span>
                    <span v-if="player.id === room.ownerId" class="owner-badge">HOST</span>
                    <span v-if="player.id === localPlayerId" class="you-badge">YOU</span>
                    <span v-if="!player.connected" class="offline-badge">OFFLINE</span>
                </div>
            </div>
            <div class="config-section compact-settings">
                <h2 class="pixel-subtitle">CASUAL</h2>
                <div class="setting-row">
                    <label>BPM</label>
                    <input type="number" min="60" max="240" :value="room.config.bpm" :disabled="!isOwner"
                        @change="patchConfig('bpm', Number(($event.target as HTMLInputElement).value))">
                </div>
                <div class="setting-row">
                    <label>BEATS</label>
                    <input type="number" min="2" max="16" :value="room.config.beatsPerRound" :disabled="!isOwner"
                        @change="patchConfig('beatsPerRound', Number(($event.target as HTMLInputElement).value))">
                </div>
                <div class="setting-row">
                    <label>ROUNDS</label>
                    <input type="number" min="1" max="10" :value="room.config.rounds" :disabled="!isOwner"
                        @change="patchConfig('rounds', Number(($event.target as HTMLInputElement).value))">
                </div>
                <div class="setting-row">
                    <label>TIME</label>
                    <input type="number" min="10" max="120" :value="room.config.timePerRound" :disabled="!isOwner"
                        @change="patchConfig('timePerRound', Number(($event.target as HTMLInputElement).value))">
                </div>
            </div>
            <p v-if="state.error" class="online-error">{{ state.error }}</p>
            <button v-if="isOwner" class="pixel-btn primary" @click="emit('start')">START GAME</button>
            <p v-else class="room-hint">WAITING FOR HOST</p>
            <button class="pixel-btn danger" @click="emit('leave')">LEAVE ROOM</button>
        </div>

        <template v-else-if="state.stage === 'game' && room && room.game">
            <div class="game-header">
                <div class="round-info">
                    <span>Round: {{ room.game.currentRound + 1 }} / {{ room.config.rounds }}</span>
                    <span class="online-phase-display">{{ attacker?.name }} · {{ phase }}</span>
                    <span>{{ room.code }} · {{ state.latencyMs }}MS</span>
                    <span class="online-timer-display">{{ Math.ceil(state.timeLeft) }}s</span>
                </div>
            </div>
            <div class="rhythm-track-area">
                <canvas ref="canvas" id="online-rhythm-canvas"></canvas>
                <div class="beat-markers">
                    <span v-for="beat in room.config.beatsPerRound" :key="beat" class="beat-marker">{{ beat }}</span>
                </div>
            </div>
            <div class="players-area">
                <div
                    v-for="(player, index) in room.players"
                    :key="player.id"
                    class="game-player"
                    :class="index === room.game.currentAttackerIdx ? 'attacker' : 'defender'"
                >
                    <div class="role-badge">{{ index === room.game.currentAttackerIdx ? 'ATTACK' : 'DEFEND' }}</div>
                    <div class="player-avatar" :style="{ background: player.color }"></div>
                    <div class="player-name" :style="{ color: player.color }">{{ player.name }}</div>
                    <div class="player-keys">{{ player.id === localPlayerId ? 'ANY KEY' : 'REMOTE' }}</div>
                    <div class="player-score">{{ player.score }}</div>
                </div>
            </div>
            <div class="game-controls">
                <button v-if="isOwner" class="pixel-btn" @click="emit('pause')">
                    {{ room.status === 'paused' ? 'RESUME' : 'PAUSE' }}
                </button>
                <button class="pixel-btn danger" @click="emit('leave')">QUIT</button>
            </div>
            <div v-if="room.status === 'paused'" class="overlay">
                <div class="pixel-box">
                    <h2>PAUSED</h2>
                    <p>{{ isOwner ? 'PRESS ESC OR CLICK TO RESUME' : 'WAITING FOR HOST' }}</p>
                    <button v-if="isOwner" class="pixel-btn primary" @click="emit('pause')">RESUME</button>
                </div>
            </div>
        </template>

        <div v-else-if="state.stage === 'result' && room" class="pixel-container online-panel">
            <h1 class="pixel-title">GAME OVER</h1>
            <div id="results-list">
                <div v-for="(player, index) in sortedPlayers" :key="player.id" class="result-item">
                    <span class="rank">#{{ index + 1 }}</span>
                    <span class="name" :style="{ color: player.color }">{{ player.name }}</span>
                    <span class="score">{{ player.score }}</span>
                </div>
            </div>
            <button v-if="isOwner" class="pixel-btn primary" @click="emit('restart')">REPLAY</button>
            <p v-else class="room-hint">WAITING FOR HOST</p>
            <button class="pixel-btn" @click="emit('leave')">LEAVE ROOM</button>
        </div>
    </div>
</template>
