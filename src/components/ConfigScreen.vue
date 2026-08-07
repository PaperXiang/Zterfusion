<script setup lang="ts">
import type { GameConfig, KeyBinding, Mode, Player } from '../types';

defineProps<{
    visible: boolean;
    config: GameConfig;
    players: Player[];
    librarySounds: string[];
    formatKeys: (keys: KeyBinding[]) => string;
}>();

const emit = defineEmits<{
    (event: 'mode-change', mode: Mode): void;
    (event: 'number-change', key: 'bpm' | 'beatsPerRound' | 'rounds' | 'timePerRound', value: number): void;
    (event: 'grid-change', grid: number, checked: boolean): void;
    (event: 'show-notes-change', value: boolean): void;
    (event: 'preset', preset: 'visual' | 'audio'): void;
    (event: 'add-player'): void;
    (event: 'remove-player', playerId: string): void;
    (event: 'bind-player', player: Player): void;
    (event: 'name-change', playerId: string, name: string): void;
    (event: 'sound-change', playerId: string, soundName: string): void;
    (event: 'upload-sound', playerId: string, file: File): void;
    (event: 'volume-change', playerId: string, volumeDb: number): void;
    (event: 'start'): void;
    (event: 'online'): void;
    (event: 'reset'): void;
}>();

function updateNumber(
    key: 'bpm' | 'beatsPerRound' | 'rounds' | 'timePerRound',
    event: Event
): void {
    emit('number-change', key, Number((event.target as HTMLInputElement).value));
}

function updateGrid(grid: number, event: Event): void {
    emit('grid-change', grid, (event.target as HTMLInputElement).checked);
}

function chooseSoundFile(playerId: string): void {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'audio/*';
    input.onchange = () => {
        const file = input.files?.[0];
        if (file) emit('upload-sound', playerId, file);
    };
    input.click();
}
</script>

<template>
    <div id="config-screen" class="screen" :class="visible ? 'active' : 'hidden'">
        <div class="pixel-container">
            <h1 class="pixel-title">ZTERFUSION</h1>

            <div class="config-section">
                <h2 class="pixel-subtitle">MODE</h2>
                <div class="mode-list">
                    <button
                        v-for="mode in ([
                            ['casual', 'CASUAL'],
                            ['challenge-a', 'CHALLENGE A'],
                            ['challenge-b', 'CHALLENGE B'],
                            ['challenge-c', 'C · SOON']
                        ] as [Mode, string][])"
                        :key="mode[0]"
                        class="mode-btn"
                        :class="{ selected: config.mode === mode[0] }"
                        :disabled="mode[0] === 'challenge-c'"
                        @click="emit('mode-change', mode[0])"
                    >{{ mode[1] }}</button>
                </div>
            </div>

            <div class="config-section">
                <h2 class="pixel-subtitle">PLAYERS</h2>
                <div id="players-list">
                    <div
                        v-for="player in players"
                        :key="player.id"
                        class="player-card"
                        @click="emit('bind-player', player)"
                    >
                        <div class="player-info">
                            <div class="player-color" :style="{ background: player.color }"></div>
                            <input
                                class="player-name-input"
                                :value="player.name"
                                maxlength="8"
                                @click.stop
                                @change="emit('name-change', player.id, ($event.target as HTMLInputElement).value)"
                            >
                        </div>
                        <div class="player-keys">{{ formatKeys(player.keys) }}</div>
                        <div class="player-sound" @click.stop>
                            <button class="sound-btn" title="Upload custom sound" @click="chooseSoundFile(player.id)">UPLOAD</button>
                            <select
                                class="sound-select"
                                :value="player.soundSource === 'library' ? player.soundName || '' : ''"
                                @change="emit('sound-change', player.id, ($event.target as HTMLSelectElement).value)"
                            >
                                <option value="">default</option>
                                <option v-for="sound in librarySounds" :key="sound" :value="sound">{{ sound }}</option>
                            </select>
                            <span class="sound-name">{{ player.soundSource === 'custom' ? player.soundName : '' }}</span>
                            <input
                                type="range"
                                class="vol-slider"
                                min="-24"
                                max="6"
                                step="1"
                                :value="player.volumeDb || 0"
                                :disabled="player.soundSource !== 'custom'"
                                @input="emit('volume-change', player.id, Number(($event.target as HTMLInputElement).value))"
                            >
                            <span class="vol-label">{{ player.volumeDb || 0 }}dB</span>
                        </div>
                        <button class="delete-btn" @click.stop="emit('remove-player', player.id)">X</button>
                    </div>
                </div>
                <button class="pixel-btn" @click="emit('add-player')">+ Add Player</button>
            </div>

            <div class="config-section">
                <h2 class="pixel-subtitle">SETTINGS</h2>
                <div class="setting-row">
                    <label>BPM</label>
                    <input type="number" :value="config.bpm" min="60" max="240" @change="updateNumber('bpm', $event)">
                </div>
                <div class="setting-row">
                    <label>Beats per round</label>
                    <input type="number" :value="config.beatsPerRound" min="2" max="16" @change="updateNumber('beatsPerRound', $event)">
                </div>
                <div class="setting-row">
                    <label>Rounds</label>
                    <input type="number" :value="config.rounds" min="1" max="10" @change="updateNumber('rounds', $event)">
                </div>
                <div class="setting-row">
                    <label>Time per round (s)</label>
                    <input type="number" :value="config.timePerRound" min="10" max="120" @change="updateNumber('timePerRound', $event)">
                </div>
                <div class="setting-row">
                    <label>Snap grid</label>
                    <div class="grid-checks">
                        <label v-for="grid in [8, 12, 16, 24]" :key="grid">
                            <input
                                type="checkbox"
                                :checked="config.grids.includes(grid)"
                                @change="updateGrid(grid, $event)"
                            > {{ grid }}th
                        </label>
                    </div>
                </div>
                <div class="setting-row">
                    <label>Show attack notes</label>
                    <div class="grid-checks">
                        <label><input type="checkbox" :checked="config.showAttackNotes" @change="emit('show-notes-change', ($event.target as HTMLInputElement).checked)"> ON</label>
                    </div>
                </div>
                <div class="setting-row">
                    <label>Presets</label>
                    <div class="preset-list">
                        <button class="pixel-btn preset-btn" @click="emit('preset', 'visual')">Visual Assist</button>
                        <button class="pixel-btn preset-btn" @click="emit('preset', 'audio')">Audio-First</button>
                    </div>
                </div>
            </div>

            <div class="config-actions">
                <button class="pixel-btn primary" @click="emit('start')">PLAY</button>
                <button class="pixel-btn" @click="emit('online')">ONLINE</button>
                <button class="pixel-btn danger" @click="emit('reset')">RESET</button>
            </div>
        </div>
    </div>
</template>
