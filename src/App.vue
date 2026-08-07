<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, watch } from 'vue';
import ConfigScreen from './components/ConfigScreen.vue';
import GameScreen from './components/GameScreen.vue';
import KeybindModal from './components/KeybindModal.vue';
import PauseOverlay from './components/PauseOverlay.vue';
import ResultScreen from './components/ResultScreen.vue';
import OnlineScreen from './components/OnlineScreen.vue';
import { AudioEngine } from './audio/AudioEngine';
import { GameEngine } from './game/GameEngine';
import { InputSystem } from './input/InputSystem';
import { OnlineClient } from './network/OnlineClient';
import type { KeyBinding, Mode, Player } from './types';

const audio = new AudioEngine();
const game = new GameEngine(audio);
const input = new InputSystem(game);
const online = new OnlineClient(audio);

const state = game.state;
const config = game.config;
const players = game.players;
const librarySounds = computed(() => game.librarySounds.value);

const visibleScreen = computed(() => state.screen);
const attackerName = computed(() => game.currentAttacker().name);
const phaseLabel = computed(() => {
    if (state.barIndex < 0) return 'READY';
    return state.barIndex % 2 === 0 ? 'ATTACK' : 'DEFEND';
});
const modeInfo = computed(() => game.isChallengeB()
    ? `TEAM ${game.teamTotal()} · ${game.effectiveBpm()}BPM · MISS ${state.strikes}/${game.numbers.challengeB.maxStrikes}`
    : '');

const formatKeys = (keys: KeyBinding[]) => input.formatKeys(keys);
const formatKey = (key: string, code: string) => input.getKeyDisplay(key, code);
const handleResize = () => game.resizeCanvas();
const handleOnlineResize = () => online.resizeCanvas();
const attachCanvas = (canvas: HTMLCanvasElement) => game.attachCanvas(canvas);
const attachOnlineCanvas = (canvas: HTMLCanvasElement) => online.attachCanvas(canvas);

function handleOnlineKey(event: KeyboardEvent): void {
    if (!online.state.active) return;
    if (online.handleKeyDown(event.code, event.repeat)) event.preventDefault();
}

watch(() => state.screen, async screen => {
    if (screen === 'game') {
        await nextTick();
        game.resizeCanvas();
    }
});

onMounted(() => {
    game.init();
    input.init();
    window.addEventListener('resize', handleResize);
    window.addEventListener('resize', handleOnlineResize);
    window.addEventListener('keydown', handleOnlineKey);
});

onBeforeUnmount(() => {
    window.removeEventListener('resize', handleResize);
    window.removeEventListener('resize', handleOnlineResize);
    window.removeEventListener('keydown', handleOnlineKey);
    input.destroy();
    online.destroy();
    game.quitGame();
});

function setMode(mode: Mode): void {
    game.setMode(mode);
}

function setNumber(
    key: 'bpm' | 'beatsPerRound' | 'rounds' | 'timePerRound',
    value: number
): void {
    game.setNumberSetting(key, value);
}

function setGrid(grid: number, checked: boolean): void {
    const grids = game.config.grids.filter(item => item !== grid);
    if (checked) grids.push(grid);
    game.setGrids(grids);
}

function setShowAttackNotes(value: boolean): void {
    game.setShowAttackNotes(value);
}

function applyPreset(preset: 'visual' | 'audio'): void {
    game.applyPreset(preset);
}

function addPlayer(): void {
    if (!game.addPlayer()) window.alert('Max 6 players!');
}

function bindPlayer(player: Player): void {
    input.openBindModal(player, (keys) => {
        if (!game.setPlayerKeys(player.id, keys)) window.alert('Key conflict! Please rebind.');
    });
}

function removePlayer(playerId: string): void {
    if (!game.removePlayer(playerId)) window.alert('Need at least 2 players!');
}

function setSound(playerId: string, soundName: string): void {
    void game.setPlayerSound(playerId, soundName).catch(error => {
        console.error('[Sound]', error);
        window.alert('Failed to load audio file!');
    });
}

function uploadSound(playerId: string, file: File): void {
    void game.uploadPlayerSound(playerId, file).catch(error => {
        console.error('[Sound]', error);
        window.alert('Failed to load audio file!');
    });
}

function setPlayerName(playerId: string, name: string): void {
    game.setPlayerName(playerId, name);
}

function setPlayerVolume(playerId: string, volumeDb: number): void {
    game.setPlayerVolume(playerId, volumeDb);
}

function resetSettings(): void {
    game.resetSettings();
}

function pauseGame(): void {
    game.pauseGame();
}

function resumeGame(): void {
    game.resumeGame();
}

function quitGame(): void {
    game.quitGame();
}

function showConfig(): void {
    game.showConfig();
}

function startGame(): void {
    if (game.startGame()) input.clearPressedKeys();
}

function enterOnline(): void {
    online.enter(players[0]?.name || 'PLAYER');
}
</script>

<template>
    <ConfigScreen
        :visible="visibleScreen === 'config' && !online.state.active"
        :config="config"
        :players="players"
        :library-sounds="librarySounds"
        :format-keys="formatKeys"
        @mode-change="setMode"
        @number-change="setNumber"
        @grid-change="setGrid"
        @show-notes-change="setShowAttackNotes"
        @preset="applyPreset"
        @add-player="addPlayer"
        @remove-player="removePlayer"
        @bind-player="bindPlayer"
        @name-change="setPlayerName"
        @sound-change="setSound"
        @upload-sound="uploadSound"
        @volume-change="setPlayerVolume"
        @start="startGame"
        @online="enterOnline"
        @reset="resetSettings"
    />

    <GameScreen
        :visible="visibleScreen === 'game'"
        :config="config"
        :state="state"
        :players="players"
        :attacker-name="attackerName"
        :phase-label="phaseLabel"
        :mode-info="modeInfo"
        :format-keys="formatKeys"
        @canvas-ready="attachCanvas"
        @pause="pauseGame"
        @quit="quitGame"
    />

    <ResultScreen
        :visible="visibleScreen === 'result'"
        :state="state"
        :players="players"
        :challenge-b="game.isChallengeB()"
        @replay="startGame"
        @settings="showConfig"
    />

    <KeybindModal
        :active="input.binding.active"
        :player-name="input.binding.playerName"
        :keys="input.binding.keys"
        :format-key="formatKey"
    />

    <PauseOverlay :visible="state.phase === 'paused'" @resume="resumeGame" />

    <OnlineScreen
        v-if="online.state.active"
        :state="online.state"
        :is-owner="online.isOwner()"
        :local-player-id="online.localPlayerId()"
        @create="online.createRoom()"
        @join="online.joinRoom()"
        @leave="online.leaveRoom()"
        @local="online.backToLocal()"
        @start="online.startGame()"
        @restart="online.restartGame()"
        @pause="online.togglePause()"
        @config="online.updateConfig($event)"
        @canvas="attachOnlineCanvas"
    />
</template>
