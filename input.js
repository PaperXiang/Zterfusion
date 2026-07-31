/**
 * Rhythm Party - Input / Keybinding System
 */

const InputSystem = (function() {
    const KEY_DISPLAY_MAP = {
        'ArrowUp': '↑', 'ArrowDown': '↓', 'ArrowLeft': '←', 'ArrowRight': '→',
        'Space': 'SPACE', 'Enter': '↵', 'Shift': '⇧', 'Control': 'Ctrl',
        'Alt': 'Alt', 'Tab': 'Tab', 'Backspace': '⌫', 'Delete': 'Del',
        'Escape': 'ESC', 'PageUp': 'PgUp', 'PageDown': 'PgDn',
        'Home': 'Home', 'End': 'End', 'Insert': 'Ins',
        'CapsLock': 'Caps', 'NumLock': 'Num', 'ScrollLock': 'ScrLk',
    };

    const MOUSE_NAMES = ['LMB', 'MMB', 'RMB', 'MB4', 'MB5'];

    function getKeyDisplay(key, code) {
        if (code && code.indexOf('Mouse') === 0) {
            return MOUSE_NAMES[parseInt(code.slice(5))] || code;
        }
        if (KEY_DISPLAY_MAP[code]) return KEY_DISPLAY_MAP[code];
        if (key && key.length === 1) return key.toUpperCase();
        return code.replace(/^(Key|Digit|Numpad)/, '');
    }

    // ========== 按键绑定弹窗 ==========
    let bindingCallback = null;
    let capturedKeys = [];
    let isBinding = false;

    const modal = document.getElementById('keybind-modal');
    const display = document.getElementById('keybind-display');
    const nameEl = document.getElementById('keybind-player-name');

    function openBindModal(player, onComplete) {
        capturedKeys = []; // 从空白开始：按下第一个键即覆盖旧绑定
        bindingCallback = onComplete;
        isBinding = true;
        nameEl.textContent = `Player: ${player.name}`;
        updateBindDisplay();
        modal.classList.remove('hidden');
    }

    function closeBindModal(accept) {
        if (accept === false) return;
        modal.classList.add('hidden');
        isBinding = false;
        if (bindingCallback) {
            bindingCallback(capturedKeys);
            bindingCallback = null;
        }
    }

    function updateBindDisplay() {
        display.innerHTML = capturedKeys.length === 0
            ? '<span style="color:#666;font-size:10px;">Press keys...</span>'
            : capturedKeys.map(k => `<span class="key-tag">${getKeyDisplay(k.key, k.code)}</span>`).join('');
    }

    // ========== 事件监听 ==========
    let pressedKeys = new Set();

    function init() {
        document.addEventListener('keydown', onKeyDown, { capture: true });
        document.addEventListener('keyup', onKeyUp, { capture: true });
        document.addEventListener('mousedown', onMouseDown, { capture: true });
        document.addEventListener('mouseup', onMouseUp, { capture: true });
        // 吃掉鼠标默认行为：右键菜单、中键滚动/点击、侧键前进后退
        document.addEventListener('contextmenu', e => e.preventDefault());
        document.addEventListener('auxclick', e => e.preventDefault());
    }

    function onMouseDown(e) {
        const code = 'Mouse' + e.button;
        if (isBinding) {
            e.preventDefault();
            e.stopPropagation();
            if (pressedKeys.has(code)) return;
            pressedKeys.add(code);
            if (!capturedKeys.some(k => k.code === code)) {
                capturedKeys.push({ key: code, code });
                updateBindDisplay();
            }
            return;
        }
        pressedKeys.add(code);
        // 非左键的默认行为（中键自动滚动、侧键导航）始终禁用
        if (e.button !== 0) e.preventDefault();
    }

    function onMouseUp(e) {
        const code = 'Mouse' + e.button;
        pressedKeys.delete(code);
        if (isBinding) {
            e.preventDefault();
            e.stopPropagation();
        } else if (e.button !== 0) {
            e.preventDefault();
        }
    }

    function onKeyDown(e) {
        if (isBinding) {
            e.preventDefault();
            e.stopPropagation();
            if (e.code === 'Escape') { closeBindModal(true); return; }
            if (pressedKeys.has(e.code)) return;
            pressedKeys.add(e.code);
            if (!capturedKeys.some(k => k.code === e.code)) {
                capturedKeys.push({ key: e.key, code: e.code });
                updateBindDisplay();
            }
            return;
        }
        pressedKeys.add(e.code);
    }

    function onKeyUp(e) { pressedKeys.delete(e.code); }

    // ========== 公共接口 ==========
    function isKeyPressed(code) { return pressedKeys.has(code); }
    function isAnyKeyPressed(codes) { return codes.some(c => pressedKeys.has(c)); }
    function getPressedKeys() { return Array.from(pressedKeys); }
    function clearPressedKeys() { pressedKeys.clear(); }
    function hasConflict(keysA, keysB) {
        const codesA = new Set(keysA.map(k => k.code));
        return keysB.some(k => codesA.has(k.code));
    }
    function formatKeys(keys) {
        if (!keys || keys.length === 0) return 'None';
        return keys.map(k => getKeyDisplay(k.key, k.code)).join(' ');
    }

    return {
        init, openBindModal, isKeyPressed, isAnyKeyPressed,
        getPressedKeys, clearPressedKeys, hasConflict, formatKeys, getKeyDisplay
    };
})();
