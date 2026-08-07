<script setup lang="ts">
import type { KeyBinding } from '../types';

defineProps<{
    active: boolean;
    playerName: string;
    keys: KeyBinding[];
    formatKey: (key: string, code: string) => string;
}>();
</script>

<template>
    <div id="keybind-modal" class="modal" :class="{ hidden: !active }">
        <div class="modal-content pixel-box">
            <h3>KEY BINDING</h3>
            <p class="hint">Press keys to bind<br>Press <kbd>ESC</kbd> to finish</p>
            <div class="keybind-display">
                <span v-if="keys.length === 0" style="color:#666;font-size:10px;">Press keys...</span>
                <span v-for="key in keys" v-else :key="key.code" class="key-tag">{{ formatKey(key.key, key.code) }}</span>
            </div>
            <p class="player-name">Player: {{ playerName }}</p>
        </div>
    </div>
</template>
