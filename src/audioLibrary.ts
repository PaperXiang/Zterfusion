// Vite 不提供 Python http.server 那样的目录索引，因此保留一份构建时兜底清单。
// 如果开发服务器能返回目录索引，AudioEngine 会优先使用动态结果。
export const DEFAULT_LIBRARY_SOUNDS = [
    'airhorn.wav',
    'color-snare.wav',
    'haose-music.wav',
    'soyo1.wav',
    'soyo2.wav',
    'soyo3.wav',
    'soyo4.wav',
    'waao - 副本.wav',
    'waao.wav'
];
