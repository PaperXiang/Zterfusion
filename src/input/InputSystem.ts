import { reactive } from 'vue';
import type { KeyBinding, Player } from '../types';
import type { GameEngine } from '../game/GameEngine';

const KEY_DISPLAY_MAP: Record<string, string> = {
    ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→',
    Space: 'SPACE', Enter: '↵', Shift: '⇧', Control: 'Ctrl', Alt: 'Alt',
    Tab: 'Tab', Backspace: '⌫', Delete: 'Del', Escape: 'ESC', PageUp: 'PgUp',
    PageDown: 'PgDn', Home: 'Home', End: 'End', Insert: 'Ins', CapsLock: 'Caps',
    NumLock: 'Num', ScrollLock: 'ScrLk'
};

const MOUSE_NAMES = ['LMB', 'MMB', 'RMB', 'MB4', 'MB5'];

export interface BindingState {
    active: boolean;
    playerName: string;
    keys: KeyBinding[];
}

/** 统一处理键盘、鼠标和配置界面的按键绑定。 */
export class InputSystem {
    readonly binding = reactive<BindingState>({
        active: false,
        playerName: '',
        keys: []
    });

    private readonly pressedKeys = new Set<string>();
    private bindingCallback: ((keys: KeyBinding[]) => void) | null = null;
    private quickStartCode: string | null = null;
    private quickStartTime = 0;
    private initialized = false;

    constructor(private readonly game: GameEngine) {}

    init(): void {
        if (this.initialized) return;
        this.initialized = true;
        document.addEventListener('keydown', this.onKeyDown, { capture: true });
        document.addEventListener('keyup', this.onKeyUp, { capture: true });
        document.addEventListener('mousedown', this.onMouseDown, { capture: true });
        document.addEventListener('mouseup', this.onMouseUp, { capture: true });
        document.addEventListener('contextmenu', this.preventDefault);
        document.addEventListener('auxclick', this.preventDefault);
    }

    destroy(): void {
        if (!this.initialized) return;
        document.removeEventListener('keydown', this.onKeyDown, { capture: true });
        document.removeEventListener('keyup', this.onKeyUp, { capture: true });
        document.removeEventListener('mousedown', this.onMouseDown, { capture: true });
        document.removeEventListener('mouseup', this.onMouseUp, { capture: true });
        document.removeEventListener('contextmenu', this.preventDefault);
        document.removeEventListener('auxclick', this.preventDefault);
        this.initialized = false;
    }

    openBindModal(player: Player, onComplete: (keys: KeyBinding[]) => void): void {
        this.binding.active = true;
        this.binding.playerName = player.name;
        this.binding.keys = [];
        this.bindingCallback = onComplete;
    }

    private closeBindModal(): void {
        this.binding.active = false;
        const callback = this.bindingCallback;
        this.bindingCallback = null;
        callback?.(this.binding.keys.slice());
    }

    clearPressedKeys(): void {
        this.pressedKeys.clear();
    }

    getKeyDisplay(key: string, code: string): string {
        if (code.startsWith('Mouse')) return MOUSE_NAMES[parseInt(code.slice(5), 10)] || code;
        if (KEY_DISPLAY_MAP[code]) return KEY_DISPLAY_MAP[code];
        if (key && key.length === 1) return key.toUpperCase();
        return code.replace(/^(Key|Digit|Numpad)/, '');
    }

    formatKeys(keys: KeyBinding[]): string {
        if (!keys || keys.length === 0) return 'None';
        return keys.map(item => this.getKeyDisplay(item.key, item.code)).join(' ');
    }

    hasConflict(keysA: KeyBinding[], keysB: KeyBinding[]): boolean {
        const codesA = new Set(keysA.map(item => item.code));
        return keysB.some(item => codesA.has(item.code));
    }

    private isFormTarget(event: Event): boolean {
        const target = event.target as HTMLElement | null;
        return !!target && ['INPUT', 'SELECT', 'TEXTAREA'].includes(target.tagName);
    }

    private isUiControlTarget(event: Event): boolean {
        const target = event.target as HTMLElement | null;
        return !!target?.closest('button, input, select, textarea, a');
    }

    private preventDefault = (event: Event): void => event.preventDefault();

    private onKeyDown = (event: KeyboardEvent): void => {
        if (this.binding.active) {
            event.preventDefault();
            event.stopPropagation();
            if (event.code === 'Escape') {
                this.closeBindModal();
                return;
            }
            if (this.pressedKeys.has(event.code)) return;
            this.pressedKeys.add(event.code);
            if (!this.binding.keys.some(item => item.code === event.code)) {
                this.binding.keys.push({ key: event.key, code: event.code });
            }
            return;
        }

        if (this.isFormTarget(event)) return;
        // 浏览器会对按住的键持续派发 keydown。旧版用独立 Set 去重；迁移时遗漏后，
        // ESC 会在一次长按里反复暂停/恢复，玩家按键也会被当作高速连打。
        if (event.repeat || this.pressedKeys.has(event.code)) {
            if (event.code === 'Escape' || this.game.state.phase === 'playing') event.preventDefault();
            return;
        }
        this.pressedKeys.add(event.code);

        if (event.code === 'Escape') {
            if (this.game.state.phase === 'playing' || this.game.state.phase === 'paused') {
                event.preventDefault();
                this.game.togglePause();
            }
            return;
        }

        if (this.game.state.phase === 'playing') {
            const digit = event.code.match(/^(?:Numpad|Digit)(\d)$/);
            if (digit) this.game.onReadyDigit(parseInt(digit[1], 10));
            if (this.game.handleGameKey(event.code, performance.now())) event.preventDefault();
            return;
        }

        if (this.game.state.screen === 'config') {
            this.game.previewPlayerSound(event.code);
            this.handleQuickStart(event);
        }
    };

    private handleQuickStart(event: KeyboardEvent): void {
        if (event.code !== 'Enter' && event.code !== 'Space') return;
        event.preventDefault();
        if (this.game.numbers.quickStart === 'single') {
            this.game.startGame();
            return;
        }
        const now = performance.now();
        if (this.quickStartCode === event.code && now - this.quickStartTime < 400) {
            this.quickStartCode = null;
            this.game.startGame();
        } else {
            this.quickStartCode = event.code;
            this.quickStartTime = now;
        }
    }

    private onKeyUp = (event: KeyboardEvent): void => {
        this.pressedKeys.delete(event.code);
    };

    private onMouseDown = (event: MouseEvent): void => {
        const code = `Mouse${event.button}`;
        if (this.binding.active) {
            event.preventDefault();
            event.stopPropagation();
            if (this.pressedKeys.has(code)) return;
            this.pressedKeys.add(code);
            if (!this.binding.keys.some(item => item.code === code)) {
                this.binding.keys.push({ key: code, code });
            }
            return;
        }

        this.pressedKeys.add(code);
        if (event.button !== 0) event.preventDefault();
        // 点击 PAUSE/QUIT/配置控件时，鼠标键不能同时被当成玩家节奏输入。
        if (this.isUiControlTarget(event)) return;
        if (this.game.state.phase === 'playing') {
            if (this.game.handleGameKey(code, performance.now())) event.preventDefault();
        } else if (this.game.state.screen === 'config') {
            this.game.previewPlayerSound(code);
        }
    };

    private onMouseUp = (event: MouseEvent): void => {
        const code = `Mouse${event.button}`;
        this.pressedKeys.delete(code);
        if (this.binding.active) {
            event.preventDefault();
            event.stopPropagation();
        } else if (event.button !== 0) {
            event.preventDefault();
        }
    };
}
