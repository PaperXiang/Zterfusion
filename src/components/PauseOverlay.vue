<script setup lang="ts">
defineProps<{ visible: boolean }>();
const emit = defineEmits<{ (event: 'resume'): void }>();
</script>

<template>
    <div class="overlay" :class="{ hidden: !visible }">
        <div class="pixel-box">
            <h2>PAUSED</h2>
            <p>Press <kbd>ESC</kbd> or click to resume</p>
            <button class="pixel-btn primary" @click="emit('resume')">RESUME</button>
        </div>
    </div>
</template>
