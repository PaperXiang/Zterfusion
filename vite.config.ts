import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

export default defineConfig({
    plugins: [vue()],
    server: {
        port: 8999,
        strictPort: true,
        proxy: {
            '/socket.io': {
                target: 'http://localhost:3000',
                ws: true
            }
        }
    },
    preview: {
        port: 8999,
        strictPort: true
    }
});
