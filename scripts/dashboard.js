import { ensureDashboard } from '../src/dashboard-launcher.js';
const info = await ensureDashboard(process.env.PI_SERVER_STATE_DIR);
console.log('Pi 调度台（仅本机）：' + info.url);
console.log('可实时查看会话、整理归档与配置脱敏画像，不会停止或接手正在运行的子代理。');
